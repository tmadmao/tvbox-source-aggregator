// 分级源质量保障（替代「单源频道补源」）
//
// 目标不是给所有台硬塞源，而是把「打开电视一定会看」的那几十个台先保到能播：
//   央视 > 卫视 > 重点地方台（南京 + 江苏）
//
// 做三件事：
//   1. 按档位配额重排每个重点台的源：死链不占位置、前排尽量不同域名、只放验证过的源；
//   2. 前排不够配额时，从**完整源池**里继续翻候选（输出只留 8 条，池子往往还有几十条），
//      实测补测，直到凑够配额或候选/预算用完；
//   3. 仍然凑不够的台记进缺口报表 —— 这才是真正需要「补源」的台，而不是 78% 的单源小台。
//
// 为什么不放在测速阶段：测速是全量、无差别、按 TTL 回测；这里只对几十个重点台做
// 「输出前最后的实测定稿」，两者预算与目标都不同。

import type { ChannelSpeedMap, TVBoxLiveGroup } from './types';
import { bareUrl } from './live-url';
import { probeUrlOnce } from './channel-probe';
import { recordProbe } from './source-health';
import {
  arrangeSources,
  gradeOf,
  buildGapReport,
  tierCoverage,
  TIER_CANDIDATE_LIMIT,
  TIER_ORDER,
  type ArrangeResult,
  type ChannelTier,
  type QualityGap,
  type TierCoverage,
} from './channel-tier';
import {
  tierOfChannel,
  isPriorityLocal,
  TIER_RANK,
  type CurationRules,
} from './channel-curation';
import { CHANNEL_PROBE_RULE_VERSION, QUALITY_GUARANTEE_BUDGET_MS } from './config';

export interface GuaranteeOptions {
  rules: CurationRules;
  /** 分片复验开启时，只看到清单的 m3u8 不算已验证 */
  requireSegment?: boolean;
  /** 整轮补测预算 */
  budgetMs?: number;
  /** 并发频道数（每个频道串行试源，避免把单 IP 打崩） */
  concurrency?: number;
  now?: number;
}

export interface GuaranteeTierStats {
  tier: ChannelTier;
  channels: number;
  metBefore: number;
  metAfter: number;
  verifiedBefore: number;
  verifiedAfter: number;
  probed: number;
}

export interface GuaranteeStats {
  channels: number;
  probed: number;
  /** 补测后新达到配额的频道数 */
  fixed: number;
  gapBefore: number;
  gapAfter: number;
  byTier: GuaranteeTierStats[];
  elapsedMs: number;
  budgetExhausted: boolean;
}

export interface GuaranteeResult {
  stats: GuaranteeStats;
  gaps: QualityGap[];
  coverage: TierCoverage[];
}

const PROBE_HARD_TIMEOUT_MS = 12000;

