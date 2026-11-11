// 源质量守夜（全自动维护）
//
// 解决的问题：白天的源会死，但下一次全量聚合要等到凌晨 5 点。
// 中间的十几个小时里，重点台的第一条源可能早就挂了，电视端只能一条条试超时。
//
// 守夜每小时跑一次，只做三件事：
//   1. 重点台（央视/卫视/重点地方台）的头部源超过 3 小时没验、或有缺口 → 立刻重验；
//   2. 缺口从「完整源池」补，池子也不够就重新下载直播源列表找新地址；
//   3. 有改善才发布（本地 KV + FTP），质量只升不降；连续 3 轮补不上才告警。
//
// 不需要人点任何按钮：默认开启，失败/漏跑都进执行历史。

import type { Storage } from '../storage/interface';
import type { ChannelSpeedMap, TVBoxLiveGroup } from './types';
import { bareUrl } from './live-url';
import { gradeOf, arrangeSources, TIER_CANDIDATE_LIMIT, type ChannelTier } from './channel-tier';
import {
  tierOfChannel,
  isPriorityLocal,
  canonicalChannelName,
  loadCurationRules,
  type CurationRules,
} from './channel-curation';
import { probeUrlOnce, loadSpeedMap, saveSpeedMap } from './channel-probe';
import { recordProbe } from './source-health';
import { fetchAndParseLiveUrls } from './live-merger';
import { loadFtpConfig, uploadLiveTxt } from './ftp-sync';
import { formatLiveGroupsAsTxt } from './live-merger';
import { loadAlertConfig, sendAlert } from './alerts';
import {
  KV_MERGED_CONFIG,
  KV_CHANNEL_MERGED_TREE,
  KV_LIVE_GUARD_REPORT,
  KV_LIVE_GUARD_STATE,
  KV_LIVE_SOURCES,
  CHANNEL_PROBE_RULE_VERSION,
  GUARD_STALE_MS,
  GUARD_BUDGET_MS,
  GUARD_CONCURRENCY,
  GUARD_ALERT_AFTER,
} from './config';

export interface GuardOptions {
  budgetMs?: number;
  concurrency?: number;
  staleMs?: number;
  /** 源池不够时是否重新下载直播源列表找新地址 */
  refreshSources?: boolean;
  now?: number;
}

export interface GuardGap {
  group: string;
  name: string;
  tier: ChannelTier;
  verified: number;
  quota: number;
}

export interface GuardResult {
  state: 'done' | 'noop' | 'skipped' | 'partial';
  checked: number;
  probed: number;
  repaired: number;
  changed: number;
  addedUrls: number;
  gaps: GuardGap[];
  published: boolean;
  elapsedMs: number;
  note?: string;
}

const PROBE_HARD_TIMEOUT_MS = 12000;
let running = false;

export function isGuardRunning(): boolean {
  return running;
}

async function raceTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); });
  try {
    return await Promise.race([p, guard]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function uniqueBare(urls: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of urls) {
    const b = bareUrl(raw);
    if (!b || seen.has(b)) continue;
    seen.add(b);
    out.push(raw);
  }
  return out;
}

function rankCandidate(url: string, speedMap: ChannelSpeedMap, requireSegment: boolean, now: number): number {
  const e = speedMap[url];
  const q = gradeOf(e, { requireSegment, now });
  if (q.verified) return 98;
  if (e?.kind === 'fail') return 99;
  switch (q.reason) {
    case 'stale': return 0;
    case 'unverified': return 1;
    case 'slow': return 2;
    case 'shaky': return 3;
    default: return 4;
  }
}

/** 头部源里「需要立刻重验」的那些：没测过、死了、或结论超过 3 小时 */
function staleHeadsOf(urls: string[], speedMap: ChannelSpeedMap, quota: number, now: number, staleMs: number): string[] {
  const head = urls.slice(0, Math.max(1, Math.min(2, quota)));
  return head
    .map(bareUrl)
    .filter((u) => {
      const e = speedMap[u];
      if (!e || e.kind === 'fail') return true;
      const t = Date.parse(e.probedAt);
      return !isFinite(t) || now - t > staleMs;
    });
}

interface Task {
  group: TVBoxLiveGroup;
  index: number;
  name: string;
  tier: ChannelTier;
  quota: number;
  outputUrls: string[];
  pool: string[];
  beforeVerified: number;
  afterVerified: number;
  mustProbe: string[];
  urls: string[];
  probed: number;
  added: number;
}

/** 从完整源池按正式名建索引（输出频道名与源池写法可能不一样） */
function buildPoolMap(tree: TVBoxLiveGroup[], rules: CurationRules): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const g of tree) {
    for (const ch of g.channels || []) {
      const key = canonicalChannelName(ch.name, rules).toUpperCase();
      if (!key) continue;
      const list = out.get(key) || [];
      list.push(...(ch.urls || []));
      out.set(key, list);
    }
  }
  return out;
}

