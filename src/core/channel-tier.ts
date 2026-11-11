// 频道分级 + 源质量分级 + 输出前排编排
//
// 为什么单独一个模块：
//   以前「每台留 8 条源」是按数量截断，不看这 8 条里到底几条能播。
//   实测央视 45 台里有 17 台凑不出 4 条可播源，不少台是「1 条活 + 7 条死」
//   把 8 个位置塞满；电视端按 5 秒超时逐条试，等于白等 35 秒才黑屏。
//
// 这里把「保量」重新定义为：**保可播条数**，按频道档位给配额：
//   央视 > 卫视 > 重点地方台 > 其他
// 并且只把「本轮验证过的、延迟明显低于客户端 5 秒超时的、不同域名的」源放在前排。
//
// 纯函数，不碰存储，方便单测。

import type { ChannelSpeedEntry, ChannelSpeedMap } from './types';
import { bareUrl, hostOf } from './live-url';
import { tierOf, scoreOf } from './source-health';
import { CHANNEL_DEAD_FAILS } from './config';

export type ChannelTier = 'cctv' | 'satellite' | 'local' | 'other';

export const TIER_ORDER: ChannelTier[] = ['cctv', 'satellite', 'local', 'other'];

export const TIER_LABEL: Record<ChannelTier, string> = {
  cctv: '央视',
  satellite: '卫视',
  local: '地方台',
  other: '其他',
};

/**
 * 每档「保底可播源数」。
 *
 * 数字的来由：
 *   · 客户端 5 秒超时换源，8 条全死 ≈ 40 秒黑屏，用户直接判定「源坏了」；
 *   · 央视是打开电视必看的一组，必须有足够冗余（6 条）；
 *   · 卫视次之（5 条）；
 *   · 地方台数量太大、单台源本来就少，保 3 条即可，重点地方台另外加测；
 *   · 其他分组不承诺，保 2 条只用于排序。
 */
export const DEFAULT_TIER_QUOTA: Record<ChannelTier, number> = {
  cctv: 6,
  satellite: 5,
  local: 2,
  other: 2,
};

/** 深挖候选上限：前排不够时，允许从一个台的完整源池里再翻这么多条出来实测 */
export const TIER_CANDIDATE_LIMIT: Record<ChannelTier, number> = {
  cctv: 18,
  satellite: 14,
  local: 8,
  other: 0,
};

/** 「快」的硬线：客户端 5 秒超时，留一半余量，超过 2.5 秒开播就有风险 */
export const QUALITY_FAST_MS = 2500;
/** 「能看」的硬线：超过 4.5 秒基本必撞客户端超时 */
export const QUALITY_SLOW_MS = 4500;
/** 判定新鲜度：超过 6 小时（= 测速 TTL）的结论不算「本轮验证」 */
export const QUALITY_FRESH_MS = 6 * 60 * 60 * 1000;

export interface QualityInfo {
  /** 0 = 稳（分片验证 + 快 + 健康） 1 = 可用（验证过但偏慢/非 HLS） 2 = 未证实 3 = 死 */
  grade: 0 | 1 | 2 | 3;
  /** grade <= 1 才算「保底可播」 */
  verified: boolean;
  /** 给人看的原因：verified / slow / stale / unverified / shaky / dead / untested */
  reason: string;
}

export interface QualityOptions {
  /** 分片复验开启时，只看到清单的 m3u8 不算已验证 */
  requireSegment?: boolean;
  now?: number;
}

/**
 * 单条源的质量分级。
 *
 * 注意这里不看「历史上成功过多少次」来决定能不能播 —— 能不能播只由本轮探测结论决定；
 * 历史健康只用来在同等可播的源之间排先后（避免「测着快但总掉线」的源排第一）。
 */
