import test from 'node:test';
import assert from 'node:assert/strict';
import type { Storage } from '../src/storage/interface';
import {
  addDeadUrls,
  removeRecoveredUrls,
  condemnExpired,
  ledgerStats,
  nextRetestAt,
  loadDeadRows,
  saveDeadRows,
  DEAD_RETEST_MS,
  CONDEMNED_RETEST_MS,
  CONDEMN_AFTER_MS,
  type DeadRow,
} from '../src/core/live-deadlist';

class MemStorage implements Storage {
  map = new Map<string, string>();
  async get(k: string): Promise<string | null> { return this.map.get(k) ?? null; }
  async put(k: string, v: string): Promise<void> { this.map.set(k, v); }
}

const URLS_KEY = 'live_dead_urls';

test('loadDeadRows：兼容 v1 字符串数组', async () => {
  const s = new MemStorage();
  await s.put(URLS_KEY, JSON.stringify(['http://a/1', 'http://b/2']));
  const rows = await loadDeadRows(s);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].state, 1);
  assert.equal(rows[0].since, 0);
});

test('addDeadUrls：幂等，且不重置死亡起点', async () => {
  const s = new MemStorage();
  const now = 1_700_000_000_000;
  assert.equal(await addDeadUrls(s, ['http://a/1'], now), 1);
  assert.equal(await addDeadUrls(s, ['http://a/1'], now + 10_000), 0);
  const rows = await loadDeadRows(s);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].since, now);
});

test('addDeadUrls：受保护域名永不入库（南京广电官方源）', async () => {
  const s = new MemStorage();
  const added = await addDeadUrls(s, ['http://nklive.nbs.cn/live/1.m3u8', 'http://a/1']);
  assert.equal(added, 1);
  const rows = await loadDeadRows(s);
  assert.deepEqual(rows.map((r) => r.url), ['http://a/1']);
});

test('removeRecoveredUrls：恢复即出档', async () => {
  const s = new MemStorage();
  await addDeadUrls(s, ['http://a/1', 'http://b/2']);
  assert.equal(await removeRecoveredUrls(s, ['http://a/1']), 1);
  const rows = await loadDeadRows(s);
  assert.deepEqual(rows.map((r) => r.url), ['http://b/2']);
});

test('condemnExpired：死满 30 天才转判死，且不删除', async () => {
  const s = new MemStorage();
  const now = 1_700_000_000_000;
  const rows: DeadRow[] = [
    { url: 'http://old/1', state: 1, since: now - CONDEMN_AFTER_MS - 1000, probedAt: now },
    { url: 'http://new/2', state: 1, since: now - 1000, probedAt: now },
  ];
  await saveDeadRows(s, rows);
  const r = await condemnExpired(s, () => true, now);
  assert.equal(r.promoted, 1);
  const after = await loadDeadRows(s);
  assert.equal(after.length, 2);
  assert.equal(after.find((x) => x.url === 'http://old/1')!.state, 2);
  assert.equal(after.find((x) => x.url === 'http://new/2')!.state, 1);
});

test('condemnExpired：已经复活的不判死', async () => {
  const s = new MemStorage();
  const now = 1_700_000_000_000;
  await saveDeadRows(s, [
    { url: 'http://old/1', state: 1, since: now - CONDEMN_AFTER_MS - 1000, probedAt: now },
  ]);
  const r = await condemnExpired(s, () => false, now);
  assert.equal(r.promoted, 0);
});

test('ledgerStats：按状态与回测周期统计', () => {
  const now = 1_700_000_000_000;
  const stats = ledgerStats([
    { url: 'a', state: 1, since: now, probedAt: 0 },
    { url: 'b', state: 1, since: 0, probedAt: now },
    { url: 'c', state: 2, since: now, probedAt: 0 },
  ], now);
  assert.equal(stats.total, 3);
  assert.equal(stats.warm, 2);
  assert.equal(stats.condemned, 1);
  assert.equal(stats.unknownAge, 1);
  assert.equal(stats.dueWarm, 1);
  assert.equal(stats.dueCondemned, 1);
});

test('nextRetestAt：待观察 7 天、判死 30 天', () => {
  assert.equal(nextRetestAt({ url: 'a', state: 1, since: 0, probedAt: 1000 }), 1000 + DEAD_RETEST_MS);
  assert.equal(nextRetestAt({ url: 'a', state: 2, since: 0, probedAt: 1000 }), 1000 + CONDEMNED_RETEST_MS);
});
