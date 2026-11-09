// 源健康接口（顶替 MacCMS 入口的那一屏）
//
// 框架层：概览、按域名聚合、失败原因分布。判定与打分在 core/source-health.ts，
// 这里只负责读出来、排好序。

import type { Hono } from 'hono';
import type { Storage } from '../storage/interface';
import type { AppConfig, ChannelSpeedMap } from '../core/types';
import { loadSpeedMap } from '../core/channel-probe';
import { domainSummary, availabilityOf } from '../core/source-health';

function verifyAdmin(request: Request, config: AppConfig): boolean {
  const token = config.adminToken;
  if (!token) return false;
  return request.headers.get('Authorization') === `Bearer ${token}`;
}

export interface HealthRouteDeps {
  storage: Storage;
  config: AppConfig;
}

export function mountHealthRoutes(app: Hono, deps: HealthRouteDeps): void {
  const { storage, config } = deps;

  // GET /admin/health/summary — 顶部概览
  app.get('/admin/health/summary', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);

    const map: ChannelSpeedMap = await loadSpeedMap(storage);
    const entries = Object.values(map);
    const total = entries.length;
    let ok = 0;
    let isolated = 0;   // 连续失败 ≥2，仍在输出里但不参与优先排序
    let lastProbedAt = '';

    for (const e of entries) {
      if (e.kind !== 'fail') ok++;
      else if ((e.consecutiveFails ?? e.fails ?? 0) >= 2) isolated++;
      if (e.probedAt && e.probedAt > lastProbedAt) lastProbedAt = e.probedAt;
    }

    const domains = domainSummary(map);
    return c.json({
      total,
      ok,
      okRate: total ? ok / total : 0,
      dead: total - ok,
      isolated,
      domains: domains.length,
      avgAvailability: entries.length
        ? entries.reduce((n, e) => n + availabilityOf(e), 0) / entries.length
        : 0,
      lastProbedAt,
    });
  });

  // GET /admin/health/domains — 按域名聚合（单 IP 挂几百条的源是主要瓶颈）
  app.get('/admin/health/domains', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    const limit = Math.max(1, Math.min(500, Number(c.req.query('limit')) || 60));
    const map: ChannelSpeedMap = await loadSpeedMap(storage);
    return c.json(domainSummary(map).slice(0, limit));
  });

  // GET /admin/health/reasons — 失败原因分布（按 note / 状态归类）
  app.get('/admin/health/reasons', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    const map: ChannelSpeedMap = await loadSpeedMap(storage);
    const tally: Record<string, number> = {};
    for (const e of Object.values(map)) {
      if (e.kind !== 'fail') continue;
      const key = e.note || (e.stage === 'segment' ? '分片不可用' : '不可达');
      tally[key] = (tally[key] || 0) + 1;
    }
    return c.json(
      Object.entries(tally)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .map(([reason, count]) => ({ reason, count })),
    );
  });
}
