// 直播 URL 的统一处理：解析「url$源名」、拼装、按测速结果排序
//
// 抽成独立模块的原因：
//   1. `$源名` 的解析原来散落在 parseTxt / parseM3U / extractAllUrls 三处，
//      其中两处没有剥离，导致带后缀的 URL 直接去测速必然失败；
//   2. 排序规则（可用 > 未测 > 失败 > 死链）需要在「按源分开」和「全部合并」
//      两种输出模式下保持一致，写在 live-merger 里会各写一份。

import type { ChannelSpeedEntry, ChannelSpeedMap } from './types';
import { CHANNEL_DEAD_FAILS } from './config';
import { tierOf, scoreOf } from './source-health';

/** 健康分差距阈值：小于这个差距仍按延迟排，避免把「快 50ms」的稳定源换掉 */
const HEALTH_SCORE_GAP = 0.12;

export interface SplitResult {
  url: string;
  source: string;
}

/**
 * 拆出 `http://xxx$源A` 里的源名。
 * 只认「http(s)://...$名称」形态（名称不含空白和斜杠），避免误伤带 `$` 的正常 URL。
 */
export function splitUrlSource(raw: string, fallbackSource = ''): SplitResult {
  const i = raw.lastIndexOf('$');
  if (i > 0) {
    const head = raw.slice(0, i);
    const tail = raw.slice(i + 1);
    if (/^https?:\/\//i.test(head) && tail && !/[\s/]/.test(tail)) {
      return { url: head, source: tail };
    }
  }
  return { url: raw, source: fallbackSource };
}

/** 只要裸 URL（去掉 `$源名`），用于测速与去重 */
export function bareUrl(raw: string): string {
  return splitUrlSource(raw).url;
}

/** 拼回 TVBox 的 `url$源名` 形态 */
export function joinUrlSource(url: string, source: string): string {
  return source ? `${url}$${source}` : url;
}

/** 排序优先级：0 可用 / 1 未测 / 2 失败一次 / 3 确认死链 */
export const DEAD_RANK = 3;

/**
 * 死链档位：连续失败达到 CHANNEL_DEAD_FAILS 轮。
 * 死链只排到末尾，不删除 —— 误判时可以人工切回来。
 */
export function rankOf(entry: ChannelSpeedEntry | undefined): number {
  if (!entry) return 1;
  if (entry.kind !== 'fail') return 0;
  return (entry.fails ?? 1) >= CHANNEL_DEAD_FAILS ? DEAD_RANK : 2;
}

/** 按测速结果排序：先看健康档位，再看健康分，最后按中位延迟升序 */
export function compareBySpeed<T extends { url: string; sourceSpeedMs?: number }>(
  a: T,
  b: T,
  speedMap?: ChannelSpeedMap,
): number {
  const ea = speedMap?.[a.url];
  const eb = speedMap?.[b.url];
  const ra = rankOf(ea);
  const rb = rankOf(eb);
  if (ra !== rb) return ra - rb;

  if (ra === 0 && ea && eb) {
    // 健康分接入排序：连续掉线的源（tier 2）不该只因为这一次探得快点就排第一，
    // 电视端一挂就是几十秒黑屏，比慢 300ms 难受得多。
    const ta = tierOf(ea);
    const tb = tierOf(eb);
    if (ta !== tb) return ta - tb;

    const d = ea.speedMs - eb.speedMs;

    // 健康分差距明显时压过速度，差距小（同档同速）时仍按延迟排
    const sa = scoreOf(ea);
    const sb = scoreOf(eb);
    if (Math.abs(sa - sb) >= HEALTH_SCORE_GAP) return sb - sa;

    if (d !== 0) return d;
  }

  // 同档位降级：源级 speedMs（没有测速数据时至少保持稳定顺序）
  return (a.sourceSpeedMs ?? Infinity) - (b.sourceSpeedMs ?? Infinity);
}

/** 取 URL 的 host（小写），用于同域名判定；解析失败返回空串 */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * 域名去相关：保证前 headCount 条里同一 host 只出现一次。
 *
 * 为什么需要：实测 342 个多源频道里有 107 个（31%）前 3 条源指向同一个域名/IP，
 * 该域名一抖动，客户端会连着失败 3 次（按 5 秒超时就是白等 15 秒）。
 *
 * 做法是「补位」而不是重排：扫到重复 host 时，和后面第一条没用过的 host 交换，
 * 其余元素相对顺序完全不动 —— 所以原本的速度排序意图基本保留。
 */
export function diversifyByHost<T extends { url: string }>(items: T[], headCount = 3): T[] {
  if (items.length <= 1) return items;
  const out = items.slice();
  const limit = Math.min(headCount, out.length);
  const used = new Set<string>();

  for (let i = 0; i < limit; i++) {
    const host = hostOf(out[i].url);
    if (!host) continue;
    if (!used.has(host)) {
      used.add(host);
      continue;
    }
    // 当前位置的 host 已经在前几条里出现过，找后面第一条"没被用过"的源顶上
    let j = i + 1;
    for (; j < out.length; j++) {
      const h = hostOf(out[j].url);
      if (h && !used.has(h)) break;
    }
    if (j >= out.length) continue; // 全是同域名，无解，保持原序
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
    used.add(hostOf(out[i].url));
  }
  return out;
}

/**
 * 每个频道只保留前 topN 条源（「一键选优」的落地动作）。
 * 依据：1166 台里 792 台只有 1 条源，超过 6 条的仅 161 台 —— 裁到 topN 砍的是冗余，不是覆盖。
 */
export function trimGroupsToTopN<T extends { group?: string; channels?: Array<{ name: string; urls: string[] }> }>(
  groups: T[],
  topN: number,
): T[] {
  if (!Number.isFinite(topN) || topN <= 0) return groups;
  return groups.map((g) => ({
    ...g,
    channels: (g.channels || []).map((ch) => ({
      ...ch,
      urls: (ch.urls || []).slice(0, topN),
    })),
  }));
}
