import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hostSampleQuota,
  sampleHostUrls,
  applyHostOutcomes,
  isHostCondemned,
  hostStats,
  HOST_SAMPLE_N,
  HOST_SUSPECT_RETEST_MS,
  HOST_DEAD_RETEST_MS,
  HOST_DEAD_AFTER_MS,
  type HostRow,
} from '../src/core/host-health';

const now = 1_700_000_000_000;

test('hostSampleQuota：未入账 = 不限制，未到周期 = 整域跳过', () => {
  assert.equal(hostSampleQuota(undefined, now), -1);
  assert.equal(hostSampleQuota({ host: 'a', state: 1, since: now, probedAt: now, urls: 10, ok: 0 }, now), 0);
  assert.equal(hostSampleQuota({
    host: 'a', state: 1, since: now, probedAt: now - HOST_SUSPECT_RETEST_MS - 1, urls: 10, ok: 0,
  }, now), HOST_SAMPLE_N);
  assert.equal(hostSampleQuota({
    host: 'a', state: 2, since: now, probedAt: now - HOST_DEAD_RETEST_MS - 1, urls: 10, ok: 0,
  }, now), HOST_SAMPLE_N);
});

test('sampleHostUrls：按哈希均匀抽，不取前 N 条', () => {
  const urls = Array.from({ length: 30 }, (_, i) => 'http://a/' + i + '.m3u8');
  const a = sampleHostUrls(urls, 3);
  const b = sampleHostUrls(urls, 3);
  assert.equal(a.length, 3);
  assert.deepEqual(a, b);                 // 稳定
  assert.notDeepEqual(a, urls.slice(0, 3));
});

test('applyHostOutcomes：抽样全失败先记可疑，满 30 天才判死', () => {
  const rows = new Map<string, HostRow>();
  const r1 = applyHostOutcomes(rows, [{ host: 'a', probed: 3, ok: 0 }], now);
  assert.equal(r1.marked, 1);
  assert.equal(rows.get('a')!.state, 1);

  const r2 = applyHostOutcomes(rows, [{ host: 'a', probed: 3, ok: 0 }], now + HOST_DEAD_AFTER_MS + 1);
  assert.equal(r2.condemned, 1);
  assert.equal(rows.get('a')!.state, 2);
});

test('applyHostOutcomes：任一条通即撤销域名结论', () => {
  const rows = new Map<string, HostRow>([
    ['a', { host: 'a', state: 2, since: now, probedAt: now, urls: 100, ok: 0 }],
  ]);
  const r = applyHostOutcomes(rows, [{ host: 'a', probed: 3, ok: 1 }], now);
  assert.equal(r.revived, 1);
  assert.equal(rows.has('a'), false);
});

test('applyHostOutcomes：只测 1 条就失败不下结论', () => {
  const rows = new Map<string, HostRow>();
  const r = applyHostOutcomes(rows, [{ host: 'a', probed: 1, ok: 0 }], now);
  assert.equal(r.marked, 0);
  assert.equal(rows.size, 0);
});

test('isHostCondemned：判死域名名下整片不输出', () => {
  const rows = new Map<string, HostRow>([
    ['dead.example', { host: 'dead.example', state: 2, since: now, probedAt: now, urls: 5, ok: 0 }],
    ['ok.example', { host: 'ok.example', state: 1, since: now, probedAt: now, urls: 5, ok: 1 }],
  ]);
  assert.equal(isHostCondemned(rows, 'http://dead.example/x.m3u8'), true);
  assert.equal(isHostCondemned(rows, 'http://ok.example/x.m3u8'), false);
  assert.equal(isHostCondemned(rows, 'not a url'), false);
});

test('hostStats：统计可疑/判死/到期数', () => {
  const rows: HostRow[] = [
    { host: 'a', state: 1, since: now, probedAt: 0, urls: 10, ok: 0 },
    { host: 'b', state: 2, since: now, probedAt: now, urls: 20, ok: 0 },
  ];
  const s = hostStats(rows, now);
  assert.equal(s.total, 2);
  assert.equal(s.suspect, 1);
  assert.equal(s.condemned, 1);
  assert.equal(s.coveredUrls, 30);
  assert.equal(s.due, 1);
});
