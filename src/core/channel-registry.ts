// 频道目录（固化框架的地基）
//
// 目标：让「频道」成为长期存在的实体，而不是每次聚合时按名字临时算出来的 key。
// 有了稳定的 channel_id，才能把一条源的历史挂上去，才谈得上健康监察。
//
// 存储：KV 单 key（与现有 speed map 同构），超出 5MB 再迁 SQLite 表。

import type { Storage } from '../storage/interface';
import type { TVBoxLiveGroup } from './types';
import { KV_CHANNEL_REGISTRY } from './config';

export interface ChannelRecord {
  id: string;             // 稳定 id，一旦分配不再变
  name: string;           // 当前正式名
  group: string;          // 所属标准分组
  aliases: string[];      // 历史写法（改名后旧名进这里）
  enabled: boolean;       // 删除只置 false，便于回滚
  createdAt: string;
}

export interface ChannelRegistry {
  version: number;
  initializedAt: string;
  channels: Record<string, ChannelRecord>;   // id -> 记录
  byName: Record<string, string>;            // 归一化名字 -> id
}

/** 名字归一：只做「比较用」的粗归一，展示仍用原名 */
export function normalizeKey(raw: string): string {
  return String(raw || '')
    .trim()
    .replace(/\s+/g, '')
    .replace(/[（(]/g, '(')
    .replace(/[）)]/g, ')')
    .toUpperCase();
}

function hash6(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36).slice(0, 6);
}

/**
 * id 规则（v1）：
 *   CCTV1 / CCTV-1 / CCTV1综合 → cctv-1
 *   CCTV5+ → cctv-5plus；CCTV4K → cctv-4k
 *   其余按 前缀 + 名字哈希，保证稳定且可读性够用
 * 拼音命名（sat-hunan）留给后续填，不影响 id 的稳定性。
 */
export function makeChannelId(group: string, name: string): string {
  const raw = String(name || '').trim();
  const cctv = raw.match(/^CCTV[-_\s]?(\d{1,2})\s*(\+?)\s*(4K|8K)?/i);
  if (cctv) {
    const n = parseInt(cctv[1], 10);
    if (n >= 1 && n <= 20) {
      const plus = cctv[2] === '+' ? 'plus' : '';
      const k = cctv[3] ? cctv[3].toLowerCase() : '';
      return `cctv-${n}${plus}${k}`;
    }
  }
  const g = /卫视|衛視/.test(group) ? 'sat'
    : /地方/.test(group) ? 'local'
      : /港澳|台湾/.test(group) ? 'hmt'
        : /海外|国际/.test(group) ? 'intl'
          : 'ch';
  return `${g}-${hash6(normalizeKey(name))}`;
}

export function emptyRegistry(): ChannelRegistry {
  return { version: 1, initializedAt: new Date().toISOString(), channels: {}, byName: {} };
}

export async function loadRegistry(storage: Storage): Promise<ChannelRegistry> {
  const raw = await storage.get(KV_CHANNEL_REGISTRY);
  if (!raw) return emptyRegistry();
  try {
    const parsed = JSON.parse(raw) as ChannelRegistry;
    if (parsed && parsed.version === 1 && parsed.channels && parsed.byName) return parsed;
  } catch {
    /* ignore */
  }
  return emptyRegistry();
}

export async function saveRegistry(storage: Storage, reg: ChannelRegistry): Promise<void> {
  await storage.put(KV_CHANNEL_REGISTRY, JSON.stringify(reg));
}

/**
 * 用当前频道树初始化/补齐目录。
 * - 已存在的 id：只补别名，不覆盖 name（避免把人工改名冲掉）
 * - 新出现的频道：建槽
 * - 返回新增/更新数量，便于日志
 */
export function upsertFromGroups(
  reg: ChannelRegistry,
  groups: TVBoxLiveGroup[],
): { added: number; renamed: number } {
  let added = 0;
  let renamed = 0;

  for (const group of groups) {
    for (const ch of group.channels || []) {
      const name = String(ch.name || '').trim();
      if (!name) continue;
      const key = normalizeKey(name);
      const existingId = reg.byName[key];

      if (existingId && reg.channels[existingId]) {
        const rec = reg.channels[existingId];
        // 分组可能因归并调整，跟随最新
        rec.group = group.group;
        continue;
      }

      const id = makeChannelId(group.group, name);
      if (reg.channels[id]) {
        // id 撞了但名字不同 → 当作同一频道的另一种写法
        if (!reg.channels[id].aliases.includes(name)) reg.channels[id].aliases.push(name);
        reg.byName[key] = id;
        renamed++;
        continue;
      }

      reg.channels[id] = {
        id, name, group: group.group,
        aliases: [], enabled: true,
        createdAt: new Date().toISOString(),
      };
      reg.byName[key] = id;
      added++;
    }
  }
  return { added, renamed };
}

/** 名字 → channel_id；未收录返回 null */
export function resolveChannelId(reg: ChannelRegistry, name: string): string | null {
  const key = normalizeKey(name);
  const hit = reg.byName[key];
  if (hit && reg.channels[hit]) return hit;
  // 别名兜底
  for (const rec of Object.values(reg.channels)) {
    if (rec.aliases.some((a) => normalizeKey(a) === key)) return rec.id;
  }
  return null;
}

/** 当前频道树里尚未收录的名字（未识别队列） */
export function findUnmapped(reg: ChannelRegistry, groups: TVBoxLiveGroup[]): Array<{ name: string; group: string; urls: number }> {
  const out: Array<{ name: string; group: string; urls: number }> = [];
  for (const group of groups) {
    for (const ch of group.channels || []) {
      const name = String(ch.name || '').trim();
      if (!name) continue;
      if (resolveChannelId(reg, name)) continue;
      out.push({ name, group: group.group, urls: (ch.urls || []).length });
    }
  }
  return out;
}

/** 人工确认：把一个名字归入已有 id（写入别名，以后不再判断） */
export function assignAlias(reg: ChannelRegistry, name: string, channelId: string): boolean {
  const rec = reg.channels[channelId];
  if (!rec) return false;
  const key = normalizeKey(name);
  if (reg.byName[key] === channelId) return true;
  reg.byName[key] = channelId;
  if (normalizeKey(rec.name) !== key && !rec.aliases.some((a) => normalizeKey(a) === key)) {
    rec.aliases.push(name);
  }
  return true;
}
