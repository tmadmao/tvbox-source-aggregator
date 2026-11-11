// 站点跳过名单（「保留链接、但不再探测」）
//
// 背景：不可达剔除目前只有「删除」一种结果，靠黑名单实现。
// 但有些站点只是临时抽风，或者本机网络到不了、电视上其实能用。
// 保留模式 = 站点继续留在输出里，只是每次聚合不再浪费 5 秒超时去探测它。

import type { Storage } from '../storage/interface';
import type { TVBoxSite } from './types';
import { KV_SITE_SKIP_LIST } from './config';
import { computeFingerprints } from './blacklist';

const MAX_ENTRIES = 20000;

export async function loadSkipList(storage: Storage): Promise<string[]> {
  const raw = await storage.get(KV_SITE_SKIP_LIST);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export async function saveSkipList(storage: Storage, list: string[]): Promise<void> {
  const unique = Array.from(new Set(list)).slice(0, MAX_ENTRIES);
  await storage.put(KV_SITE_SKIP_LIST, JSON.stringify(unique));
}

export async function addSkipList(storage: Storage, fingerprints: string[]): Promise<number> {
  if (fingerprints.length === 0) return 0;
  const existing = new Set(await loadSkipList(storage));
  const before = existing.size;
  for (const fp of fingerprints) existing.add(fp);
  await saveSkipList(storage, Array.from(existing));
  return existing.size - before;
}

export async function clearSkipList(storage: Storage): Promise<void> {
  await storage.put(KV_SITE_SKIP_LIST, JSON.stringify([]));
}

/** 批量算指纹，返回 Set 供过滤（key → fingerprint 的反向视图，供一处计算多处复用） */
export async function fingerprintSet(sites: TVBoxSite[]): Promise<Map<string, string>> {
  const map = new Map<string, string>(); // fingerprint → site.key
  for (const [key, fp] of await computeFingerprints(sites)) {
    // siteFpKey 形如 "<key>\u0000<api>"，这里只需要 key 供展示
    map.set(fp, key.split('\u0000')[0]);
  }
  return map;
}
