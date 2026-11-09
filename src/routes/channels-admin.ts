// 频道目录与源管理接口（固化框架）
//
// 读取频道树 + 目录、一键选优（top N）、删除源、未识别队列、人工归入、置顶/禁用。
// 置顶/禁用通过 overrides 落盘，聚合时由 channel-curation 套用（见 aggregator Step 6.7b）。

import type { Hono } from 'hono';
import type { Storage } from '../storage/interface';
import type { AppConfig, ChannelSpeedMap, TVBoxLiveGroup } from '../core/types';
import {
  KV_MERGED_CONFIG,
  KV_LIVE_TOP_N,
} from '../core/config';
import { loadSpeedMap } from '../core/channel-probe';
import { loadRegistry, saveRegistry, upsertFromGroups, findUnmapped, assignAlias, normalizeKey } from '../core/channel-registry';
import { snapshotOf } from '../core/source-health';
import { addDeadUrls } from '../core/live-deadlist';
import { loadOverrides, saveOverrides, setOverride, overrideOf, isProtectedUrl } from '../core/channel-curation';
import { bareUrl } from '../core/live-url';
import { trimGroupsToTopN } from '../core/live-url';

function verifyAdmin(request: Request, config: AppConfig): boolean {
  const token = config.adminToken;
  if (!token) return false;
  return request.headers.get('Authorization') === `Bearer ${token}`;
}

async function loadLives(storage: Storage): Promise<TVBoxLiveGroup[]> {
  const raw = await storage.get(KV_MERGED_CONFIG);
  if (!raw) return [];
  try {
    const full = JSON.parse(raw);
    return Array.isArray(full.lives) ? (full.lives as TVBoxLiveGroup[]) : [];
  } catch {
    return [];
  }
}

function splitUrl(raw: string): { url: string; source: string } {
  const i = raw.lastIndexOf('$');
  if (i > 0) return { url: raw.slice(0, i), source: raw.slice(i + 1) };
  return { url: raw, source: '' };
}

export interface ChannelRouteDeps {
  storage: Storage;
  config: AppConfig;
  triggerRefresh?: () => Promise<void>;
}

