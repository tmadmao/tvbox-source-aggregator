// 调度执行历史
//
// 解决的问题：原来只有 `agg_logs`（聚合成功/失败的业务日志，最多 50 条），
// 而且「超时/进程被杀」根本写不进去 —— 于是「昨天 5 点到底跑没跑」答不出来。
//
// 这里记录的是**调度层**的事实：谁触发的、什么时候开始、什么时候结束、结果如何。
// 即使进程中途挂了，下一次启动也会把「running 超过 3 小时」的记录收尾成「进程中断」。
//
// 只保留 7 天，且最多 400 条：够回答「昨天/前天跑没跑」，也不会把 KV 撑大。

import type { Storage } from '../storage/interface';
import { KV_RUN_HISTORY, RUN_HISTORY_KEEP_MS, RUN_HISTORY_MAX, RUN_STALE_MS } from './config';

export { RUN_STALE_MS };

export type RunKind = 'aggregate' | 'probe' | 'backup';
export type RunStatus = 'running' | 'success' | 'failed' | 'timeout' | 'skipped';
export type RunTrigger = 'cron' | 'manual' | 'startup' | 'probe';

export interface RunRecord {
  id: string;
  kind: RunKind;
  trigger: RunTrigger;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  status: RunStatus;
  error?: string;
  note?: string;
  stats?: Record<string, string | number | boolean>;
}

export type RunHistory = RunRecord[];

function parse(raw: string | null): RunHistory {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x) => x && typeof x === 'object' && x.id) : [];
  } catch {
    return [];
  }
}

/** 保留 7 天 + 最多 400 条（双重兜底） */
export function pruneRuns(runs: RunHistory, now = Date.now()): RunHistory {
  const kept = runs.filter((r) => {
    const t = Date.parse(r.startedAt);
    return !isFinite(t) || now - t <= RUN_HISTORY_KEEP_MS;
  });
  return kept.slice(Math.max(0, kept.length - RUN_HISTORY_MAX));
}

/**
 * 收尾「悬空的 running」：进程被杀 / 断电 / 容器重建时，记录会停在 running。
 * 超过 maxAge 就按「进程中断」判失败 —— 不写这一笔，第二天永远看不出「没跑」。
 */
export function closeStaleRunning(runs: RunHistory, now = Date.now(), maxAgeMs = 3 * 3600 * 1000): RunHistory {
  return runs.map((r) => {
    if (r.status !== 'running') return r;
    const t = Date.parse(r.startedAt);
    if (!isFinite(t) || now - t < maxAgeMs) return r;
    return {
      ...r,
      status: 'failed' as RunStatus,
      finishedAt: new Date(t + maxAgeMs).toISOString(),
      durationMs: maxAgeMs,
      error: '进程中断（无结束记录）',
    };
  });
}

export async function loadRunHistory(storage: Storage): Promise<RunHistory> {
  return pruneRuns(closeStaleRunning(parse(await storage.get(KV_RUN_HISTORY))));
}

export async function saveRunHistory(storage: Storage, runs: RunHistory): Promise<void> {
  await storage.put(KV_RUN_HISTORY, JSON.stringify(pruneRuns(clone(runs))));
}

function clone(runs: RunHistory): RunHistory {
  return runs.map((r) => ({ ...r }));
}

export async function beginRun(
  storage: Storage,
  kind: RunKind,
  trigger: RunTrigger,
  note?: string,
): Promise<RunRecord> {
  const runs = await loadRunHistory(storage);
  const rec: RunRecord = {
    id: `${new Date().toISOString()}-${kind}`,
    kind,
    trigger,
    startedAt: new Date().toISOString(),
    status: 'running',
    note,
  };
  runs.push(rec);
  await saveRunHistory(storage, runs);
  return rec;
}