async function loadLiveSourceInputs(storage: Storage): Promise<Array<{ name: string; url: string }>> {
  const raw = await storage.get(KV_LIVE_SOURCES);
  if (!raw) return [];
  try {
    const list = JSON.parse(raw) as Array<{ name?: string; url?: string }>;
    return list
      .filter((x) => x && typeof x.url === 'string' && /^https?:\/\//i.test(x.url))
      .map((x, i) => ({ name: x.name || `source${i}`, url: x.url! }));
  } catch {
    return [];
  }
}

export async function runQualityGuard(storage: Storage, opts: GuardOptions = {}): Promise<GuardResult> {
  const started = Date.now();
  const now = opts.now ?? started;

  if (running) {
    return { state: 'skipped', checked: 0, probed: 0, repaired: 0, changed: 0, addedUrls: 0, gaps: [], published: false, elapsedMs: 0, note: 'already-running' };
  }

  const rawCfg = await storage.get(KV_MERGED_CONFIG);
  if (!rawCfg) {
    return { state: 'skipped', checked: 0, probed: 0, repaired: 0, changed: 0, addedUrls: 0, gaps: [], published: false, elapsedMs: Date.now() - started, note: 'no-config' };
  }

  let full: { lives?: TVBoxLiveGroup[] } & Record<string, unknown>;
  try {
    full = JSON.parse(rawCfg);
  } catch {
    return { state: 'skipped', checked: 0, probed: 0, repaired: 0, changed: 0, addedUrls: 0, gaps: [], published: false, elapsedMs: Date.now() - started, note: 'bad-config' };
  }

  const lives = Array.isArray(full.lives) ? full.lives : [];
  if (lives.length === 0) {
    return { state: 'noop', checked: 0, probed: 0, repaired: 0, changed: 0, addedUrls: 0, gaps: [], published: false, elapsedMs: Date.now() - started };
  }

  const rules = await loadCurationRules(storage);
  const requireSegment = (await storage.get('channel_probe_segment')) !== 'false';
  const map = await loadSpeedMap(storage);
  const staleMs = Math.max(30 * 60 * 1000, opts.staleMs ?? GUARD_STALE_MS);
  const budgetMs = Math.max(60_000, opts.budgetMs ?? GUARD_BUDGET_MS);
  const concurrency = Math.max(1, opts.concurrency ?? GUARD_CONCURRENCY);
  const refreshSources = opts.refreshSources !== false;
  const deadline = started + budgetMs;

  let tree: TVBoxLiveGroup[] = [];
  try {
    const rawTree = await storage.get(KV_CHANNEL_MERGED_TREE);
    if (rawTree) tree = JSON.parse(rawTree);
  } catch { /* ignore */ }
  const poolMap = buildPoolMap(tree, rules);

  const tasks: Task[] = [];
  const collect = (withPool: boolean) => {
    for (const group of lives) {
      (group.channels || []).forEach((ch, index) => {
        const tier = tierOfChannel(group.group || '', ch.name, rules);
        if (tier === 'other') return;
        const key = canonicalChannelName(ch.name, rules).toUpperCase();
        const pool = withPool ? (poolMap.get(key) || []) : [];
        const all = uniqueBare([...(ch.urls || []), ...pool]);
        if (tier === 'local') {
          if (!isPriorityLocal(ch.name, rules)) return;
          if (all.length < 2) return;            // 单源地方台不追，避免无效重试
        }
        const quota = rules.quotas[tier] ?? 0;
        if (quota <= 0) return;
        const before = arrangeSources(ch.urls || [], map, {
          quota, cap: rules.focusSources, requireSegment, now,
        });
        const mustProbe = staleHeadsOf(ch.urls || [], map, quota, now, staleMs);
        if (before.gap === 0 && mustProbe.length === 0) return;
        tasks.push({
          group, index, name: ch.name, tier, quota,
          outputUrls: [...(ch.urls || [])],
          pool,
          beforeVerified: before.verified,
          afterVerified: before.verified,
          mustProbe,
          urls: all,
          probed: 0,
          added: 0,
        });
      });
    }
  };

  collect(true);

  let probed = 0;
  let repaired = 0;
  let addedUrls = 0;
  let partial = false;

  const probeOne = async (task: Task, url: string): Promise<void> => {
    const r = await raceTimeout(probeUrlOnce(url), PROBE_HARD_TIMEOUT_MS);
    task.probed++;
    probed++;
    if (!r) return;                         // 硬超时：不写结论，下一轮再来
    const entry = recordProbe(map, url, r);
    entry.ruleVer = CHANNEL_PROBE_RULE_VERSION;
    entry.samples = 1;
  };

  const probeInto = async (task: Task, candidates: string[]): Promise<number> => {
    const limit = TIER_CANDIDATE_LIMIT[task.tier] ?? 0;
    const done = new Set<string>();

    // 先把「头部过期/已死」的源重验一遍：这一步与配额无关，
    // 是为了让每个重点台的第一条源永远不会用半天前的结论。
    for (const url of task.mustProbe) {
      if (Date.now() > deadline) { partial = true; break; }
      if (done.has(url)) continue;
      done.add(url);
      await probeOne(task, url);
    }

    let verified = arrangeSources(task.urls, map, {
      quota: task.quota, cap: rules.focusSources, requireSegment, now: Date.now(),
    }).verified;
    if (verified >= task.quota) return verified;

    for (let i = 0; i < candidates.length && verified < task.quota; i++) {
      if (Date.now() > deadline) { partial = true; break; }
      const url = candidates[i];
      if (done.has(url)) continue;
      done.add(url);
      await probeOne(task, url);
      if (task.probed >= limit) break;
      verified = arrangeSources(task.urls, map, {
        quota: task.quota, cap: rules.focusSources, requireSegment, now: Date.now(),
      }).verified;
    }
    return verified;
  };

  /** 候选：先补过期/未验的，再补从没测过的；已可播与已判死都不再试 */
  const rankedCandidates = (task: Task, onlyNew?: Set<string>): string[] => {
    return uniqueBare(task.urls)
      .map((raw) => ({ raw, rank: rankCandidate(bareUrl(raw), map, requireSegment, now) }))
      .filter((x) => x.rank < 98 && (!onlyNew || onlyNew.has(bareUrl(x.raw))))
      .sort((a, b) => a.rank - b.rank)
      .map((x) => bareUrl(x.raw));
  };

  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < tasks.length) {
      if (Date.now() > deadline) { partial = true; return; }
      const task = tasks[cursor++];
      try {
        await probeInto(task, rankedCandidates(task));
        task.afterVerified = arrangeSources(task.urls, map, {
          quota: task.quota, cap: rules.focusSources, requireSegment, now: Date.now(),
        }).verified;
      } catch (err) {
        console.warn(`[guard] ${task.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  running = true;
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()));

    // 源池也不够 → 重新拉一遍直播源列表，只补缺口台的新地址
    let gaps = tasks.filter((t) => t.afterVerified < t.quota);
    if (gaps.length > 0 && refreshSources && Date.now() < deadline) {
      const inputs = await loadLiveSourceInputs(storage);
      if (inputs.length > 0) {
        console.log(`[guard] ${gaps.length} channels still short, refreshing ${inputs.length} live sources...`);
        const fresh = await fetchAndParseLiveUrls(inputs, 8000);
        const freshMap = buildPoolMap(fresh, rules);
        for (const task of gaps) {
          const key = canonicalChannelName(task.name, rules).toUpperCase();
          const extra = freshMap.get(key) || [];
          const known = new Set(uniqueBare(task.urls).map(bareUrl));
          const newOnes = extra.filter((u) => !known.has(bareUrl(u)));
          if (newOnes.length === 0) continue;
          task.urls = uniqueBare([...task.urls, ...newOnes]);
          task.added += newOnes.length;
          addedUrls += newOnes.length;
          await probeInto(task, rankedCandidates(task, new Set(newOnes.map(bareUrl))));
          task.afterVerified = arrangeSources(task.urls, map, {
            quota: task.quota, cap: rules.focusSources, requireSegment, now: Date.now(),
          }).verified;
        }
      }
    }

    const totalBefore = tasks.reduce((n, t) => n + t.beforeVerified, 0);
    const totalAfter = tasks.reduce((n, t) => n + t.afterVerified, 0);
    if (totalAfter < totalBefore) {
      // 只升不降：算出来变差就保持原样，等下一轮
      return {
        state: 'noop', checked: tasks.length, probed, repaired: 0, changed: 0, addedUrls,
        gaps: tasks.filter((t) => t.afterVerified < t.quota).map((t) => ({ group: t.group.group || '', name: t.name, tier: t.tier, verified: t.afterVerified, quota: t.quota })),
        published: false, elapsedMs: Date.now() - started, note: 'regression-guard',
      };
    }

    let changed = 0;
    for (const task of tasks) {
      const arr = arrangeSources(task.urls, map, {
        quota: task.quota, cap: rules.focusSources, requireSegment, now: Date.now(),
      });
      if (arr.urls.length === 0) continue;
      // 不把「还没测出结论」的新地址直接发出去：它们对客户端就是一次未知的超时。
      // 已在原输出里的条目保留，避免把原有候选越改越少。
      const safeUrls = arr.urls.filter((u) => map[bareUrl(u)] || task.outputUrls.includes(u));
      const before = JSON.stringify(task.outputUrls);
      const after = JSON.stringify(safeUrls);
      if (after !== before) {
        task.group.channels[task.index].urls = safeUrls;
        changed++;
      }
      if (task.afterVerified > task.beforeVerified) repaired++;
      task.afterVerified = arr.verified;
    }

    gaps = tasks.filter((t) => t.afterVerified < t.quota);
    if (probed > 0) await saveSpeedMap(storage, map);

    let published = false;
    if (changed > 0) {
      await storage.put(KV_MERGED_CONFIG, JSON.stringify(full));
      try {
        const ftp = await loadFtpConfig(storage);
        if (ftp.enabled && ftp.host) {
          const res = await uploadLiveTxt(ftp, formatLiveGroupsAsTxt(lives));
          published = res.ok;
          if (!res.ok) console.warn(`[guard] ftp publish failed: ${res.error}`);
        }
      } catch (err) {
        console.warn(`[guard] ftp publish error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // 连续缺口计数 + 告警：一轮抖动不叫人，连续 3 轮补不上才发
    let state: Record<string, number> = {};
    try {
      const rawState = await storage.get(KV_LIVE_GUARD_STATE);
      if (rawState) state = JSON.parse(rawState);
    } catch { /* ignore */ }
    const gapKeys = new Set<string>();
    for (const g of gaps) {
      const k = `${g.tier}|${g.name}`;
      gapKeys.add(k);
      state[k] = (state[k] || 0) + 1;
    }
    for (const k of Object.keys(state)) if (!gapKeys.has(k)) delete state[k];
    await storage.put(KV_LIVE_GUARD_STATE, JSON.stringify(state));

    // 只对「快黑的重点台」告警：央视/卫视且可播 ≤1。地方台 1/2 属于覆盖问题，
    // 留在缺口报表里，不半夜叫人。
    const persistent = gaps.filter((g) =>
      (g.tier === 'cctv' || g.tier === 'satellite')
      && g.afterVerified <= 1
      && (state[`${g.tier}|${g.name}`] || 0) >= GUARD_ALERT_AFTER,
    );
    if (persistent.length > 0) {
      const cfg = await loadAlertConfig(storage);
      await sendAlert(storage, cfg, {
        key: 'guard-persistent-gap',
        level: 'warn',
        title: '【IPTV】重点频道连续多轮补不上源',
        text: persistent
          .slice(0, 10)
          .map((g) => `${g.name}：${g.afterVerified}/${g.quota}`)
          .join('\n') + `\n（守夜每小时自动补测，已连续 ${GUARD_ALERT_AFTER} 轮仍不足）`,
      });
    }

    const result: GuardResult = {
      state: partial ? 'partial' : changed > 0 ? 'done' : 'noop',
      checked: tasks.length,
      probed,
      repaired,
      changed,
      addedUrls,
      gaps: gaps.map((g) => ({ group: g.group.group || '', name: g.name, tier: g.tier, verified: g.afterVerified, quota: g.quota })),
      published,
      elapsedMs: Date.now() - started,
    };
    await storage.put(KV_LIVE_GUARD_REPORT, JSON.stringify({ at: new Date().toISOString(), ...result }));
    return result;
  } finally {
    running = false;
  }
}