async function raceTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); });
  try {
    return await Promise.race([p, guard]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface ChannelTask {
  group: TVBoxLiveGroup;
  channelIndex: number;
  name: string;
  tier: ChannelTier;
  quota: number;
  pool: number;
  /** 编排前的完整源池（输出只留 8 条，补测要从整池里找） */
  poolUrls: string[];
  before: ArrangeResult;
  after?: ArrangeResult;
  probed: number;
}

/** 该频道是否属于「要保」的范围：央视 / 卫视 / 重点地方台 */
function shouldGuarantee(tier: ChannelTier, name: string, rules: CurationRules): boolean {
  if (tier === 'cctv' || tier === 'satellite') return true;
  if (tier === 'local') return isPriorityLocal(name, rules);
  return false;
}

/**
 * 候选排序：先补「曾经活着、只是结论过期」的，再补「清单能拿但没验分片」的，
 * 最后才试「从没测过」的。慢源排在有历史成功记录的源之后。
 */
function candidateRank(url: string, speedMap: ChannelSpeedMap, requireSegment: boolean, now: number): number {
  const q = gradeOf(speedMap[url], { requireSegment, now });
  if (q.grade === 3) return 99;       // 已判死，不再浪费一次 5 秒超时
  if (q.grade <= 1) return 98;        // 已是可播，候选里不需要
  switch (q.reason) {
    case 'stale': return 0;
    case 'unverified': return 1;
    case 'slow': return 2;
    case 'shaky': return 3;
    default: return 4;                // untested / unknown-speed
  }
}

export async function runQualityGuarantee(
  groups: TVBoxLiveGroup[],
  speedMap: ChannelSpeedMap,
  opts: GuaranteeOptions,
): Promise<GuaranteeResult> {
  const rules = opts.rules;
  const requireSegment = opts.requireSegment !== false;
  const budgetMs = Math.max(10_000, opts.budgetMs ?? QUALITY_GUARANTEE_BUDGET_MS);
  const concurrency = Math.max(1, opts.concurrency ?? 6);
  const now = opts.now ?? Date.now();
  const started = Date.now();
  const deadline = started + budgetMs;

  const tasks: ChannelTask[] = [];

  // 第一遍：所有重点台先按质量重排（不花请求），顺手统计缺口
  for (const group of groups) {
    if (!Array.isArray(group.channels)) continue;
    group.channels.forEach((ch, idx) => {
      const tier = tierOfChannel(group.group || '', ch.name, rules);
      if (!shouldGuarantee(tier, ch.name, rules)) return;
      const quota = rules.quotas[tier] ?? 0;
      if (quota <= 0) return;
      const poolUrls = [...(ch.urls || [])];
      const before = arrangeSources(poolUrls, speedMap, {
        quota,
        cap: rules.focusSources,
        requireSegment,
        now,
      });
      // 无论有没有缺口，都先应用「去掉死链 + 前排域名去相关」的结果
      ch.urls = before.urls;
      tasks.push({
        group,
        channelIndex: idx,
        name: ch.name,
        tier,
        quota,
        pool: poolUrls.length,
        poolUrls,
        before,
        probed: 0,
      });
    });
  }

  const metBefore = (t: ChannelTask): boolean => t.before.verified >= t.quota;
  const pending = tasks
    .filter((t) => !metBefore(t))
    .sort((a, b) => {
      const ta = TIER_RANK.get(a.tier) ?? 9;
      const tb = TIER_RANK.get(b.tier) ?? 9;
      if (ta !== tb) return ta - tb;                 // 央视 → 卫视 → 地方
      if (a.before.verified !== b.before.verified) return a.before.verified - b.before.verified;
      return a.before.gap - b.before.gap;
    });

  let probed = 0;
  let budgetExhausted = false;

  async function runTask(task: ChannelTask): Promise<void> {
    if (Date.now() > deadline) { budgetExhausted = true; return; }
    const ch = task.group.channels[task.channelIndex];
    const limit = TIER_CANDIDATE_LIMIT[task.tier] ?? 0;

    // 候选来自「完整源池」，不是输出里那 8 条：很多台输出 8 条、池子里还有几十条
    const seen = new Set<string>();
    const candidates: Array<{ raw: string; bare: string; rank: number }> = [];
    for (const raw of task.poolUrls) {
      const bare = bareUrl(raw);
      if (!bare || seen.has(bare)) continue;
      seen.add(bare);
      const rank = candidateRank(bare, speedMap, requireSegment, now);
      if (rank >= 98) continue;         // 已可播 / 已判死
      candidates.push({ raw, bare, rank });
    }
    candidates.sort((a, b) => a.rank - b.rank);

    let verified = arrangeSources(task.poolUrls, speedMap, {
      quota: task.quota,
      cap: rules.focusSources,
      requireSegment,
      now,
    }).verified;

    const budgetForChannel = Math.min(limit, candidates.length);
    for (let i = 0; i < budgetForChannel && verified < task.quota; i++) {
      if (Date.now() > deadline) { budgetExhausted = true; break; }
      const cand = candidates[i];
      const r = await raceTimeout(probeUrlOnce(cand.bare), PROBE_HARD_TIMEOUT_MS);
      task.probed++;
      probed++;
      if (!r) continue;                   // 硬超时：不写结论，留待下一轮
      const entry = recordProbe(speedMap, cand.bare, r);
      entry.ruleVer = CHANNEL_PROBE_RULE_VERSION;
      entry.samples = 1;
      const q = gradeOf(entry, { requireSegment, now: Date.now() });
      if (q.verified) verified++;
    }

    const after = arrangeSources(task.poolUrls, speedMap, {
      quota: task.quota,
      cap: rules.focusSources,
      requireSegment,
      now: Date.now(),
    });
    ch.urls = after.urls;
    task.after = after;
  }

  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < pending.length) {
      if (Date.now() > deadline) { budgetExhausted = true; return; }
      const task = pending[cursor++];
      try {
        await runTask(task);
      } catch (err) {
        console.warn(`[quality] ${task.name} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, () => worker()));

  // 汇总
  const rows = tasks.map((t) => {
    const final = t.after ?? t.before;
    return {
      group: t.group.group || '其他',
      name: t.name,
      tier: t.tier,
      verified: final.verified,
      quota: t.quota,
      pool: t.pool,
      hosts: final.distinctHosts,
    };
  });

  const coverage = tierCoverage(rows, rules.quotas);
  const byTier: GuaranteeTierStats[] = TIER_ORDER.map((tier) => {
    const list = tasks.filter((t) => t.tier === tier);
    const quota = rules.quotas[tier] ?? 0;
    return {
      tier,
      channels: list.length,
      metBefore: list.filter((t) => t.before.verified >= quota).length,
      metAfter: list.filter((t) => (t.after ?? t.before).verified >= quota).length,
      verifiedBefore: list.reduce((n, t) => n + t.before.verified, 0),
      verifiedAfter: list.reduce((n, t) => n + (t.after ?? t.before).verified, 0),
      probed: list.reduce((n, t) => n + t.probed, 0),
    };
  });

  const gaps = buildGapReport(rows);

  const stats: GuaranteeStats = {
    channels: tasks.length,
    probed,
    fixed: byTier.reduce((n, t) => n + Math.max(0, t.metAfter - t.metBefore), 0),
    gapBefore: tasks.reduce((n, t) => n + Math.max(0, t.quota - t.before.verified), 0),
    gapAfter: tasks.reduce((n, t) => n + Math.max(0, t.quota - (t.after ?? t.before).verified), 0),
    byTier,
    elapsedMs: Date.now() - started,
    budgetExhausted,
  };

  return { stats, gaps, coverage };
}
