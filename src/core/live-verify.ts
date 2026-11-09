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

export interface ReverifyOptions {
  /** 每个频道最多往后试几条，默认 3 */
  headCount?: number;
  /** 频道级并发，默认 24 */
  concurrency?: number;
  /** 同一域名同时最多几条，默认 4（单 IP 挂几百条的源很常见，别把它打崩） */
  perHost?: number;
}

export interface ReverifyStats {
  /** 复核过的频道数 */
  checked: number;
  /** 首位不通过、最终换掉的频道数 */
  promoted: number;
  /** 首位不通过但后面也没有可用源的频道数 */
  allDead: number;
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
  const started = Date.now();

  const stats: ReverifyStats = { checked: 0, promoted: 0, allDead: 0, requests: 0, elapsedMs: 0 };
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
    const prev = speedMap[url];
    speedMap[url] = {
      ...(prev || {}),
      speedMs: r.kind === 'fail' ? 0 : r.speedMs,
      kind: r.kind,
      probedAt: new Date().toISOString(),
      stage: r.stage,
      ...(r.note ? { note: r.note } : {}),
      ...(r.kind === 'fail'
        ? { fails: (prev?.fails ?? 0) + 1 }
        : { fails: 0 }),
    };
  };

  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < tasks.length) {
      const task = tasks[cursor++];
      const urls = task.urls;
      if (urls.length === 0) continue;
      stats.checked++;

      let firstOk = -1;
      for (let i = 0; i < urls.length; i++) {
        const bare = bareUrl(urls[i]);
        if (!bare) continue;
        const host = hostOf(bare);
        await acquire(gate, host, perHost);
        let r: Awaited<ReturnType<typeof probeUrlOnce>>;
        try {
          r = await probeUrlOnce(bare);
        } finally {
          release(gate, host);
        }
        applyResult(bare, r);
        if (r.kind !== 'fail') {
          firstOk = i;
          break;
        }
      }

      if (firstOk < 0) {
        stats.allDead++;
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
