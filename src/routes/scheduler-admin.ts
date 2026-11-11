// 调度执行历史 / 告警 / 质量保障 后台接口
//
// 这三块是同一类「运维可观测性」：回答「昨天跑没跑」「失败了有没有人知道」
// 「央视/卫视到底几条能播」。放在一个路由文件里，避免再开一堆挂载点。

import type { Hono } from 'hono';
import type { Storage } from '../storage/interface';
import type { AppConfig } from '../core/types';
import { loadRunHistory, summarizeRuns, pruneRuns } from '../core/run-history';
import { loadAlertConfig, saveAlertConfig, sendAlert, normalizeAlertConfig } from '../core/alerts';
import {
  KV_LIVE_QUALITY_GAP, KV_LIVE_QUALITY_GUARANTEE, KV_RUN_HISTORY,
  KV_LIVE_GUARD_ENABLED, KV_LIVE_GUARD_REPORT, KV_LIVE_GUARD_STATE,
} from '../core/config';

function verifyAdmin(request: Request, config: AppConfig): boolean {
  const token = config.adminToken;
  if (!token) return false;
  return request.headers.get('Authorization') === `Bearer ${token}`;
}

export interface SchedulerRouteDeps {
  storage: Storage;
  config: AppConfig;
  isSyncing?: () => boolean;
}

export function mountSchedulerRoutes(app: Hono, deps: SchedulerRouteDeps): void {
  const { storage, config, isSyncing } = deps;

  // GET /admin/run-history — 最近 7 天的调度执行记录 + 汇总
  app.get('/admin/run-history', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    const runs = await loadRunHistory(storage);
    const summary = summarizeRuns(runs);
    const limit = Math.max(1, Math.min(200, Number(c.req.query('limit')) || 40));
    const recent = [...runs]
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
      .slice(0, limit);
    return c.json({ summary, runs: recent, total: runs.length });
  });

  // DELETE /admin/run-history — 清空（排查完历史噪音后用）
  app.delete('/admin/run-history', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    await storage.put(KV_RUN_HISTORY, JSON.stringify(pruneRuns([], Date.now())));
    return c.json({ success: true });
  });

  // GET / PUT /admin/alert-config — 告警通道
  app.get('/admin/alert-config', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    return c.json(await loadAlertConfig(storage));
  });

  app.put('/admin/alert-config', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }
    const cfg = await saveAlertConfig(storage, normalizeAlertConfig(body));
    return c.json({ success: true, config: cfg });
  });

  // POST /admin/alert-config/test — 立刻发一条测试（跳过去重）
  app.post('/admin/alert-config/test', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    const cfg = await loadAlertConfig(storage);
    const delivery = await sendAlert(storage, cfg, {
      key: 'test',
      level: 'info',
      title: '【IPTV】告警通道测试',
      text: `这是一条测试消息，发送于 ${new Date().toISOString()}。收到即代表通道可用。`,
    }, { ignoreDedupe: true });
    return c.json({ success: delivery.sent, delivery });
  });

  // GET /admin/quality-gap — 最近一次分级质量保障的缺口报表
  app.get('/admin/quality-gap', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    const [raw, enabled, guardRaw, guardEnabled] = await Promise.all([
      storage.get(KV_LIVE_QUALITY_GAP),
      storage.get(KV_LIVE_QUALITY_GUARANTEE),
      storage.get(KV_LIVE_GUARD_REPORT),
      storage.get(KV_LIVE_GUARD_ENABLED),
    ]);
    let report: unknown = null;
    let guard: unknown = null;
    if (raw) {
      try { report = JSON.parse(raw); } catch { report = null; }
    }
    if (guardRaw) {
      try { guard = JSON.parse(guardRaw); } catch { guard = null; }
    }
    return c.json({
      enabled: enabled !== 'false',
      report,
      guardEnabled: guardEnabled !== 'false',
      guard,
    });
  });

  // GET / PUT /admin/quality-guard — 全自动守夜开关 + 最近一次结果
  app.get('/admin/quality-guard', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    const [enabled, reportRaw, stateRaw] = await Promise.all([
      storage.get(KV_LIVE_GUARD_ENABLED),
      storage.get(KV_LIVE_GUARD_REPORT),
      storage.get(KV_LIVE_GUARD_STATE),
    ]);
    let report: unknown = null;
    let state: unknown = null;
    try { report = reportRaw ? JSON.parse(reportRaw) : null; } catch { /* ignore */ }
    try { state = stateRaw ? JSON.parse(stateRaw) : null; } catch { /* ignore */ }
    return c.json({ enabled: enabled !== 'false', report, state });
  });

  app.put('/admin/quality-guard', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    const body = await c.req.json<{ enabled?: boolean }>();
    if (typeof body.enabled !== 'boolean') return c.json({ error: 'enabled must be boolean' }, 400);
    await storage.put(KV_LIVE_GUARD_ENABLED, body.enabled ? 'true' : 'false');
    return c.json({ success: true, enabled: body.enabled });
  });

  // POST /admin/quality-guard/run — 立即自检一次（不等整点）
  app.post('/admin/quality-guard/run', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    if (isSyncing && isSyncing()) return c.json({ success: false, error: '聚合进行中，稍后再试' }, 409);
    const { runQualityGuard } = await import('../core/quality-guard');
    const { withProbeNet } = await import('../core/probe-net');
    const result = await withProbeNet(() => runQualityGuard(storage));
    return c.json({ success: true, result });
  });

  // PUT /admin/quality-guarantee — 质量保障总开关
  app.put('/admin/quality-guarantee', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    const body = await c.req.json<{ enabled?: boolean }>();
    if (typeof body.enabled !== 'boolean') return c.json({ error: 'enabled must be boolean' }, 400);
    await storage.put(KV_LIVE_QUALITY_GUARANTEE, body.enabled ? 'true' : 'false');
    return c.json({ success: true, enabled: body.enabled });
  });
}
