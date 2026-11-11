// 频道排序 admin 路由（分类内拖动排序 + 央视一键智能排序）
//
// 数据源用「当前输出配置」而不是原始频道树：死链清理已经生效，
// 用户在后台看到的列表和电视上看到的列表是同一份。

import type { Hono } from 'hono';
import type { Storage } from '../storage/interface';
import { verifyAdmin } from '../core/admin-auth';
import type { AppConfig, TVBoxLiveGroup } from '../core/types';
import { KV_MERGED_CONFIG } from '../core/config';
import {
  loadChannelOrder,
  saveChannelOrder,
  smartSortCctv,
  type ChannelOrderConfig,
} from '../core/live-order';
import {
  loadLiveGroupMerge,
  saveLiveGroupMerge,
  defaultLiveGroupMerge,
  type LiveGroupMergeConfig,
} from '../core/live-groups';
import {
  loadShoppingFilter,
  saveShoppingFilter,
  type ShoppingFilterConfig,
} from '../core/live-filters';

export interface ChannelOrderRouteDeps {
  storage: Storage;
  config: AppConfig;
  triggerRefresh?: () => Promise<void>;
}

function isNativeGroups(lives: unknown): lives is TVBoxLiveGroup[] {
  if (!Array.isArray(lives) || lives.length === 0) return false;
  return lives.every((g) => g && typeof g === 'object'
    && typeof (g as TVBoxLiveGroup).group === 'string'
    && Array.isArray((g as TVBoxLiveGroup).channels));
}

export function mountChannelOrderRoutes(app: Hono, deps: ChannelOrderRouteDeps): void {
  const { storage, config, triggerRefresh } = deps;

  async function readGroups(): Promise<TVBoxLiveGroup[]> {
    const raw = await storage.get(KV_MERGED_CONFIG);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return isNativeGroups(parsed.lives) ? parsed.lives : [];
    } catch {
      return [];
    }
  }

  // GET / PUT /admin/live-use-config-lives — 是否采用配置源自带 lives
  app.get('/admin/live-use-config-lives', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    return c.json({ enabled: (await storage.get('live_use_config_lives')) === 'true' });
  });

  app.put('/admin/live-use-config-lives', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    const body = await c.req.json<{ enabled: boolean }>();
    await storage.put('live_use_config_lives', body.enabled ? 'true' : 'false');
    if (triggerRefresh) triggerRefresh().catch(() => {});
    return c.json({ success: true, enabled: body.enabled });
  });

  // GET / PUT /admin/live-shopping — 购物台过滤
  app.get('/admin/live-shopping', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    return c.json(await loadShoppingFilter(storage));
  });

  app.put('/admin/live-shopping', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    let body: Partial<ShoppingFilterConfig>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }
    const current = await loadShoppingFilter(storage);
    const next: ShoppingFilterConfig = {
      enabled: body.enabled !== undefined ? !!body.enabled : current.enabled,
      keywords: Array.isArray(body.keywords)
        ? body.keywords.filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim())
        : current.keywords,
    };
    await saveShoppingFilter(storage, next);
    if (triggerRefresh) triggerRefresh().catch(() => {});
    return c.json({ success: true, enabled: next.enabled, keywords: next.keywords.length });
  });

  // GET /admin/live-groups — 分组归并规则
  app.get('/admin/live-groups', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    return c.json(await loadLiveGroupMerge(storage));
  });

  // PUT /admin/live-groups — 保存规则 { enabled, standard?, rules: [{keyword,target}] }
  app.put('/admin/live-groups', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    let body: Partial<LiveGroupMergeConfig>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }
    const current = await loadLiveGroupMerge(storage);
    const next: LiveGroupMergeConfig = {
      enabled: body.enabled !== undefined ? !!body.enabled : current.enabled,
      standard: Array.isArray(body.standard) && body.standard.length > 0
        ? body.standard.filter((x): x is string => typeof x === 'string' && !!x.trim())
        : current.standard,
      rules: Array.isArray(body.rules)
        ? body.rules
          .filter((r): r is { keyword: string; target: string } => !!r && typeof r.keyword === 'string' && typeof r.target === 'string')
          .map((r) => ({ keyword: r.keyword.trim(), target: r.target.trim() }))
          .filter((r) => r.keyword && r.target)
        : current.rules,
    };
    await saveLiveGroupMerge(storage, next);
    if (triggerRefresh) triggerRefresh().catch(() => {});
    return c.json({ success: true, enabled: next.enabled, rules: next.rules.length });
  });

  // POST /admin/live-groups/reset — 恢复默认规则
  app.post('/admin/live-groups/reset', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    await saveLiveGroupMerge(storage, defaultLiveGroupMerge());
    if (triggerRefresh) triggerRefresh().catch(() => {});
    return c.json({ success: true });
  });

  // GET /admin/channel-order — 当前分组与频道（按生效顺序）
  app.get('/admin/channel-order', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);

    const [groups, saved] = await Promise.all([readGroups(), loadChannelOrder(storage)]);
    return c.json({
      groups: groups.map((g) => ({
        group: g.group,
        count: g.channels.length,
        channels: g.channels.map((ch) => ({ name: ch.name, urls: ch.urls.length })),
      })),
      saved,
    });
  });

  // PUT /admin/channel-order — 保存手动顺序 { groups: { 分组: [频道名...] } }
  app.put('/admin/channel-order', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);

    let body: { groups?: Record<string, string[]> };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }
    if (!body.groups || typeof body.groups !== 'object') {
      return c.json({ error: 'groups is required' }, 400);
    }

    const current = await loadChannelOrder(storage);
    const next: ChannelOrderConfig = {
      groups: { ...current.groups },
      moves: { ...current.moves },
    };
    for (const [group, order] of Object.entries(body.groups)) {
      if (!Array.isArray(order)) continue;
      next.groups[group] = order.filter((n): n is string => typeof n === 'string');
    }

    await saveChannelOrder(storage, next);
    if (triggerRefresh) triggerRefresh().catch(() => {});
    return c.json({ success: true, groups: Object.keys(next.groups).length });
  });

  // POST /admin/channel-order/smart — 央视分组一键智能排序
  app.post('/admin/channel-order/smart', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);

    const groups = await readGroups();
    if (groups.length === 0) return c.json({ error: 'No live config yet, run a refresh first' }, 400);

    const result = smartSortCctv(groups);
    if (result.order.length === 0) {
      return c.json({ error: 'CCTV group not found' }, 404);
    }

    const current = await loadChannelOrder(storage);
    const next: ChannelOrderConfig = {
      groups: { ...current.groups, 央视: result.order },
      moves: { ...current.moves, ...result.moves },
    };
    await saveChannelOrder(storage, next);
    if (triggerRefresh) triggerRefresh().catch(() => {});

    return c.json({
      success: true,
      kept: result.keptCount,
      movedOut: result.movedOut,
      order: result.order,
    });
  });

  // DELETE /admin/channel-order — 清空自定义顺序与移动规则
  app.delete('/admin/channel-order', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);

    await saveChannelOrder(storage, { groups: {}, moves: {} });
    if (triggerRefresh) triggerRefresh().catch(() => {});
    return c.json({ success: true });
  });
}