export function mountChannelRoutes(app: Hono, deps: ChannelRouteDeps): void {
  const { storage, config, triggerRefresh } = deps;

  // GET /admin/channels — 频道树（含 id、源、健康快照）+ 未识别队列
  app.get('/admin/channels', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);

    const lives = await loadLives(storage);
    const speed = await loadSpeedMap(storage);
    const reg = await loadRegistry(storage);
    const overrides = await loadOverrides(storage);

    // 首次访问时用当前树初始化目录
    if (Object.keys(reg.channels).length === 0 && lives.length > 0) {
      const { added } = upsertFromGroups(reg, lives);
      if (added > 0) await saveRegistry(storage, reg);
    }

    const groups = lives.map((g) => ({
      group: g.group,
      channels: (g.channels || []).map((ch) => {
        const id = reg.byName[String(ch.name).trim().toUpperCase()] || null;
        const ov = overrideOf(overrides, ch.name);
        return {
          name: ch.name,
          id,
          pinned: !!ov?.pinned,
          disabled: !!ov?.disabled,
          urls: (ch.urls || []).map((raw) => {
            const { url, source } = splitUrl(raw);
            const entry = speed[url];
            return {
              url, source,
              speedMs: entry?.kind === 'fail' ? 0 : (entry?.speedMs ?? 0),
              kind: entry?.kind ?? 'untested',
              note: entry?.note,
              protected: isProtectedUrl(url),
              health: snapshotOf(entry),
            };
          }),
        };
      }),
    }));

    // 被「禁用」的频道不会出现在输出里，这里按目录补回占位行，
    // 否则禁用之后在后台就找不到它、没法撤销了。
    const disabledKeys = Object.entries(overrides)
      .filter(([, v]) => v?.disabled)
      .map(([k]) => k);
    if (disabledKeys.length > 0) {
      const present = new Set(groups.flatMap((g) => g.channels.map((ch) => normalizeKey(ch.name))));
      for (const rec of Object.values(reg.channels)) {
        const k = normalizeKey(rec.name);
        if (!disabledKeys.includes(k) || present.has(k)) continue;
        let target = groups.find((g) => g.group === rec.group);
        if (!target) { target = { group: rec.group, channels: [] }; groups.push(target); }
        target.channels.push({ name: rec.name, id: rec.id, pinned: false, disabled: true, urls: [] });
      }
    }

    return c.json({
      groups,
      // 「忽略」过的名字不再进未识别队列（override.disabled 兼作忽略标记）
      unmapped: findUnmapped(reg, lives).filter((u) => !overrides[normalizeKey(u.name)]?.disabled),
      overrides,
      registrySize: Object.keys(reg.channels).length,
      initializedAt: reg.initializedAt,
    });
  });

  // POST /admin/channels/override — 置顶 / 禁用（可撤销）
  app.post('/admin/channels/override', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    const body = await c.req.json<{ name?: string; pinned?: boolean; disabled?: boolean }>();
    if (!body.name) return c.json({ error: 'name 必填' }, 400);
    if (body.pinned === undefined && body.disabled === undefined) {
      return c.json({ error: 'pinned 与 disabled 至少给一个' }, 400);
    }
    const map = await loadOverrides(storage);
    const next = setOverride(map, body.name, {
      ...(body.pinned === undefined ? {} : { pinned: body.pinned }),
      ...(body.disabled === undefined ? {} : { disabled: body.disabled }),
    });
    await saveOverrides(storage, next);
    if (triggerRefresh) triggerRefresh().catch(() => {});
    return c.json({ success: true, overrides: next });
  });

  // GET /admin/channels/unmapped — 未识别队列
  app.get('/admin/channels/unmapped', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    const lives = await loadLives(storage);
    const reg = await loadRegistry(storage);
    return c.json(findUnmapped(reg, lives));
  });

  // POST /admin/channels/assign — 人工归入（写别名，以后不再判断）
  app.post('/admin/channels/assign', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    const body = await c.req.json<{ name?: string; id?: string }>();
    if (!body.name || !body.id) return c.json({ error: 'name 与 id 必填' }, 400);
    const reg = await loadRegistry(storage);
    const ok = assignAlias(reg, body.name, body.id);
    if (!ok) return c.json({ error: '频道不存在' }, 404);
    await saveRegistry(storage, reg);
    return c.json({ success: true });
  });

  // POST /admin/channels/optimize — 一键选优：每台保留 top N
  app.post('/admin/channels/optimize', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    const body = await c.req.json<{ topN?: number }>();
    const topN = Math.max(1, Math.min(20, Number(body.topN) || 6));
    await storage.put(KV_LIVE_TOP_N, String(topN));
    if (triggerRefresh) triggerRefresh().catch(() => {});
    return c.json({ success: true, topN });
  });

  // POST /admin/channels/trim — 立即按当前 topN 裁剪一次输出（不重新聚合，用于预览）
  app.post('/admin/channels/trim', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    const raw = await storage.get(KV_MERGED_CONFIG);
    if (!raw) return c.json({ error: '还没有生成过配置' }, 400);
    const topN = Number(await storage.get(KV_LIVE_TOP_N)) || 6;
    const full = JSON.parse(raw);
    const before = (full.lives || []).reduce((n: number, g: TVBoxLiveGroup) => n + (g.channels || []).reduce((m, ch) => m + (ch.urls || []).length, 0), 0);
    full.lives = trimGroupsToTopN(full.lives || [], topN);
    const after = full.lives.reduce((n: number, g: TVBoxLiveGroup) => n + (g.channels || []).reduce((m, ch) => m + (ch.urls || []).length, 0), 0);
    await storage.put(KV_MERGED_CONFIG, JSON.stringify(full));
    return c.json({ success: true, topN, before, after });
  });

  // DELETE /admin/channels/source — 删除某条源（进死源黑名单，可回滚）
  app.delete('/admin/channels/source', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    const body = await c.req.json<{ urls?: string[] }>();
    const list = (body.urls || []).map(bareUrl).filter(Boolean);
    if (list.length === 0) return c.json({ error: 'urls 必填' }, 400);
    const added = await addDeadUrls(storage, list);
    if (triggerRefresh) triggerRefresh().catch(() => {});
    return c.json({ success: true, added });
  });

  // GET /admin/channels/health-map — 给「频道」页快速取一次健康快照
  app.get('/admin/channels/health-map', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    const speed: ChannelSpeedMap = await loadSpeedMap(storage);
    const out: Record<string, { availability: number; score: number; tier: number }> = {};
    for (const [url, entry] of Object.entries(speed)) {
      const s = snapshotOf(entry);
      out[url] = { availability: s.availability, score: s.score, tier: s.tier };
    }
    return c.json(out);
  });
}
