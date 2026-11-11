// 死源台账（旧名：死源黑名单）
//
// 模型变了：以前是「一票否决的名单」，现在是「源的终身档案」。
//
//   判过死的源不删、不丢，记下它什么时候死、最后一次测是什么时候、死了多久；
//   之后按周期回测：待观察（state=1）一周一次，判死（state=2）一月一次。
//   死满一个月且仍然是死的 → 转「判死」，但**仍然留在库里** ——
//   空间不值钱，而一个 URL 的存活史值钱：下次从外部源采集到同一个地址，
//   查档案就知道还要不要采信，不必重新测一遍。
//
// 存储格式 v2（紧凑元组，比对象数组省一半体积）：
//   {"v":2,"rows":[[url, state, since, probedAt], ...]}
//   state:    1 = 待观察（周回测） / 2 = 已判死（月回测）
//   since:    判定「死」的起点（epoch ms），0 = 未知
//   probedAt: 最后一次回测（epoch ms），0 = 从未回测
// 兼容 v1：纯字符串数组，读入时按 state=1、时间未知处理。

import type { Storage } from '../storage/interface';
import { KV_LIVE_DEAD_URLS } from './config';
import { isProtectedUrl } from './channel-curation';

/** 待观察：一周回测一次 */
export const DEAD_RETEST_MS = 7 * 24 * 3600 * 1000;
/** 判死：一月回测一次（不是永不回测，域名复活还能捞回来） */
export const CONDEMNED_RETEST_MS = 30 * 24 * 3600 * 1000;
/** 死满一个月 → 判死 */
export const CONDEMN_AFTER_MS = 30 * 24 * 3600 * 1000;
/** 兜底上限，防止异常数据把 KV 撑爆（正常量级 5 万条） */
const MAX_ENTRIES = 300000;

export type DeadState = 1 | 2;

export interface DeadRow {
  url: string;
  state: DeadState;
  since: number;
  probedAt: number;
}

interface LedgerFile {
  v: 2;
  rows: Array<[string, DeadState, number, number]>;
}

function parseRows(raw: string | null): DeadRow[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  if (Array.isArray(parsed)) {
    return parsed
      .filter((u): u is string => typeof u === 'string')
      .map((url) => ({ url, state: 1 as DeadState, since: 0, probedAt: 0 }));
  }

  const file = parsed as LedgerFile;
  if (file && file.v === 2 && Array.isArray(file.rows)) {
    return file.rows
      .filter((r) => Array.isArray(r) && typeof r[0] === 'string')
      .map((r) => ({
        url: r[0] as string,
        state: (r[1] === 2 ? 2 : 1) as DeadState,
        since: Number(r[2]) || 0,
        probedAt: Number(r[3]) || 0,
      }));
  }
  return [];
}

async function saveRows(storage: Storage, rows: DeadRow[]): Promise<void> {
  const seen = new Set<string>();
  const out: Array<[string, DeadState, number, number]> = [];
  for (const r of rows) {
    if (!r.url || seen.has(r.url)) continue;
    seen.add(r.url);
    out.push([r.url, r.state, r.since, r.probedAt]);
    if (out.length >= MAX_ENTRIES) break;
  }
  await storage.put(KV_LIVE_DEAD_URLS, JSON.stringify({ v: 2, rows: out }));
}

export async function loadDeadRows(storage: Storage): Promise<DeadRow[]> {
  return parseRows(await storage.get(KV_LIVE_DEAD_URLS));
}

export async function saveDeadRows(storage: Storage, rows: DeadRow[]): Promise<void> {
  await saveRows(storage, rows);
}

/** 兼容旧接口：当前不该出现在输出里的 URL（待观察 + 已判死） */
export async function loadDeadUrls(storage: Storage): Promise<string[]> {
  return (await loadDeadRows(storage)).map((r) => r.url);
}

/**
 * 追加一批死链（幂等）。受保护域名一律跳过，防止误杀重点频道的官方源。
 * 已存在的条目不重置「死了多久」的计时。
 */
export async function addDeadUrls(storage: Storage, urls: string[], now = Date.now()): Promise<number> {
  if (urls.length === 0) return 0;
  const safe = urls.filter((u) => !isProtectedUrl(u));
  if (safe.length === 0) return 0;

  const rows = await loadDeadRows(storage);
  const index = new Map(rows.map((r) => [r.url, r]));
  let added = 0;

  for (const url of safe) {
    const hit = index.get(url);
    if (hit) {
      if (!hit.since) hit.since = now;      // 老账本没有起点，从现在开始计时
      if (hit.state !== 1) hit.state = 1;   // 判死过又被重新点出来 → 回到待观察
      continue;
    }
    const row: DeadRow = { url, state: 1, since: now, probedAt: 0 };
    rows.push(row);
    index.set(url, row);
    added++;
  }
  await saveRows(storage, rows);
  return added;
}

