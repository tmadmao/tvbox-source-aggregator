// 跨频道重复源裁决
//
// 背景：同一个流地址会被不同直播源分别标成 CCTV5 和 CCTV5+（实测
// 223.112.114.228:50080/newlive/live/hls/180 同时出现在两台里）。
// 合并只做「频道内去重」，不做「跨频道归属」，结果同一路流进了两个台，
// 用户看到的就是「CCTV5 里播的是 CCTV5+」。
//
// 裁决规则（只在同一裸地址出现在多个频道时生效）：
//   1. 看有几个不同来源把它标成该频道，票多者得；
//   2. 票数相同且两个频道是「基础台 / + 变体」（CCTV5 vs CCTV5+）→ 归给 + 变体，
//      因为基础台的名字更常被源站随手乱写；
//   3. 票数相同且互不相关 → 无法判断，保留原样，不冒险删源。
//
// 只删「非归属频道」里的这一条 URL，不动频道本身。

import type { TVBoxLiveGroup, TVBoxLiveChannel } from './types';
import { bareUrl } from './live-url';

export interface ConflictRemoval {
  url: string;
  /** 被移出的频道名 */
  from: string;
  /** 归属频道名 */
  to: string;
}

function keyOf(name: string): string {
  return name.replace(/\s+/g, '').toUpperCase();
}

function sourceOf(raw: string): string {
  const i = raw.lastIndexOf('$');
  return i >= 0 ? raw.slice(i + 1) : '';
}

/** a 是否是 b 的「+ 变体」：CCTV5+ 之于 CCTV5 */
function isPlusVariant(a: string, b: string): boolean {
  return a.endsWith('+') && a.slice(0, -1) === b;
}

interface Ref {
  channel: TVBoxLiveChannel;
  raw: string;
  nameKey: string;
  source: string;
}

export function resolveCrossChannelConflicts(groups: TVBoxLiveGroup[]): ConflictRemoval[] {
  const byUrl = new Map<string, Ref[]>();

  for (const g of groups) {
    for (const ch of g.channels || []) {
      const nameKey = keyOf(ch.name);
      for (const raw of ch.urls || []) {
        const bare = bareUrl(raw);
        if (!bare) continue;
        const list = byUrl.get(bare) || [];
        list.push({ channel: ch, raw, nameKey, source: sourceOf(raw) });
        byUrl.set(bare, list);
      }
    }
  }

  const removals: ConflictRemoval[] = [];

  for (const [bare, refs] of byUrl) {
    const nameKeys = new Set(refs.map((r) => r.nameKey));
    if (nameKeys.size <= 1) continue;                 // 只有一个频道在用，正常

    // 每个频道拿到几张「来源票」
    const votes = new Map<string, Set<string>>();
    const display = new Map<string, string>();
    for (const r of refs) {
      const set = votes.get(r.nameKey) || new Set<string>();
      if (r.source) set.add(r.source);
      else set.add('__unknown__');
      votes.set(r.nameKey, set);
      display.set(r.nameKey, r.channel.name);
    }

    const ranked = [...votes.entries()]
      .map(([nameKey, sources]) => ({ nameKey, score: sources.size }))
      .sort((a, b) => b.score - a.score);
    const topScore = ranked[0]?.score ?? 0;
    const tied = ranked.filter((x) => x.score === topScore);

    let winner: string | undefined;
    if (tied.length === 1) {
      winner = tied[0].nameKey;
    } else {
      // 平票：CCTV5 vs CCTV5+ → 归 CCTV5+
      winner = tied.find((c) => tied.some((o) => isPlusVariant(c.nameKey, o.nameKey)))?.nameKey;
    }
    if (!winner) continue;

    for (const r of refs) {
      if (r.nameKey === winner) continue;
      const before = r.channel.urls.length;
      r.channel.urls = r.channel.urls.filter((u) => bareUrl(u) !== bare);
      if (r.channel.urls.length < before) {
        removals.push({
          url: bare,
          from: display.get(r.nameKey) || r.channel.name,
          to: display.get(winner) || winner,
        });
      }
    }
  }

  return removals;
}
