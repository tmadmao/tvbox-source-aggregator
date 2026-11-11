// 输出前复核首位源
//
// 为什么需要：测速是「过去某一刻」的事实。实测首位源可播率只有 73%，
// 失败集中在单 IP 挂几百条的源上——测的时候活着，十分钟后就撑不住。
// TV 端只会从第一条开始试，所以我们在这里替它先试一次：第一位不行就换下一位。
//
// 代价受控：每个频道最多复核 headCount 条（默认 3），且只在真的失败时才往后试。

import type { ChannelSpeedMap, TVBoxLiveGroup } from './types';
import { bareUrl } from './live-url';
import { probeUrlOnce } from './channel-probe';
import { recordProbe } from './source-health';

export interface ReverifyOptions {
  /** 每个频道最多往后试几条，默认 3 */
  headCount?: number;
  /** 频道级并发，默认 24 */
  concurrency?: number;
  /** 同一域名同时最多几条，默认 4（单 IP 挂几百条的源很常见，别把它打崩） */
  perHost?: number;
  /** 整轮复核的时间预算（毫秒），超时就收工，默认 8 分钟 */
  budgetMs?: number;
  /** L2 分片复验开关（与测速口径一致），默认开启 */
  requireSegment?: boolean;
}

/**
 * 单条探测的硬超时。
 *
 * `probeUrlOnce` 内部有 5s AbortController，但实测出现过「信号发了、连接不回收」
 * 的僵死：24 个 worker 全卡在同一批 socket 上，CPU 与网络 I/O 都归零，
 * 整轮聚合就停在这一步（日志停 20 分钟不动）。这里加一层 Promise.race 兜底，
 * 保证 worker 一定会被放回去 —— 排序退化成「维持原序」也比整轮卡死强。
 */
const PROBE_HARD_TIMEOUT_MS = 12000;

async function raceTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([p, guard]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface ReverifyStats {
  /** 复核过的频道数 */
  checked: number;
  /** 首位不通过、最终换掉的频道数 */
  promoted: number;
  /** 首位不通过但后面也没有可用源的频道数 */
  allDead: number;
  /** 全部候选都硬超时（结论未知，未写健康数据）的频道数 */
  unknown: number;
  /** 实际发出的探测请求数 */
  requests: number;
  elapsedMs: number;
}

interface HostGate {
  counts: Map<string, number>;
  waiters: Map<string, Array<() => void>>;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

async function acquire(gate: HostGate, host: string, limit: number): Promise<void> {
  if (!host || limit <= 0) return;
  const cur = gate.counts.get(host) || 0;
  if (cur < limit) {
    gate.counts.set(host, cur + 1);
    return;
  }
  await new Promise<void>((resolve) => {
    const queue = gate.waiters.get(host) || [];
    queue.push(resolve);
    gate.waiters.set(host, queue);
  });
  gate.counts.set(host, (gate.counts.get(host) || 0) + 1);
}

function release(gate: HostGate, host: string): void {
  if (!host) return;
  const cur = Math.max(0, (gate.counts.get(host) || 1) - 1);
  gate.counts.set(host, cur);
  const queue = gate.waiters.get(host);
  if (queue && queue.length > 0) {
    const next = queue.shift()!;
    if (queue.length === 0) gate.waiters.delete(host);
    next();
  }
}

/**
 * 复核每个频道的前几条源，把第一条可用的换到最前面。
 * 会顺带把这次的结论写回 speedMap（probedAt 刷新），下一轮测速因此不用重复测。
 */
export async function reverifyHeadSources(
  groups: TVBoxLiveGroup[],
  speedMap: ChannelSpeedMap,
  opts: ReverifyOptions = {},
): Promise<{ groups: TVBoxLiveGroup[]; stats: ReverifyStats }> {
  const headCount = Math.max(1, opts.headCount ?? 3);
  const concurrency = Math.max(1, opts.concurrency ?? 24);
  const perHost = Math.max(1, opts.perHost ?? 4);
  const budgetMs = Math.max(10_000, opts.budgetMs ?? 8 * 60 * 1000);
  const started = Date.now();
  const deadline = started + budgetMs;

  const stats: ReverifyStats = { checked: 0, promoted: 0, allDead: 0, unknown: 0, requests: 0, elapsedMs: 0 };
  console.log(`[live-verify] start: channels=${groups.reduce((n, g) => n + (g.channels || []).length, 0)} concurrency=${concurrency} perHost=${perHost} budget=${Math.round(budgetMs / 1000)}s`);
  const gate: HostGate = { counts: new Map(), waiters: new Map() };

  // 收集待复核频道（只处理有多个源的，单源频道复不复核结果一样，但也能暴露死链）
  const tasks: Array<{ group: TVBoxLiveGroup; channelIndex: number; urls: string[] }> = [];
  for (const group of groups) {
    if (!Array.isArray(group.channels)) continue;
    group.channels.forEach((ch, idx) => {
      if (!Array.isArray(ch.urls) || ch.urls.length === 0) return;
      tasks.push({ group, channelIndex: idx, urls: ch.urls.slice(0, headCount) });
    });
  }

  const applyResult = (url: string, r: Awaited<ReturnType<typeof probeUrlOnce>>): void => {
    stats.requests++;
    recordProbe(speedMap, url, r);
  };

  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < tasks.length) {
      if (Date.now() > deadline) return;   // 预算用完就收工，不再开新频道
      const task = tasks[cursor++];
      const urls = task.urls;
      if (urls.length === 0) continue;
      stats.checked++;
      // 每 100 个频道打一行：这步以前会「静默卡死」，没有进度就只能靠猜
      if (stats.checked % 100 === 0) {
        console.log(`[live-verify] progress ${stats.checked}/${tasks.length} requests=${stats.requests} promoted=${stats.promoted} elapsed=${Math.round((Date.now() - started) / 1000)}s`);
      }

      let firstOk = -1;
      let timedOutAll = true;
      for (let i = 0; i < urls.length; i++) {
        const bare = bareUrl(urls[i]);
        if (!bare) continue;
        const host = hostOf(bare);
        await acquire(gate, host, perHost);
        let r: Awaited<ReturnType<typeof probeUrlOnce>> | null = null;
        try {
          r = await raceTimeout(probeUrlOnce(bare, false, opts.requireSegment), PROBE_HARD_TIMEOUT_MS);
        } finally {
          release(gate, host);
        }
        if (!r) {
          // 硬超时：这是「外层调度/连接池退化」的信号，不是源的问题。
          // 以前这里伪造一次 fail 并 recordProbe，等于把自己的拥塞记到被探测的源头上，
          // 好源可能被自己 12s 的超时推向 dead。与 quality-guard / source-guarantee
          // 的口径对齐：不写结论，只放弃这一条，继续试下一条。
          continue;
        }
        timedOutAll = false;
        applyResult(bare, r);
        if (r.kind !== 'fail') {
          firstOk = i;
          break;
        }
      }

      if (firstOk < 0) {
        if (timedOutAll) stats.unknown++;
        else stats.allDead++;
        continue;
      }
      if (firstOk > 0) {
        // 交换：把可用的那条换到第 1 位，其余保持相对顺序
        const arr = task.group.channels[task.channelIndex].urls;
        const picked = arr[firstOk];
        for (let k = firstOk; k > 0; k--) arr[k] = arr[k - 1];
        arr[0] = picked;
        stats.promoted++;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()));
  stats.elapsedMs = Date.now() - started;
  return { groups, stats };
}
