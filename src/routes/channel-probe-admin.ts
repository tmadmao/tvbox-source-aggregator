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
import { addDeadUrls, loadDeadUrls, clearDeadUrls, pruneUnreferencedDeadUrls } from '../core/live-deadlist';
import { bareUrl } from '../core/live-url';
import { KV_CHANNEL_MERGED_TREE } from '../core/config';

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

  // POST /admin/channel-probe/prune-dead — 按引用剪枝：删掉已不在任何源里的死链
  // 返回剪枝前后的条数与按域名统计，方便看清「谁把名单撑大的」
  app.post('/admin/channel-probe/prune-dead', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);

    const rawTree = await storage.get(KV_CHANNEL_MERGED_TREE);
    if (!rawTree) return c.json({ error: '还没有频道树，先跑一次聚合' }, 400);

    let groups: Array<{ channels?: Array<{ urls?: string[] }> }> = [];
    try { groups = JSON.parse(rawTree); } catch { return c.json({ error: '频道树解析失败' }, 500); }

    const referenced = new Set<string>();
    for (const g of groups) for (const ch of g.channels || []) for (const u of ch.urls || []) referenced.add(bareUrl(u));

    const result = await pruneUnreferencedDeadUrls(storage, referenced);
    return c.json({ success: true, ...result, referenced: referenced.size });
  });
}
