// 编排规则外置接口
//
// 「改卫视顺序要发版」是这一项的原始痛点。规则现在存 KV：
// 央视台序 / 卫视台序 / 南京置顶 / 省份先后 / 每台保留条数 / 各档保底可播条数。
// 后台保存后，下一次聚合立即生效；重启不丢。

import type { Hono } from 'hono';
import type { Storage } from '../storage/interface';
import type { AppConfig } from '../core/types';
import {
  loadCurationRules,
  saveCurationRules,
  resetCurationRules,
  normalizeRules,
  DEFAULT_CURATION_RULES,
} from '../core/channel-curation';
import { TIER_LABEL } from '../core/channel-tier';

function verifyAdmin(request: Request, config: AppConfig): boolean {
  const token = config.adminToken;
  if (!token) return false;
  return request.headers.get('Authorization') === `Bearer ${token}`;
}

export interface CurationRouteDeps {
  storage: Storage;
  config: AppConfig;
  triggerRefresh?: () => Promise<void>;
}

export function mountCurationRoutes(app: Hono, deps: CurationRouteDeps): void {
  const { storage, config } = deps;

  app.get('/admin/curation-rules', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    const rules = await loadCurationRules(storage);
    return c.json({
      rules,
      defaults: DEFAULT_CURATION_RULES,
      tierLabels: TIER_LABEL,
    });
  });

  app.put('/admin/curation-rules', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }
    const clean = normalizeRules(body);
    const saved = await saveCurationRules(storage, clean);
    return c.json({ success: true, rules: saved });
  });

  // DELETE — 恢复默认（不发版、不改代码）
  app.delete('/admin/curation-rules', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    const rules = await resetCurationRules(storage);
    return c.json({ success: true, rules });
  });
}
