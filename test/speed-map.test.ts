import test from 'node:test';
import assert from 'node:assert/strict';
import type { Storage } from '../src/storage/interface';
import { saveSpeedMap, loadSpeedMap, pruneExpired } from '../src/core/channel-probe';
import type { ChannelSpeedEntry, ChannelSpeedMap } from '../src/core/types';

class MemStorage implements Storage {
  map = new Map<string, string>();
  async get(k: string): Promise<string | null> { return this.map.get(k) ?? null; }
  async put(k: string, v: string): Promise<void> { this.map.set(k, v); }
}

function entry(at: string, speedMs = 500): ChannelSpeedEntry {
  return { kind: 'm3u8', speedMs, probedAt: at, stage: 'segment' } as ChannelSpeedEntry;
}

test('saveSpeedMap merge：两个任务并发写互不吞掉（§2.3）', async () => {
  const s = new MemStorage();
  const t1 = new Date().toISOString();
  const t2 = new Date(Date.now() + 1000).toISOString();

  // 守夜写 A，独立测速写 B（各自 load 后全量写）
  await saveSpeedMap(s, { 'http://a/1': entry(t1) } as ChannelSpeedMap, { merge: true });
  await saveSpeedMap(s, { 'http://b/2': entry(t2) } as ChannelSpeedMap, { merge: true });

  const map = await loadSpeedMap(s);
  assert.ok(map['http://a/1'], 'A 不该被 B 的写入吞掉');
  assert.ok(map['http://b/2']);
});

test('saveSpeedMap merge：同一 URL 取 probedAt 更新的那条', async () => {
  const s = new MemStorage();
  const older = new Date(Date.now() - 60_000).toISOString();
  const newer = new Date().toISOString();

  await saveSpeedMap(s, { 'http://a/1': entry(newer, 700) } as ChannelSpeedMap, { merge: true });
  // 另一个任务拿着旧结论来写，不能把新结论盖回去
  await saveSpeedMap(s, { 'http://a/1': entry(older, 1200) } as ChannelSpeedMap, { merge: true });

  const map = await loadSpeedMap(s);
  assert.equal(map['http://a/1'].speedMs, 700);
});

test('saveSpeedMap 非 merge：全量替换（频道树里消失的 URL 要能淘汰）', async () => {
  const s = new MemStorage();
  const at = new Date().toISOString();
  await saveSpeedMap(s, { 'http://a/1': entry(at), 'http://b/2': entry(at) } as ChannelSpeedMap);
  await saveSpeedMap(s, { 'http://b/2': entry(at) } as ChannelSpeedMap);

  const map = await loadSpeedMap(s);
  assert.equal(map['http://a/1'], undefined);
  assert.ok(map['http://b/2']);
});

test('pruneExpired：超过 7 天的条目被裁掉，近期保留', () => {
  const at = new Date().toISOString();
  const old = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
  const map = { 'http://new/1': entry(at), 'http://old/2': entry(old) } as ChannelSpeedMap;
  const pruned = pruneExpired(map);
  assert.ok(pruned['http://new/1']);
  assert.equal(pruned['http://old/2'], undefined);
});