export function gradeOf(
  entry: ChannelSpeedEntry | undefined,
  opts: QualityOptions = {},
): QualityInfo {
  const now = opts.now ?? Date.now();
  const requireSegment = opts.requireSegment !== false;

  if (!entry) return { grade: 2, verified: false, reason: 'untested' };
  if (entry.kind === 'fail') {
    // 一次失败可能只是抖动，先降级留观；连续失败到阈值才彻底不输出，
    // 否则「输出前复核」偶发一次超时就会把好源永久踢出前排。
    const fails = entry.consecutiveFails ?? entry.fails ?? 1;
    return fails >= CHANNEL_DEAD_FAILS
      ? { grade: 3, verified: false, reason: 'dead' }
      : { grade: 2, verified: false, reason: 'failed-once' };
  }

  const t = Date.parse(entry.probedAt);
  if (!isFinite(t) || now - t > QUALITY_FRESH_MS) {
    return { grade: 2, verified: false, reason: 'stale' };
  }

  // 连续掉线的源（tier 2）不该占着前排：电视端黑屏几十秒，比慢 300ms 难受得多
  if (tierOf(entry) === 2) return { grade: 2, verified: false, reason: 'shaky' };

  if (!(entry.speedMs > 0)) return { grade: 2, verified: false, reason: 'unknown-speed' };

  const segmentVerified = entry.stage === 'segment';
  if (requireSegment && entry.kind === 'm3u8' && !segmentVerified) {
    // 只拿到清单、没验分片：历史上这类源 23% 播不出来，不能算保底
    return { grade: 2, verified: false, reason: 'unverified' };
  }

  if (entry.speedMs > QUALITY_SLOW_MS) {
    return { grade: 2, verified: false, reason: 'slow' };
  }
  if (segmentVerified && entry.speedMs <= QUALITY_FAST_MS) {
    return { grade: 0, verified: true, reason: 'verified' };
  }
  return { grade: 1, verified: true, reason: segmentVerified ? 'ok' : 'ok-non-hls' };
}

export interface ArrangeOptions extends QualityOptions {
  /** 保底可播条数 */
  quota: number;
  /** 输出上限（每台最多几条源） */
  cap: number;
}

export interface ArrangeResult {
  /** 编排后的 URL（保留 `$源名`） */
  urls: string[];
  /** 前排可播条数（grade<=1） */
  verified: number;
  /** 前排用到的不同域名数 */
  distinctHosts: number;
  /** 距离配额还差几条 */
  gap: number;
  /** 被剔除的死链条数（grade=3，不再占客户端超时） */
  droppedDead: number;
}

interface Item {
  raw: string;
  bare: string;
  host: string;
  index: number;
  quality: QualityInfo;
  entry?: ChannelSpeedEntry;
}

function compareQuality(a: Item, b: Item): number {
  if (a.quality.grade !== b.quality.grade) return a.quality.grade - b.quality.grade;
  const sa = scoreOf(a.entry);
  const sb = scoreOf(b.entry);
  if (Math.abs(sa - sb) >= 0.12) return sb - sa;
  const ma = a.entry?.speedMs ?? Number.MAX_SAFE_INTEGER;
  const mb = b.entry?.speedMs ?? Number.MAX_SAFE_INTEGER;
  if (ma !== mb) return ma - mb;
  return a.index - b.index;
}

/**
 * 输出前编排一个频道的源。
 *
 * 目标不是「最快」，而是「电视端按顺序试，5 秒内大概率能出画面」：
 *   1. 死链（grade 3）直接不输出——它只会消耗客户端的一次 5 秒超时；
 *   2. 前排 quota 条尽量来自不同域名，避免一个 IP 抖动连挂多次；
 *   3. 剩余位置优先给已验证源，其次给「未证实」的候选，最后才是慢源；
 *   4. 不足配额时返回 gap，由上层决定是否继续深挖补测。
 */
