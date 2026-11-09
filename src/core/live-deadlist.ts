// 直播死源黑名单
//
// 为什么需要它：频道树每次聚合都从源 txt 重新生成，只把死链从「本次输出」里删掉，
// 下次刷新又会回来。所以「清理死源」必须落盘成黑名单，才能真正长期生效。
//
// 自愈：测速侧一旦发现某个黑名单 URL 重新可用，会把它从名单里移除，
// 避免一次误判让好源永久消失。

import type { Storage } from '../storage/interface';
import { KV_LIVE_DEAD_URLS } from './config';
import { isProtectedUrl } from './channel-curation';

const MAX_ENTRIES = 300000;

export async function loadDeadUrls(storage: Storage): Promise<string[]> {
  const raw = await storage.get(KV_LIVE_DEAD_URLS);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((u) => typeof u === 'string') : [];
  } catch {
    return [];
  }
}

async function saveDeadUrls(storage: Storage, urls: string[]): Promise<void> {
  const unique = Array.from(new Set(urls)).slice(0, MAX_ENTRIES);
  await storage.put(KV_LIVE_DEAD_URLS, JSON.stringify(unique));
}

/** 追加一批死链（幂等）。受保护域名一律跳过，防止误杀重点频道的官方源。 */
export async function addDeadUrls(storage: Storage, urls: string[]): Promise<number> {
  if (urls.length === 0) return 0;
  const safe = urls.filter((u) => !isProtectedUrl(u));
  if (safe.length === 0) return 0;
  const existing = new Set(await loadDeadUrls(storage));
  const before = existing.size;
  for (const u of safe) existing.add(u);
  await saveDeadUrls(storage, Array.from(existing));
  return existing.size - before;
}

/**
 * 把受保护域名从黑名单里回捞出来（历史误判的补救）。
 * 老版本没有保护机制，「清理死源」曾把 nklive.nbs.cn 整段写进黑名单，
 * 导致南京地方台整组消失；这里在每次聚合前顺手清理一次。
 */
export async function purgeProtectedUrls(storage: Storage): Promise<number> {
  const existing = await loadDeadUrls(storage);
  if (existing.length === 0) return 0;
  const next = existing.filter((u) => !isProtectedUrl(u));
  const removed = existing.length - next.length;
  if (removed > 0) await saveDeadUrls(storage, next);
  return removed;
}

/** 把已恢复的 URL 移出黑名单（测速侧调用） */
export async function removeRecoveredUrls(storage: Storage, urls: string[]): Promise<number> {
  if (urls.length === 0) return 0;
  const existing = await loadDeadUrls(storage);
  if (existing.length === 0) return 0;
  const recovered = new Set(urls);
  const next = existing.filter((u) => !recovered.has(u));
  const removed = existing.length - next.length;
  if (removed > 0) await saveDeadUrls(storage, next);
  return removed;
}

export async function clearDeadUrls(storage: Storage): Promise<void> {
  await storage.put(KV_LIVE_DEAD_URLS, JSON.stringify([]));
}
