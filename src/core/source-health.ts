// 源健康的计算层
//
// 只做两件事：把一轮探测结果写进「历史」，以及把历史读成可用率/评分。
// 判定（能不能播）仍由 channel-probe 决定，这里不重复实现判定逻辑。

import type { ChannelSpeedEntry, ChannelSpeedMap } from './types';
import { QUALITY_FAST_MS } from './config';

/** 历史保留轮数（位图长度） */
export const HEALTH_HISTORY_LEN = 12;

export interface HealthSnapshot {
  availability: number;   // 0~1
  score: number;          // 0~1，越大越优先
  tier: 0 | 1 | 2;        // 0 健康 / 1 观察 / 2 隔离
  samples: number;        // 累计轮次
}

/** 把这一轮结果压进 history 位图（保持最近 12 轮：右侧追加 1/0，超长裁掉最旧的） */
export function pushHistory(prev: string | undefined, ok: boolean): string {
  const old = (prev || '').slice(-HEALTH_HISTORY_LEN);
  const next = old + (ok ? '1' : '0');
  return next.length > HEALTH_HISTORY_LEN ? next.slice(-HEALTH_HISTORY_LEN) : next;
}

/**
 * 记录一次探测结果。
 * 这是健康字段唯一的写入点：probe 与「输出前复核」都走这里，避免两处口径不一致。
 */
export function recordProbe(
  map: ChannelSpeedMap,
  url: string,
  r: { kind: string; speedMs: number; stage?: 'playlist' | 'segment'; note?: string },
  when = new Date().toISOString(),
): ChannelSpeedEntry {
  const prev = map[url];
  const ok = r.kind !== 'fail';
  // `consecutiveFails` 与 `fails` 是同一语义的两个字段（历史遗留，读的地方会混用
  // `??` 兜底）。既然这里是唯一写入点，就由同一个值派生，避免某天只更新一个而分叉。
  const nextFails = ok ? 0 : ((prev?.consecutiveFails ?? prev?.fails ?? 0) + 1);
  const entry: ChannelSpeedEntry = {
    ...(prev || {}),
    speedMs: ok ? r.speedMs : 0,
    kind: r.kind as ChannelSpeedEntry['kind'],
    probedAt: when,
    stage: r.stage,
    okCount: (prev?.okCount ?? 0) + (ok ? 1 : 0),
    failCount: (prev?.failCount ?? 0) + (ok ? 0 : 1),
    history: pushHistory(prev?.history, ok),
    consecutiveFails: nextFails,
    fails: nextFails,
  };
  if (ok) {
    entry.lastOkAt = when;
    delete entry.firstFailAt;
    delete entry.note;
  } else {
    if (!prev || prev.kind !== 'fail') entry.firstFailAt = when;
    else entry.firstFailAt = prev.firstFailAt || when;
    if (r.note) entry.note = r.note;
  }
  map[url] = entry;
  return entry;
}

/** thread 内部：可用率用累计计数，缺计数时退回 history 位图 */
export function availabilityOf(entry: ChannelSpeedEntry | undefined): number {
  if (!entry) return 0;
  const ok = entry.okCount ?? 0;
  const fail = entry.failCount ?? 0;
  if (ok + fail > 0) return ok / (ok + fail);
  const h = entry.history;
  if (h && h.length > 0) {
    const ones = h.split('').filter((c) => c === '1').length;
    return ones / h.length;
  }
  return entry.kind === 'fail' ? 0 : 1;
}

/** 速度分归零点：与分级里的「快」用同一条线（config.ts 单一来源） */
const SPEED_FLOOR_MS = QUALITY_FAST_MS;

export function scoreOf(entry: ChannelSpeedEntry | undefined): number {
  if (!entry) return 0;
  const availability = availabilityOf(entry);
  const speedScore = entry.kind === 'fail'
    ? 0
    : 1 - Math.min(1, Math.max(0, entry.speedMs) / SPEED_FLOOR_MS);
  const h = entry.history || '';
  const recent = h.slice(-6);
  const stability = recent.length > 0
    ? recent.split('').filter((c) => c === '1').length / recent.length
    : (entry.kind === 'fail' ? 0 : 1);
  return 0.55 * availability + 0.3 * speedScore + 0.15 * stability;
}

/** 分桶：健康 / 观察 / 隔离 */
export function tierOf(entry: ChannelSpeedEntry | undefined): 0 | 1 | 2 {
  if (!entry) return 1;
  const availability = availabilityOf(entry);
  const fails = entry.consecutiveFails ?? entry.fails ?? 0;
  if (fails >= 2 && entry.kind === 'fail') return 2;
  if (availability >= 0.9) return 0;
  if (availability >= 0.6) return 1;
  return 2;
}

export function snapshotOf(entry: ChannelSpeedEntry | undefined): HealthSnapshot {
  const h = entry?.history || '';
  return {
    availability: availabilityOf(entry),
    score: scoreOf(entry),
    tier: tierOf(entry),
    samples: h.length,
  };
}

export interface DomainSummary {
  host: string;
  sources: number;
  ok: number;
  okRate: number;
  avgMs: number;
}

/** 按域名聚合：单 IP 挂几百条的源是主要瓶颈，按源看是几百个失败，按域名看是一句话 */
export function domainSummary(map: ChannelSpeedMap): DomainSummary[] {
  const acc = new Map<string, { sources: number; ok: number; msSum: number; msCount: number }>();
  for (const [url, entry] of Object.entries(map)) {
    let host = '';
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      host = 'invalid';
    }
    const cur = acc.get(host) || { sources: 0, ok: 0, msSum: 0, msCount: 0 };
    cur.sources++;
    if (entry.kind !== 'fail') {
      cur.ok++;
      if (entry.speedMs > 0) {
        cur.msSum += entry.speedMs;
        cur.msCount++;
      }
    }
    acc.set(host, cur);
  }
  return [...acc.entries()]
    .map(([host, v]) => ({
      host,
      sources: v.sources,
      ok: v.ok,
      okRate: v.sources ? v.ok / v.sources : 0,
      avgMs: v.msCount ? Math.round(v.msSum / v.msCount) : 0,
    }))
    .sort((a, b) => b.sources - a.sources);
}
