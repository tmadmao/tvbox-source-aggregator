import test from 'node:test';
import assert from 'node:assert/strict';
import {
  gradeOf,
  arrangeSources,
  tierCoverage,
  buildGapReport,
  QUALITY_FAST_MS,
} from '../src/core/channel-tier';
import type { ChannelSpeedEntry, ChannelSpeedMap } from '../src/core/types';

function ok(url: string, speedMs = 800, patch: Partial<ChannelSpeedEntry> = {}): [string, ChannelSpeedEntry] {
  return [url, {
    speedMs,
    probedAt: new Date().toISOString(),
    kind: 'm3u8',
    stage: 'segment',
    okCount: 3,
    failCount: 0,
    history: '111',
    consecutiveFails: 0,
    ...patch,
  }];
}

function mapOf(...pairs: Array<[string, ChannelSpeedEntry]>): ChannelSpeedMap {
  return Object.fromEntries(pairs);
}

test('gradeOf：分片验证 + 快 = 稳', () => {
  const m = mapOf(ok('http://a/x.m3u8', 900));
  const q = gradeOf(m['http://a/x.m3u8']);
  assert.equal(q.grade, 0);
  assert.equal(q.verified, true);
  assert.equal(q.reason, 'verified');
});

test('gradeOf：死链 = 3，不参与保底', () => {
  const m = mapOf(['http://a/x.m3u8', {
    speedMs: 0, probedAt: new Date().toISOString(), kind: 'fail', fails: 2,
  }]);
  const q = gradeOf(m['http://a/x.m3u8']);
  assert.equal(q.grade, 3);
  assert.equal(q.verified, false);
});

test('gradeOf：单次失败只降级留观，不直接判死', () => {
  const m = mapOf(['http://a/x.m3u8', {
    speedMs: 0, probedAt: new Date().toISOString(), kind: 'fail', fails: 1,
  }]);
  const q = gradeOf(m['http://a/x.m3u8']);
  assert.equal(q.grade, 2);
  assert.equal(q.reason, 'failed-once');
});

test('gradeOf：只拿到清单、没验分片 = 未证实', () => {
  const m = mapOf(ok('http://a/x.m3u8', 800, { stage: 'playlist' }));
  assert.equal(gradeOf(m['http://a/x.m3u8']).reason, 'unverified');
  // L2 关闭时，清单可达即可算可用
  assert.equal(gradeOf(m['http://a/x.m3u8'], { requireSegment: false }).verified, true);
});

test('gradeOf：超过 4.5 秒必撞客户端 5 秒超时，不算保底', () => {
  const m = mapOf(ok('http://a/x.m3u8', 6000));
  const q = gradeOf(m['http://a/x.m3u8']);
  assert.equal(q.verified, false);
  assert.equal(q.reason, 'slow');
});

test('gradeOf：超过 6 小时 = 结论过期', () => {
  const old = new Date(Date.now() - 7 * 3600 * 1000).toISOString();
  const m = mapOf(ok('http://a/x.m3u8', 800, { probedAt: old }));
  assert.equal(gradeOf(m['http://a/x.m3u8']).reason, 'stale');
});

test('gradeOf：连续掉线的源降级，不占前排', () => {
  const m = mapOf(ok('http://a/x.m3u8', 700, { okCount: 1, failCount: 4, history: '10000', consecutiveFails: 2 }));
  assert.equal(gradeOf(m['http://a/x.m3u8']).reason, 'shaky');
});

test('arrangeSources：死链直接从输出里剔除', () => {
  const good = 'http://a/1$src';
  const dead = 'http://b/2$src';
  const m = mapOf(ok('http://a/1', 800), ['http://b/2', {
    speedMs: 0, probedAt: new Date().toISOString(), kind: 'fail', fails: 3,
  }]);
  const r = arrangeSources([dead, good], m, { quota: 2, cap: 8 });
  assert.deepEqual(r.urls, [good]);
  assert.equal(r.droppedDead, 1);
  assert.equal(r.verified, 1);
});

test('arrangeSources：前排优先不同域名', () => {
  const m = mapOf(ok('http://a/1', 500), ok('http://a/2', 600), ok('http://b/3', 1500));
  const r = arrangeSources(
    ['http://a/1$x', 'http://a/2$x', 'http://b/3$x'],
    m,
    { quota: 2, cap: 8 },
  );
  assert.deepEqual(r.urls.slice(0, 2), ['http://a/1$x', 'http://b/3$x']);
  assert.equal(r.distinctHosts, 2);
  assert.equal(r.gap, 0);
});

test('arrangeSources：不足配额时如实报 gap，不做假', () => {
  const m = mapOf(ok('http://a/1', 800));
  const r = arrangeSources(['http://a/1$x', 'http://b/2$x', 'http://c/3$x'], m, { quota: 3, cap: 8 });
  assert.equal(r.verified, 1);
  assert.equal(r.gap, 2);
  assert.equal(r.urls.length, 3);
});

test('arrangeSources：cap 生效，保留 $源名', () => {
  const pairs = [] as Array<[string, ChannelSpeedEntry]>;
  const urls: string[] = [];
  for (let i = 0; i < 5; i++) {
    pairs.push(ok('http://h' + i + '/x', 500 + i));
    urls.push('http://h' + i + '/x$源' + i);
  }
  const r = arrangeSources(urls, mapOf(...pairs), { quota: 2, cap: 3 });
  assert.equal(r.urls.length, 3);
  assert.ok(r.urls.every((u) => u.includes('$源')));
});

test('快线阈值是客户端 5 秒超时的一半', () => {
  assert.equal(QUALITY_FAST_MS, 2500);
});

test('tierCoverage / buildGapReport：按档位统计并按缺口排序', () => {
  const rows = [
    { group: '央视', name: 'CCTV1', tier: 'cctv' as const, verified: 6, quota: 6, pool: 10, hosts: 6 },
    { group: '央视', name: 'CCTV3', tier: 'cctv' as const, verified: 2, quota: 6, pool: 12, hosts: 2 },
    { group: '卫视', name: '湖南卫视', tier: 'satellite' as const, verified: 5, quota: 5, pool: 8, hosts: 5 },
    { group: '境内地方', name: '南京少儿', tier: 'local' as const, verified: 1, quota: 3, pool: 3, hosts: 1 },
  ];
  const cov = tierCoverage(rows, { cctv: 6, satellite: 5, local: 3, other: 2 });
  assert.deepEqual(cov.map((x) => [x.tier, x.met, x.channels]), [
    ['cctv', 1, 2], ['satellite', 1, 1], ['local', 0, 1], ['other', 0, 0],
  ]);
  const gaps = buildGapReport(rows);
  assert.equal(gaps.length, 2);
  assert.equal(gaps[0].name, 'CCTV3');       // 央视优先
  assert.equal(gaps[1].name, '南京少儿');
});