export async function finishRun(
  storage: Storage,
  id: string,
  patch: Partial<Pick<RunRecord, 'status' | 'error' | 'note' | 'stats'>>,
): Promise<RunRecord | null> {
  const runs = await loadRunHistory(storage);
  const idx = runs.findIndex((r) => r.id === id);
  if (idx < 0) return null;
  const cur = runs[idx];
  const endMs = Date.now();
  const startMs = Date.parse(cur.startedAt);
  const next: RunRecord = {
    ...cur,
    ...patch,
    status: patch.status ?? cur.status,
    finishedAt: new Date(endMs).toISOString(),
    durationMs: isFinite(startMs) ? Math.max(0, endMs - startMs) : undefined,
  };
  runs[idx] = next;
  await saveRunHistory(storage, runs);
  return next;
}

// ─── 汇总（纯函数，便于单测） ──────────────────────────

export interface DailyRun {
  date: string;                 // YYYY-MM-DD（本地时区）
  status: 'success' | 'failed' | 'partial' | 'none';
  runs: number;
  at?: string;                  // 当天最后一次成功的时间（本地 HH:mm）
}

export interface RunSummary {
  last?: RunRecord;
  lastSuccess?: RunRecord;
  lastFailure?: RunRecord;
  consecutiveFailures: number;
  /** 超过 26 小时没有成功 → 视为漏跑 */
  stale: boolean;
  staleHours: number;
  today: { total: number; success: number; failed: number; running: number };
  daily: DailyRun[];
}

function localDate(ts: number, tz: string): string {
  try {
    return new Date(ts).toLocaleDateString('sv-SE', { timeZone: tz });
  } catch {
    return new Date(ts).toISOString().slice(0, 10);
  }
}

function localTime(ts: number, tz: string): string {
  try {
    return new Date(ts).toLocaleTimeString('zh-CN', {
      timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
    });
  } catch {
    return new Date(ts).toISOString().slice(11, 16);
  }
}

export function summarizeRuns(
  runs: RunHistory,
  now = Date.now(),
  tz = 'Asia/Shanghai',
  days = 7,
): RunSummary {
  const all = pruneRuns(closeStaleRunning(runs, now), now);
  const sorted = [...all].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  const last = sorted[sorted.length - 1];
  const successes = sorted.filter((r) => r.status === 'success');
  const failures = sorted.filter((r) => r.status === 'failed' || r.status === 'timeout');
  const lastSuccess = successes[successes.length - 1];
  const lastFailure = failures[failures.length - 1];

  let consecutiveFailures = 0;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const s = sorted[i].status;
    if (s === 'success') break;
    if (s === 'failed' || s === 'timeout') consecutiveFailures++;
  }

  const lastOkMs = lastSuccess ? Date.parse(lastSuccess.startedAt) : 0;
  const stale = !lastOkMs || now - lastOkMs > RUN_STALE_MS;

  const todayKey = localDate(now, tz);
  const todayRuns = sorted.filter((r) => localDate(Date.parse(r.startedAt), tz) === todayKey);

  const daily: DailyRun[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const key = localDate(now - i * 24 * 3600 * 1000, tz);
    const list = sorted.filter((r) => localDate(Date.parse(r.startedAt), tz) === key);
    const ok = list.filter((r) => r.status === 'success');
    const bad = list.filter((r) => r.status === 'failed' || r.status === 'timeout');
    daily.push({
      date: key,
      status: ok.length > 0 ? 'success' : bad.length > 0 ? 'failed' : list.length > 0 ? 'partial' : 'none',
      runs: list.length,
      at: ok.length > 0 ? localTime(Date.parse(ok[ok.length - 1].startedAt), tz) : undefined,
    });
  }

  return {
    last,
    lastSuccess,
    lastFailure,
    consecutiveFailures,
    stale,
    staleHours: lastOkMs ? Math.round((now - lastOkMs) / 3600000) : -1,
    today: {
      total: todayRuns.length,
      success: todayRuns.filter((r) => r.status === 'success').length,
      failed: todayRuns.filter((r) => r.status === 'failed' || r.status === 'timeout').length,
      running: todayRuns.filter((r) => r.status === 'running').length,
    },
    daily,
  };
}
