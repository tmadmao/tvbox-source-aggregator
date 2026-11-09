// 探测专用网络隔离
//
// 为什么需要：全局 fetch 共用 undici 的连接池。测速一轮会上万次短连接，
// 池子被打散后，同一进程里的其它请求（下一轮聚合下载源、站点验活）会整批挂住——
// 实测过一次聚合卡在「站点验活」14 分钟不动，重启才恢复。
//
// 做法：探测走自己的 Agent，跑完 close()，把污染限制在这一轮之内。
// 生产依赖里没有 undici，但 esbuild 会把它打进 bundle，所以容器不用动。

import { Agent, fetch as undiciFetch } from 'undici';

type FetchInit = Parameters<typeof fetch>[1];

let dispatcher: Agent | null = null;

export interface ProbeNetOptions {
  /** 单连接池最大并发 */
  connections?: number;
  /** 连接复用时长（毫秒），探测场景不需要长连接 */
  keepAliveTimeoutMs?: number;
  /** 建连超时 */
  connectTimeoutMs?: number;
}

/** 开启探测专用连接池。重复调用会先关掉旧的。 */
export function startProbeNet(opts: ProbeNetOptions = {}): void {
  if (dispatcher) {
    dispatcher.close().catch(() => {});
    dispatcher = null;
  }
  dispatcher = new Agent({
    connections: opts.connections ?? 64,
    pipelining: 0,
    keepAliveTimeout: opts.keepAliveTimeoutMs ?? 1000,
    connect: { timeout: opts.connectTimeoutMs ?? 5000 },
  });
}

/** 关闭并释放。必须每轮结束后调用，否则等于没隔离。 */
export async function closeProbeNet(): Promise<void> {
  const d = dispatcher;
  dispatcher = null;
  if (d) await d.close().catch(() => {});
}

/** 探测请求统一入口：有专用池就用专用池，否则退回全局 fetch */
export function netFetch(input: string, init?: FetchInit): Promise<Response> {
  if (!dispatcher) return fetch(input, init);
  return undiciFetch(input, { ...(init as Record<string, unknown>), dispatcher } as never) as unknown as Promise<Response>;
}

/** 包一段批量探测：进来开池，出去必关 */
export async function withProbeNet<T>(fn: () => Promise<T>, opts?: ProbeNetOptions): Promise<T> {
  startProbeNet(opts);
  try {
    return await fn();
  } finally {
    await closeProbeNet();
  }
}
