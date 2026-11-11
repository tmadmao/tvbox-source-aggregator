import test from 'node:test';
import assert from 'node:assert/strict';
import { recordProbe, pushHistory, snapshotOf, HEALTH_HISTORY_LEN } from '../src/core/source-health';
import { gradeOf } from '../src/core/channel-tier';
import type { ChannelSpeedMap } from '../src/core/types';

test('recordProbe：成功写入健康字段（守夜与全量测速共用）', () => {
  const map: ChannelSpeedMap = {};
  const e = recordProbe(map, 'http://a/1', { kind: 'm3u8', speedMs: 800, stage: 'segment' }, '2026-11-11T10:00:00.000Z');
  assert.equal(e.kind, 'm3u8');
  assert.equal(e.okCount, 1);
  assert.equal(e.failCount, 0);
  assert.equal(e.consecutiveFails, 0);
  assert.equal(e.lastOkAt, '2026-11-11T10:00:00.000Z');
  assert.equal(e.history, '1');
  assert.equal(map['http://a/1'], e);
});

test('recordProbe：失败累计 consecutiveFails，并记录首次失败时间', () => {
  const map: ChannelSpeedMap = {};
  recordProbe(map, 'http://a/1', { kind: 'm3u8', speedMs: 800, stage: 'segment' }, '2026-11-11T10:00:00.000Z');
  const f1 = recordProbe(map, 'http://a/1', { kind: 'fail', speedMs: 0, note: 'timeout' }, '2026-11-11T11:00:00.000Z');
  assert.equal(f1.consecutiveFails, 1);
  assert.equal(f1.firstFailAt, '2026-11-11T11:00:00.000Z');
  assert.equal(f1.history, '10');
  // 单次失败：只降级留观，不判死
  assert.equal(gradeOf(f1).grade, 2);

  const f2 = recordProbe(map, 'http://a/1', { kind: 'fail', speedMs: 0 }, '2026-11-11T12:00:00.000Z');
  assert.equal(f2.consecutiveFails, 2);
  assert.equal(f2.firstFailAt, '2026-11-11T11:00:00.000Z');
  assert.equal(gradeOf(f2).grade, 3);
});

test('recordProbe：恢复后清空失败计数与 firstFailAt', () => {
  const map: ChannelSpeedMap = {};
  recordProbe(map, 'http://a/1', { kind: 'fail', speedMs: 0 }, '2026-11-11T10:00:00.000Z');
  recordProbe(map, 'http://a/1', { kind: 'fail', speedMs: 0 }, '2026-11-11T11:00:00.000Z');
  const ok = recordProbe(map, 'http://a/1', { kind: 'm3u8', speedMs: 600, stage: 'segment' }, '2026-11-11T12:00:00.000Z');
  assert.equal(ok.consecutiveFails, 0);
  assert.equal(ok.firstFailAt, undefined);
  // 可用率是累计的：刚恢复一次还到不了 0.6，需要连续几次成功才重新算「可播」。
  // 这正是守夜会「下一轮继续重试」的原因，不是一次通了就永久放行。
  recordProbe(map, 'http://a/1', { kind: 'm3u8', speedMs: 620, stage: 'segment' }, '2026-11-11T13:00:00.000Z');
  const ok2 = recordProbe(map, 'http://a/1', { kind: 'm3u8', speedMs: 640, stage: 'segment' }, '2026-11-11T14:00:00.000Z');
  assert.equal(gradeOf(ok2).verified, true);
});

test('pushHistory：位图只保留最近 12 轮', () => {
  let h = '';
  for (let i = 0; i < 20; i++) h = pushHistory(h, i % 2 === 0);
  assert.equal(h.length, HEALTH_HISTORY_LEN);
});

test('snapshotOf：可用率/评分/档位来自同一条历史', () => {
  const map: ChannelSpeedMap = {};
  recordProbe(map, 'http://a/1', { kind: 'm3u8', speedMs: 500, stage: 'segment' });
  const s = snapshotOf(map['http://a/1']);
  assert.equal(s.tier, 0);
  assert.ok(s.score > 0.5);
  assert.equal(s.samples, 1);
});
