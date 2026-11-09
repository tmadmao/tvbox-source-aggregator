// 频道测速 admin 路由（方案 D+ 运维独立模块）

import type { Hono } from 'hono';
import type { Storage } from '../storage/interface';
import type { AppConfig } from '../core/types';
import {
  isProbeEnabled,
  setProbeEnabled,
  loadStatus,
  loadSpeedMap,
  runChannelProbe,
  isRunning,
  clearSpeedMap,
} from '../core/channel-probe';
import { addDeadUrls, loadDeadUrls, loadDeadRows, clearDeadUrls, ledgerStats, DEAD_RETEST_MS, CONDEMNED_RETEST_MS } from '../core/live-deadlist';
import { KV_LIVE_DEAD_URLS, KV_CHANNEL_MERGED_TREE } from '../core/config';
import { bareUrl } from '../core/live-url';

function verifyAdmin(request: Request, config: AppConfig): boolean {
  const token = config.adminToken;
  if (!token) return false;
  const auth = request.headers.get('Authorization');
  return auth === `Bearer ${token}`;
}

export interface ChannelProbeRouteDeps {
  storage: Storage;
  config: AppConfig;
  triggerRefresh?: () => Promise<void>;
}

export function mountChannelProbeRoutes(app: Hono, deps: ChannelProbeRouteDeps): void {
  const { storage, config, triggerRefresh } = deps;

  // GET /admin/channel-probe/status — 查询状态 + 开关
  app.get('/admin/channel-probe/status', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    const [enabled, status, deadList] = await Promise.all([
      isProbeEnabled(storage),
      loadStatus(storage),
      loadDeadUrls(storage),
    ]);
    return c.json({
      enabled,
      running: isRunning(),
      status,
      deadListed: deadList.length,
    });
  });

  // PUT /admin/channel-probe/toggle — 开关
  app.put('/admin/channel-probe/toggle', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    let body: { enabled?: boolean };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }
    if (typeof body.enabled !== 'boolean') {
      return c.json({ error: 'enabled must be a boolean' }, 400);
    }
    await setProbeEnabled(storage, body.enabled);
    return c.json({ success: true, enabled: body.enabled });
  });

  // GET / PUT /admin/channel-probe/inline — 测速是否并入聚合流程
  app.get('/admin/channel-probe/inline', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    return c.json({ enabled: (await storage.get('channel_probe_inline')) !== 'false' });
  });

  app.put('/admin/channel-probe/inline', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    const body = await c.req.json<{ enabled: boolean }>();
    await storage.put('channel_probe_inline', body.enabled ? 'true' : 'false');
    return c.json({ success: true, enabled: body.enabled });
  });

  // GET / PUT /admin/channel-probe/segment — L2 分片复验开关
  app.get('/admin/channel-probe/segment', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    return c.json({ enabled: (await storage.get('channel_probe_segment')) !== 'false' });
  });

  app.put('/admin/channel-probe/segment', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    const body = await c.req.json<{ enabled: boolean }>();
    await storage.put('channel_probe_segment', body.enabled ? 'true' : 'false');
    return c.json({ success: true, enabled: body.enabled });
  });

  // POST /admin/channel-probe/clear-cache — 清空测速缓存，强制下轮全量重测
  app.post('/admin/channel-probe/clear-cache', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    if (isRunning()) return c.json({ success: false, error: '测速进行中，请稍后再清' });
    const cleared = await clearSpeedMap(storage);
    return c.json({ success: true, cleared });
  });

  // POST /admin/channel-probe/trigger — 手动触发（异步启动，不阻塞响应）
  app.post('/admin/channel-probe/trigger', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    if (isRunning()) {
      return c.json({ success: false, error: 'Already running' }, 409);
    }
    if (!(await isProbeEnabled(storage))) {
      return c.json({ success: false, error: 'Probe is disabled, enable it first' }, 400);
    }
    // 异步启动；仅在「测速未并入聚合」时，跑完补一次重建让排序生效
    const inline = (await storage.get('channel_probe_inline')) !== 'false';
    runChannelProbe(storage)
      .then(() => {
        if (!inline && triggerRefresh) return triggerRefresh();
      })
      .catch((err) => {
        console.error('[channel-probe-admin] Trigger error:', err);
      });
    return c.json({ success: true, message: 'Probe started' });
  });

  // POST /admin/channel-probe/drop-dead — 把测速失败的源加入死源黑名单并重新聚合
  // 黑名单会长期生效；某个 URL 之后被测速判定为可用时，会自动移出（见 channel-probe 自愈逻辑）
  app.post('/admin/channel-probe/drop-dead', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);

    const map = await loadSpeedMap(storage);
    const dead = Object.entries(map)
      // 至少连续两轮失败才进黑名单：单轮失败可能只是网络抖一下，
      // 而黑名单一旦命中，整台就从输出里消失了。
      .filter(([, entry]) => entry.kind === 'fail' && (entry.consecutiveFails ?? entry.fails ?? 1) >= 2)
      .map(([url]) => url);

    if (dead.length === 0) {
      return c.json({ success: true, removed: 0, added: 0, message: 'No failed URLs to clean' });
    }

    const added = await addDeadUrls(storage, dead);
    if (triggerRefresh) {
      triggerRefresh().catch((err) => {
        console.error('[channel-probe-admin] Refresh after drop-dead failed:', err);
      });
    }
    return c.json({ success: true, removed: dead.length, added });
  });

  // DELETE /admin/channel-probe/drop-dead — 清空死源黑名单（误删后的回滚）
  app.delete('/admin/channel-probe/drop-dead', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    const before = await loadDeadUrls(storage);
    await clearDeadUrls(storage);
    if (triggerRefresh) {
      triggerRefresh().catch((err) => {
        console.error('[channel-probe-admin] Refresh after clearing dead list failed:', err);
      });
    }
    return c.json({ success: true, cleared: before.length });
  });

  // GET /admin/channel-probe/ledger — 死源台账概览（不删任何东西，只回答「有多少、该测多少」）
  app.get('/admin/channel-probe/ledger', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    const rows = await loadDeadRows(storage);
    const stats = ledgerStats(rows);

    // 「该回测多少条」只对仍在频道树里的源有意义：孤儿不在树上，永远不会进测速队列
    const referenced = new Set<string>();
    const rawTree = await storage.get(KV_CHANNEL_MERGED_TREE);
    if (rawTree) {
      try {
        const groups = JSON.parse(rawTree) as Array<{ channels?: Array<{ urls?: string[] }> }>;
        for (const g of groups) for (const ch of g.channels || []) for (const u of ch.urls || []) referenced.add(bareUrl(u));
      } catch { /* ignore */ }
    }
    let inTree = 0, dueInTree = 0;
    const now = Date.now();
    for (const r of rows) {
      if (!referenced.has(r.url)) continue;
      inTree++;
      const interval = r.state === 2 ? CONDEMNED_RETEST_MS : DEAD_RETEST_MS;
      if (!r.probedAt || now - r.probedAt >= interval) dueInTree++;
    }

    const byHost = new Map<string, number>();
    for (const r of rows) {
      let h = '(invalid)';
      try { h = new URL(r.url).hostname.toLowerCase(); } catch { /* ignore */ }
      byHost.set(h, (byHost.get(h) || 0) + 1);
    }
    return c.json({
      ...stats,
      inTree,
      dueInTree,
      bytes: (await storage.get(KV_LIVE_DEAD_URLS) || '').length,
      warmRetestDays: DEAD_RETEST_MS / 86400000,
      condemnedRetestDays: CONDEMNED_RETEST_MS / 86400000,
      topHosts: [...byHost.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)
        .map(([host, n]) => ({ host, n })),
    });
  });
}
