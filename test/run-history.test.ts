import test from 'node:test';
import assert from 'node:assert/strict';
import {
  pruneRuns,
  closeStaleRunning,
  summarizeRuns,
  beginRun,
  finishRun,
  loadRunHistory,
  RUN_STALE_MS,
  type RunRecord,
} from '../src/core/run-history';
import type { Storage } from '../src/storage/interface';

class MemStorage implements Storage {
  map = new Map<string, string>();
  async get(k: string): Promise<string | null> { return this.map.get(k) ?? null; }
  async put(k: string, v: string): Promise<void> { this.map.set(k, v); }
}

function run(iso: string, status: RunRecord['status'], patch: Partial<RunRecord> = {}): RunRecord {
  return {
    id: iso + '-' + status,
    kind: 'aggregate',
    trigger: 'cron',
    startedAt: iso,
    finishedAt: iso,
    status,
    durationMs: 60_000,
    ...patch,
  };
}

test('pruneRuns：只留 7 天内的记录', () => {
  const now = Date.parse('2026-11-11T12:00:00+08:00');
  const runs = [
    run('2026-11-01T05:00:00+08:00', 'success'),
    run('2026-11-10T05:00:00+08:00', 'success'),
  ];
  const kept = pruneRuns(runs, now);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].startedAt, '2026-11-10T05:00:00+08:00');
});

test('closeStaleRunning：进程被杀留下的 running 自动收尾', () => {
  const now = Date.parse('2026-11-11T12:00:00+08:00');
  const runs = [
    run('2026-11-11T07:00:00+08:00', 'running'),
    run('2026-11-11T11:30:00+08:00', 'running'),
  ];
  const closed = closeStaleRunning(runs, now);
  assert.equal(closed[0].status, 'failed');
  assert.match(closed[0].error || '', /进程中断/);
  assert.equal(closed[1].status, 'running');   // 还在合理执行时间内
});

test('summarizeRuns：超过 26 小时没成功 = 漏跑，并统计连续失败', () => {
  const now = Date.parse('2026-11-11T12:00:00+08:00');
  const runs = [
    run('2026-11-10T05:00:00+08:00', 'success'),
    run('2026-11-11T05:00:00+08:00', 'failed'),
    run('2026-11-11T07:00:00+08:00', 'timeout'),
  ];
  const s = summarizeRuns(runs, now, 'Asia/Shanghai');
  assert.equal(s.stale, true);
  assert.ok(s.staleHours >= 30);
  assert.equal(s.consecutiveFailures, 2);
  assert.equal(s.today.total, 2);
  assert.equal(s.today.failed, 2);
  assert.equal(s.lastSuccess!.startedAt, '2026-11-10T05:00:00+08:00');

  const daily = s.daily;
  assert.equal(daily.length, 7);
  assert.equal(daily[daily.length - 1].status, 'failed');
  assert.equal(daily[daily.length - 2].status, 'success');
});

test('summarizeRuns：今晨成功则不告警', () => {
  const now = Date.parse('2026-11-11T12:00:00+08:00');
  const runs = [
    run('2026-11-10T05:00:00+08:00', 'success'),
    run('2026-11-11T05:02:00+08:00', 'success'),
  ];
  const s = summarizeRuns(runs, now, 'Asia/Shanghai');
  assert.equal(s.stale, false);
  assert.equal(s.consecutiveFailures, 0);
  assert.equal(s.today.success, 1);
});

test('RUN_STALE_MS 是 26 小时', () => {
  assert.equal(RUN_STALE_MS, 26 * 3600 * 1000);
});

test('beginRun / finishRun：写入、收尾、保留产出统计', async () => {
  const s = new MemStorage();
  const rec = await beginRun(s, 'aggregate', 'cron');
  assert.equal(rec.status, 'running');
  assert.equal(rec.trigger, 'cron');

  const done = await finishRun(s, rec.id, {
    status: 'success',
    stats: { channels: 769, urls: 1866 },
  });
  assert.equal(done!.status, 'success');
  assert.equal(done!.stats!.channels, 769);
  assert.ok((done!.durationMs ?? -1) >= 0);
  assert.ok(!!done!.finishedAt);

  const runs = await loadRunHistory(s);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'success');
});

test('finishRun：id 不存在时返回 null，不抛错', async () => {
  const s = new MemStorage();
  assert.equal(await finishRun(s, 'missing', { status: 'failed' }), null);
});