export function arrangeSources(
  urls: string[],
  speedMap: ChannelSpeedMap | undefined,
  opts: ArrangeOptions,
): ArrangeResult {
  const quota = Math.max(0, Math.floor(opts.quota));
  const cap = Math.max(1, Math.floor(opts.cap));
  const items: Item[] = [];
  const seenBare = new Set<string>();

  urls.forEach((raw, index) => {
    const bare = bareUrl(raw);
    if (!bare || seenBare.has(bare)) return;
    seenBare.add(bare);
    items.push({
      raw,
      bare,
      host: hostOf(bare),
      index,
      entry: speedMap?.[bare],
      quality: gradeOf(speedMap?.[bare], opts),
    });
  });

  // 输出里不放任何「探测失败」的条目：哪怕只失败一次，对客户端也是一次 5 秒超时。
  // 「单次失败留观」只用于候选排序与缺口统计，不用于最终输出。
  const droppedDead = items.filter((x) => x.entry?.kind === 'fail' || x.quality.grade === 3).length;
  const alive = items.filter((x) => x.entry?.kind !== 'fail').sort(compareQuality);
  const verifiedItems = alive.filter((x) => x.quality.verified);

  // 第一轮：可播 + 同域名只取一条
  const head: Item[] = [];
  const usedHosts = new Set<string>();
  for (const it of verifiedItems) {
    if (head.length >= quota) break;
    if (it.host && usedHosts.has(it.host)) continue;
    head.push(it);
    if (it.host) usedHosts.add(it.host);
  }
  // 第二轮：可播但域名撞车，也要把配额补满 —— 总比留空位让客户端少试一条强
  if (head.length < quota) {
    for (const it of verifiedItems) {
      if (head.length >= quota) break;
      if (head.includes(it)) continue;
      head.push(it);
      if (it.host) usedHosts.add(it.host);
    }
  }

  const headSet = new Set(head.map((x) => x.raw));
  const rest = alive.filter((x) => !headSet.has(x.raw));
  const out = [...head, ...rest].slice(0, cap);

  return {
    urls: out.map((x) => x.raw),
    verified: head.length,
    distinctHosts: usedHosts.size,
    gap: Math.max(0, quota - head.length),
    droppedDead,
  };
}

export interface TierQuotaMap extends Record<ChannelTier, number> {}

export interface TierCoverage {
  tier: ChannelTier;
  channels: number;
  /** 达到配额的频道数 */
  met: number;
  /** 缺口频道数 */
  short: number;
  /** 所有频道当前可播条数之和 */
  verified: number;
  /** 所有频道配额之和 */
  quota: number;
}

export interface QualityGap {
  group: string;
  name: string;
  tier: ChannelTier;
  verified: number;
  quota: number;
  pool: number;
  hosts: number;
  /** 可播源数 / 源池，用于排序「最该补源的台」 */
  rate: number;
}

/** 汇总各档达标情况（后台概览 + 日志用） */
export function tierCoverage(
  rows: Array<{ tier: ChannelTier; verified: number }>,
  quotas: TierQuotaMap = DEFAULT_TIER_QUOTA,
): TierCoverage[] {
  return TIER_ORDER.map((tier) => {
    const list = rows.filter((r) => r.tier === tier);
    const quota = quotas[tier] ?? 0;
    return {
      tier,
      channels: list.length,
      met: list.filter((r) => r.verified >= quota).length,
      short: list.filter((r) => r.verified < quota).length,
      verified: list.reduce((n, r) => n + r.verified, 0),
      quota: list.length * quota,
    };
  });
}

/**
 * 缺口报表：只列「没达到配额」的台，按档位优先级 + 可播率升序。
 * 这是「补源」的替代品 —— 不盲目给所有单源台塞源，只告诉人哪几个必看的台缺源。
 */
export function buildGapReport(
  rows: Array<{
    group: string;
    name: string;
    tier: ChannelTier;
    verified: number;
    quota: number;
    pool: number;
    hosts: number;
  }>,
  limit = 200,
): QualityGap[] {
  const tierRank = new Map(TIER_ORDER.map((t, i) => [t, i]));
  return rows
    .filter((r) => {
      if (r.tier === 'other' || r.verified >= r.quota) return false;
      // 地方台里「本来就只有 1 条源」的台不列缺口：这不是质量问题，是覆盖问题。
      // 用户明确说过不为这类台盲目补源；这里只报「有候选但都播不了」的台。
      if (r.tier === 'local' && r.pool < 2) return false;
      return true;
    })
    .map((r) => ({ ...r, rate: r.pool > 0 ? r.verified / r.pool : 0 }))
    .sort((a, b) => {
      const ta = tierRank.get(a.tier) ?? 9;
      const tb = tierRank.get(b.tier) ?? 9;
      if (ta !== tb) return ta - tb;
      if (a.verified !== b.verified) return a.verified - b.verified; // 最缺的排前面
      return a.rate - b.rate;
    })
    .slice(0, limit);
}