/** 把已恢复的 URL 移出（测速侧调用）——恢复即出档 */
export async function removeRecoveredUrls(storage: Storage, urls: string[]): Promise<number> {
  if (urls.length === 0) return 0;
  const rows = await loadDeadRows(storage);
  if (rows.length === 0) return 0;
  const recovered = new Set(urls);
  const next = rows.filter((r) => !recovered.has(r.url));
  const removed = rows.length - next.length;
  if (removed > 0) await saveRows(storage, next);
  return removed;
}

/**
 * 把受保护域名从台账里回捞（历史误判的补救）。
 * 老版本没有保护机制，「清理死源」曾把 nklive.nbs.cn 整段写进去，
 * 导致南京地方台整组消失。
 */
export async function purgeProtectedUrls(storage: Storage): Promise<number> {
  const rows = await loadDeadRows(storage);
  if (rows.length === 0) return 0;
  const next = rows.filter((r) => !isProtectedUrl(r.url));
  const removed = rows.length - next.length;
  if (removed > 0) await saveRows(storage, next);
  return removed;
}

/** 记录一次回测时间（不判生死） */
export async function touchProbed(storage: Storage, urls: string[], now = Date.now()): Promise<void> {
  if (urls.length === 0) return;
  const rows = await loadDeadRows(storage);
  const set = new Set(urls);
  let changed = false;
  for (const r of rows) {
    if (!set.has(r.url)) continue;
    r.probedAt = now;
    changed = true;
  }
  if (changed) await saveRows(storage, rows);
}

/**
 * 死满一个月仍然死 → 转「判死」，回测频率从周降到月。
 * 不删除：判死只是降频，域名哪天复活还能被月度回测捞回来。
 */
export async function condemnExpired(
  storage: Storage,
  isStillDead: (url: string) => boolean,
  now = Date.now(),
): Promise<{ promoted: number; total: number; backfilled: number }> {
  const rows = await loadDeadRows(storage);
  let promoted = 0;
  let backfilled = 0;
  for (const r of rows) {
    if (r.state === 2) continue;
    const since = r.since || r.probedAt || 0;
    if (!since) {
      r.since = now;          // 死亡时间未知 → 从现在开始计时，避免一上来就判死
      backfilled++;
      continue;
    }
    if (now - since < CONDEMN_AFTER_MS) continue;
    if (!isStillDead(r.url)) continue;
    r.state = 2;
    promoted++;
  }
  // 只按 promoted 落盘会丢掉 since 的回填：未知年龄的死源本轮若没有别的条目被判死，
  // 回填就随函数返回蒸发，判死时钟永远不启动（P2-9）。
  if (promoted > 0 || backfilled > 0) await saveRows(storage, rows);
  return { promoted, total: rows.length, backfilled };
}

export interface LedgerStats {
  total: number;
  warm: number;
  condemned: number;
  unknownAge: number;
  dueWarm: number;
  dueCondemned: number;
}

export function ledgerStats(rows: DeadRow[], now = Date.now()): LedgerStats {
  let warm = 0, condemned = 0, unknownAge = 0, dueWarm = 0, dueCondemned = 0;
  for (const r of rows) {
    if (!r.since) unknownAge++;
    if (r.state === 2) {
      condemned++;
      if (!r.probedAt || now - r.probedAt >= CONDEMNED_RETEST_MS) dueCondemned++;
    } else {
      warm++;
      if (!r.probedAt || now - r.probedAt >= DEAD_RETEST_MS) dueWarm++;
    }
  }
  return { total: rows.length, warm, condemned, unknownAge, dueWarm, dueCondemned };
}

/** 该条死链下次可回测的时间戳（0 = 现在就该测） */
export function nextRetestAt(row: DeadRow): number {
  const interval = row.state === 2 ? CONDEMNED_RETEST_MS : DEAD_RETEST_MS;
  return (row.probedAt || 0) + interval;
}

export async function clearDeadUrls(storage: Storage): Promise<void> {
  await storage.put(KV_LIVE_DEAD_URLS, JSON.stringify({ v: 2, rows: [] }));
}
