// 域名健康台账
//
// 从「一条 URL 一条记录」上升到「一个域名一条结论」。
//
// 为什么值得单独一层：
//   实测频道树涉及 2161 个域名，其中 1859 个（86%）名下的源一条都播不出来，
//   却占了 12352 条源。逐条回测这些源是纯浪费 —— 一个域名下的源共享同一套
//   CDN/服务器，全都连不上就是整片死了，抽 3 条就能代表。
//
// 但**不能一刀切**：实测 63 个域名是「部分活」（45.192.97.170 可用率 20%、
// 8.138.7.223 6%），这类域名必须继续逐条判，只按单条 URL 的结论走。
//
// 状态机：
//   （无记录）= 正常，按 URL 级规则测
//   state=1 可疑：抽样全失败，7 天后抽 3 条复验
//   state=2 判死：可疑满 30 天且抽样仍全失败，30 天后抽 3 条复验，名下源不再输出
//
// 抽样是「按哈希均匀取」，不是取前 3 条 —— 同一域名下的源常常是同一路径换参数，
// 取前三条等于只测了一个地址。

import type { Storage } from '../storage/interface';
import { KV_LIVE_HOST_STATE } from './config';

/** 可疑域名：7 天复验一次 */
export const HOST_SUSPECT_RETEST_MS = 7 * 24 * 3600 * 1000;
/** 判死域名：30 天复验一次（不永久放弃，域名可能复活） */
export const HOST_DEAD_RETEST_MS = 30 * 24 * 3600 * 1000;
/** 可疑满 30 天 → 判死 */
export const HOST_DEAD_AFTER_MS = 30 * 24 * 3600 * 1000;
/** 每个域名每次复验抽几条 */
export const HOST_SAMPLE_N = 3;
/** 名下源少于这个数不做域名级判定（只有一条源的域名，样本没有代表性） */
export const HOST_MIN_URLS = 2;

export type HostState = 1 | 2;

export interface HostRow {
  host: string;
  state: HostState;
  since: number;      // 进入可疑的起点
  probedAt: number;   // 最后一次抽样复验
  urls: number;       // 上次统计时名下的源数（展示用）
  ok: number;         // 上次统计时可播条数（展示用）
}

interface HostFile {
  v: 1;
  rows: Record<string, [HostState, number, number, number, number]>;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function parse(raw: string | null): HostRow[] {
  if (!raw) return [];
  try {
    const file = JSON.parse(raw) as HostFile;
    if (!file || file.v !== 1 || !file.rows) return [];
    return Object.entries(file.rows)
      .filter(([, v]) => Array.isArray(v))
      .map(([host, v]) => ({
        host,
        state: (v[0] === 2 ? 2 : 1) as HostState,
        since: Number(v[1]) || 0,
        probedAt: Number(v[2]) || 0,
        urls: Number(v[3]) || 0,
        ok: Number(v[4]) || 0,
      }));
  } catch {
    return [];
  }
}

async function save(storage: Storage, rows: HostRow[]): Promise<void> {
  const out: Record<string, [HostState, number, number, number, number]> = {};
  for (const r of rows) {
    if (!r.host) continue;
    out[r.host] = [r.state, r.since, r.probedAt, r.urls, r.ok];
  }
  await storage.put(KV_LIVE_HOST_STATE, JSON.stringify({ v: 1, rows: out }));
}

export async function loadHostRows(storage: Storage): Promise<HostRow[]> {
  return parse(await storage.get(KV_LIVE_HOST_STATE));
}

export async function loadHostMap(storage: Storage): Promise<Map<string, HostRow>> {
  return new Map((await loadHostRows(storage)).map((r) => [r.host, r]));
}

export async function saveHostRows(storage: Storage, rows: HostRow[]): Promise<void> {
  await save(storage, rows);
}

/** 该域名下当前「轮到复验」的条数：0 表示本轮跳过它名下所有源 */
export function hostSampleQuota(row: HostRow | undefined, now = Date.now()): number {
  if (!row) return -1;                       // 正常域名：不限制
  const interval = row.state === 2 ? HOST_DEAD_RETEST_MS : HOST_SUSPECT_RETEST_MS;
  if (!row.probedAt || now - row.probedAt >= interval) return HOST_SAMPLE_N;
  return 0;                                  // 还没到复验时间：整域跳过
}

/** 域名已判死 → 名下源不再输出（但仍会按月抽样回测） */
export function isHostCondemned(map: Map<string, HostRow>, url: string): boolean {
  const h = hostOf(url);
  if (!h) return false;
  return map.get(h)?.state === 2;
}

/** 稳定哈希，用于「均匀抽样」而不是取前几条 */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** 从该域名下的候选 URL 里均匀抽 n 条 */
export function sampleHostUrls(urls: string[], n = HOST_SAMPLE_N): string[] {
  if (urls.length <= n) return urls.slice();
  return urls
    .map((u) => ({ u, k: hash(u) }))
    .sort((a, b) => a.k - b.k)
    .slice(0, n)
    .map((x) => x.u);
}

export interface HostProbeOutcome {
  host: string;
  probed: number;
  ok: number;
}

/**
 * 把一轮抽样结果写回域名台账。
 * - 抽样里有任何一条通 → 域名恢复正常，撤销记录
 * - 抽样全部失败 → 状态至少是「可疑」；可疑满 30 天 → 判死
 *
 * 返回的 `touched` 是「本轮真正改过内存行」的条数（含只刷新 probedAt 的情况）。
 * 调用方必须按它决定是否落盘：只判 revived/marked/condemned 会漏掉最常见的
 * 「已有行又测了一次、状态没变」——那种情况下 probedAt 的更新会随函数返回蒸发，
 * 复验周期（7 天 / 30 天）永远不前进，抽样就退化成每轮重抽。
 */
export function applyHostOutcomes(
  rows: Map<string, HostRow>,
  outcomes: HostProbeOutcome[],
  now = Date.now(),
): { revived: number; marked: number; condemned: number; touched: number } {
  let revived = 0;
  let marked = 0;
  let condemned = 0;
  let touched = 0;

  for (const o of outcomes) {
    if (o.probed === 0) continue;
    // 只测了 1 条就全失败的不下结论 —— 单条地址坏了不代表整个域名死了。
    // 调用方也会先过滤，这里再兜一层，避免以后新增调用点漏掉这个前提。
    if (o.ok === 0 && o.probed < HOST_MIN_URLS) continue;
    const cur = rows.get(o.host);
    if (o.ok > 0) {
      if (cur) { rows.delete(o.host); revived++; touched++; }
      continue;
    }
    touched++;      // 全失败：不管新入账还是刷新 probedAt，都改动了台账
    if (cur) {
      cur.state = (now - (cur.since || now) >= HOST_DEAD_AFTER_MS) ? 2 : 1;
      cur.probedAt = now;
      if (cur.state === 2) condemned++;
    } else {
      rows.set(o.host, { host: o.host, state: 1, since: now, probedAt: now, urls: o.probed, ok: 0 });
      marked++;
    }
  }
  return { revived, marked, condemned, touched };
}

export interface HostStats {
  total: number;
  suspect: number;
  condemned: number;
  due: number;
  coveredUrls: number;
}

export function hostStats(rows: HostRow[], now = Date.now()): HostStats {
  let suspect = 0, condemned = 0, due = 0, coveredUrls = 0;
  for (const r of rows) {
    if (r.state === 2) condemned++; else suspect++;
    coveredUrls += r.urls;
    if (hostSampleQuota(r, now) > 0) due++;
  }
  return { total: rows.length, suspect, condemned, due, coveredUrls };
}
