// Hono 统一路由层

import { Hono } from 'hono';
import type { Storage } from './storage/interface';
import type { AppConfig, SourceEntry, MacCMSSourceEntry, LiveSourceEntry, NameTransformConfig, EdgeProxyConfig } from './core/types';
import { KV_MERGED_CONFIG, KV_MERGED_CONFIG_FULL, KV_MANUAL_SOURCES, KV_LAST_UPDATE, KV_MACCMS_SOURCES, KV_LIVE_SOURCES, KV_BLACKLIST, LIVE_PROXY_TTL, IMG_PROXY_TTL, KV_INLINE_PREFIX, KV_NAME_TRANSFORM, KV_CRON_INTERVAL, DEFAULT_CRON_INTERVAL, KV_SOURCE_HEALTH, KV_SPEED_TEST_ENABLED, KV_EDGE_PROXIES, KV_SEARCH_QUOTA_REPORT, KV_AGG_LOGS, KV_BG_SETTINGS, KV_DEDUP_CONFIG, KV_LIVE_DISABLED, KV_LIVE_MERGE_MODE, KV_SMART_BASE_URL_ENABLED, KV_SITE_PROBE_DEPTH, KV_SITE_AUTO_CLEAN, KV_SITE_HEALTH_MAP, KV_LIVE_HEAD_VERIFY, KV_SITE_KEEP_LINK } from './core/config';
import { getRequestBaseUrl, applyBaseUrlPlaceholder, assertHostAllowed } from './core/base-url';
import { logger } from './core/logger';
import { loadGroupOrder, saveGroupOrder } from './core/group-order';
import { parseConfigJson, isMultiRepoConfig, extractMultiRepoEntries } from './core/fetcher';
import { decodeConfigResponse } from './core/decoder';
import { validateMacCMS } from './core/maccms';
import { lookupJarUrl, isMd5Key, base64ToUint8Array, rewriteJarUrls } from './core/jar-proxy';
import { BASE_URL_PLACEHOLDER } from './core/config';
import { lookupLiveUrl } from './core/live-source';
import { adminHtml } from './core/admin';
import { dashboardHtml } from './core/dashboard';
import { configEditorHtml } from './core/config-editor';
import { siteFingerprintCached, loadBlacklist, saveBlacklist, saveRegexRule, deleteRegexRule, updateRegexRule, validateRegexRule, testRegexAgainstSites, applyBlacklist } from './core/blacklist';
import { loadSearchQuota, saveSearchQuota } from './core/search-quota';
import { loadCredentials, saveCredential, deleteCredential, loadCredentialPolicy, saveCredentialPolicy, ensureCredentialTokenSecret } from './core/credential-store';
import { verifyAdmin, constantTimeEqual } from './core/admin-auth';
import { checkPublicUrl, fetchPublic } from './core/net-guard';
import { KV_CREDENTIAL_TOKEN_SECRET, KV_SITE_FP } from './core/config';
import { generateQR, pollQRStatus, passwordLogin, PLATFORM_NAMES, QR_PLATFORMS, PASSWORD_PLATFORMS } from './core/cloud-login';
import { assessAllSources } from './core/credential-risk';
import { generateTokenJson } from './core/credential-injector';
import { formatLiveGroupsAsTxt, fetchAndParseLiveUrls } from './core/live-merger';
import type { TVBoxConfig, SearchQuotaConfig, CloudPlatform, CloudCredential, TVBoxLiveGroup } from './core/types';
import { mountChannelProbeRoutes } from './routes/channel-probe-admin';
import { mountChannelOrderRoutes } from './routes/channel-order-admin';
import { mountChannelRoutes } from './routes/channels-admin';
import { mountHealthRoutes } from './routes/health-admin';
import { mountSchedulerRoutes } from './routes/scheduler-admin';
import { mountCurationRoutes } from './routes/curation-admin';
import { loadSkipList, clearSkipList } from './core/site-skip';
import { loadFtpConfig, saveFtpConfig, testFtpConnection, uploadLiveTxt, type FtpSyncConfig } from './core/ftp-sync';

export interface AppDeps {
  storage: Storage;
  config: AppConfig;
  triggerRefresh: () => Promise<void>;
  onCronIntervalChange?: (intervalMinutes: number) => void;
  enableChannelProbe?: boolean; // 仅 Node/Docker 入口启用
  enableBuilder?: boolean;      // 仅 Node/Docker 入口启用（配置构建器）
  isSyncing?: () => boolean;
}

function isNativeLiveGroups(lives: unknown): lives is TVBoxLiveGroup[] {
  if (!Array.isArray(lives)) return false;

  return lives.every((live) => {
    if (!live || typeof live !== 'object') return false;

    const group = (live as { group?: unknown }).group;
    const channels = (live as { channels?: unknown }).channels;
    if (typeof group !== 'string' || !Array.isArray(channels)) return false;

    return channels.every((channel) => {
      if (!channel || typeof channel !== 'object') return false;
      const name = (channel as { name?: unknown }).name;
      const urls = (channel as { urls?: unknown }).urls;
      return typeof name === 'string'
        && Array.isArray(urls)
        && urls.every((url) => typeof url === 'string');
    });
  });
}

/**
 * FongMi 格式 live.txt 的短缓存。
 *
 * 这类配置的 lives 只是「指针」（type/url/api），每次请求都要逐个下载远端列表再解析。
 * 而 /live-config 与 /live.txt 都是公网无鉴权的 GET —— 谁都能高频打它，
 * 把上游站点的请求量放大成我们的出站流量。2 分钟缓存足够挡掉刷量，
 * 又不会让「刚聚合完」的用户等太久。
 */
const LIVE_TXT_CACHE_TTL_MS = 2 * 60 * 1000;
let liveTxtCache: { key: string; at: number; body: string } | null = null;

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const { storage, config } = deps;

  // ─── 本地字体（仅 Node 侧）──────────────────────────────
  if (!config.workerBaseUrl) {
    const FONTS: Record<string, string> = {
      'jetbrains-mono-latin-ext.woff2': 'font/woff2',
      'jetbrains-mono-latin.woff2': 'font/woff2',
      'outfit-latin-ext.woff2': 'font/woff2',
      'outfit-latin.woff2': 'font/woff2',
    };

    app.get('/fonts/:name', async (c) => {
      const name = c.req.param('name');
      const contentType = FONTS[name];
      if (!contentType) return c.text('Not Found', 404);
      try {
        const fs = await import('fs');
        const path = await import('path');
        const data = await fs.promises.readFile(path.join(__dirname, 'static/fonts', name));
        return c.body(data, 200, {
          'Content-Type': contentType,
          'Cache-Control': 'public, max-age=31536000, immutable',
        });
      } catch {
        return c.text('Not Found', 404);
      }
    });
  }

  // ─── 版本信息 ──────────────────────────────────────────
  app.get('/version', (c) => {
    const { APP_VERSION, APP_COMMIT } = require('./core/version');
    return c.json({ version: APP_VERSION, commit: APP_COMMIT });
  });

  // ─── 占位符替换辅助 ────────────────────────────────────
  async function resolveBaseUrl(c: import('hono').Context): Promise<string | Response> {
    const smartEnabled = (await storage.get(KV_SMART_BASE_URL_ENABLED)) === 'true';
    const dmzEnabled = process.env.DMZ === '0';
    const fallback = (config.localBaseUrl || '').replace(/\/$/, '');

    if (config.workerBaseUrl) {
      return config.workerBaseUrl.replace(/\/$/, '');
    } else if (smartEnabled) {
      const baseUrl = getRequestBaseUrl(c, fallback);
      if (!assertHostAllowed(baseUrl, fallback, dmzEnabled)) {
        logger.security('host-blocked', { host: baseUrl, fallback });
        return c.json({ error: 'Non-LAN access denied. Set DMZ=0 to allow.' }, 403);
      }
      return baseUrl;
    }
    return fallback;
  }

  // ─── 主配置 ────────────────────────────────────────────
  app.get('/', async (c) => {
    let cached = await storage.get(KV_MERGED_CONFIG);

    if (!cached) {
      return c.json(
        { error: 'No config available yet. Add sources in /admin and trigger a refresh.' },
        503,
      );
    }

    const baseUrl = await resolveBaseUrl(c);
    if (baseUrl instanceof Response) return baseUrl;
    cached = applyBaseUrlPlaceholder(cached, baseUrl);

    return c.body(cached, 200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=1800',
      'Access-Control-Allow-Origin': '*',
    });
  });

  // ─── 纯直播配置 ────────────────────────────────────────
  // /live.txt 与 /live-config 同源：有些直播壳只认 .txt 后缀，给个同名别名
  app.get('/live.txt', async (c) => {
    return c.redirect('/live-config', 302);
  });

  app.get('/live-config', async (c) => {
    let cached = await storage.get(KV_MERGED_CONFIG);

    if (!cached) {
      return c.json({ error: 'No config available yet.' }, 503);
    }

    const baseUrl = await resolveBaseUrl(c);
    if (baseUrl instanceof Response) return baseUrl;
    cached = applyBaseUrlPlaceholder(cached, baseUrl);

    try {
      const full = JSON.parse(cached);
      const lives = full.lives || [];

      // FongMi 格式（type/url/api 指针）：实时下载并解析为 txt 格式
      if (!isNativeLiveGroups(lives)) {
        const liveUrls: Array<{ name: string; url: string; header?: Record<string, string> }> = [];
        for (const entry of lives) {
          const url = entry.url || entry.api;
          if (url && typeof url === 'string') {
            liveUrls.push({ name: entry.name || url, url, header: entry.header });
          }
        }
        if (liveUrls.length > 0) {
          const cacheKey = JSON.stringify(liveUrls);
          if (liveTxtCache && liveTxtCache.key === cacheKey && Date.now() - liveTxtCache.at < LIVE_TXT_CACHE_TTL_MS) {
            return c.body(liveTxtCache.body, 200, {
              'Content-Type': 'text/plain; charset=utf-8',
              'Cache-Control': 'public, max-age=300',
              'Access-Control-Allow-Origin': '*',
              'X-Proxy-Cache': 'hit',
            });
          }
          try {
            const groups = await fetchAndParseLiveUrls(liveUrls, 8000);
            if (groups.length > 0) {
              const txt = formatLiveGroupsAsTxt(groups);
              liveTxtCache = { key: cacheKey, at: Date.now(), body: txt };
              return c.body(txt, 200, {
                'Content-Type': 'text/plain; charset=utf-8',
                'Cache-Control': 'public, max-age=300',
                'Access-Control-Allow-Origin': '*',
                'X-Proxy-Cache': 'miss',
              });
            }
          } catch { /* fall through to JSON fallback */ }
        }
        // 无法解析时返回空 txt
        return c.body('', 200, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'public, max-age=300',
          'Access-Control-Allow-Origin': '*',
        });
      }

      return c.body(formatLiveGroupsAsTxt(lives), 200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'public, max-age=300',
        'Access-Control-Allow-Origin': '*',
      });
    } catch {
      return c.json({ error: 'Config parse error' }, 500);
    }
  });

  // ─── .json 下载别名 ────────────────────────────────────
  app.get('/index.json', async (c) => {
    let cached = await storage.get(KV_MERGED_CONFIG);
    if (!cached) {
      return c.json({ error: 'No config available yet.' }, 503);
    }
    const baseUrl = await resolveBaseUrl(c);
    if (baseUrl instanceof Response) return baseUrl;
    cached = applyBaseUrlPlaceholder(cached, baseUrl);
    return c.body(cached, 200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=1800',
      'Access-Control-Allow-Origin': '*',
      'Content-Disposition': 'attachment; filename="tvbox-config.json"',
    });
  });

  app.get('/live.json', async (c) => {
    let cached = await storage.get(KV_MERGED_CONFIG);
    if (!cached) {
      return c.json({ error: 'No config available yet.' }, 503);
    }
    const baseUrl = await resolveBaseUrl(c);
    if (baseUrl instanceof Response) return baseUrl;
    cached = applyBaseUrlPlaceholder(cached, baseUrl);
    try {
      const full = JSON.parse(cached);
      const liveConfig = { lives: full.lives || [] };
      return c.body(JSON.stringify(liveConfig), 200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=1800',
        'Access-Control-Allow-Origin': '*',
        'Content-Disposition': 'attachment; filename="tvbox-live.json"',
      });
    } catch {
      return c.json({ error: 'Config parse error' }, 500);
    }
  });

  // ─── 监控面板 ──────────────────────────────────────────
  app.get('/status', (c) => {
    return c.html(dashboardHtml);
  });

  app.get('/status-data', async (c) => {
    const lastUpdate = await storage.get(KV_LAST_UPDATE);
    const sources = await storage.get(KV_MANUAL_SOURCES);
    const macCMSSources = await storage.get(KV_MACCMS_SOURCES);
    const liveSources = await storage.get(KV_LIVE_SOURCES);
    const cached = await storage.get(KV_MERGED_CONFIG);

    let siteCount = 0;
    let parseCount = 0;
    let liveCount = 0;
    if (cached) {
      try {
        const parsed = JSON.parse(cached);
        siteCount = parsed.sites?.length || 0;
        parseCount = parsed.parses?.length || 0;
        liveCount = parsed.lives?.length || 0;
      } catch {
        // ignore
      }
    }

    const warnings: string[] = [];
    if (config.dockerMissingBaseUrl) {
      warnings.push('docker_no_base_url');
    }

    return c.json({
      lastUpdate: lastUpdate || 'never',
      sourceCount: sources ? JSON.parse(sources).length : 0,
      macCMSCount: macCMSSources ? JSON.parse(macCMSSources).length : 0,
      liveSourceCount: liveSources ? JSON.parse(liveSources).length : 0,
      sites: siteCount,
      parses: parseCount,
      lives: liveCount,
      warnings,
    });
  });

  // ─── 源健康状态（无认证，Dashboard 需要访问）─────────────
  app.get('/source-status', async (c) => {
    const raw = await storage.get(KV_SOURCE_HEALTH);
    const records = raw ? JSON.parse(raw) : [];
    return c.json(records);
  });

  // ─── Admin 页面 ────────────────────────────────────────
  app.get('/admin', (c) => {
    return c.html(adminHtml);
  });

  // ─── Admin API（需鉴权）────────────────────────────────
  app.get('/admin/sources', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const raw = await storage.get(KV_MANUAL_SOURCES);
    const sources: SourceEntry[] = raw ? JSON.parse(raw) : [];
    return c.json(sources);
  });

  app.post('/admin/sources', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    let body: { name?: string; url?: string; configKey?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    let url = body.url?.trim() || '';
    if (!url) return c.json({ error: 'URL is required' }, 400);

    // 自动提取 ;pk; 密钥
    let configKey = body.configKey?.trim() || '';
    const pkMatch = url.match(/;pk;(.+)$/);
    if (pkMatch) {
      configKey = configKey || pkMatch[1];
      url = url.replace(/;pk;.+$/, '');
    }

    try {
      new URL(url);
    } catch {
      return c.json({ error: 'Invalid URL format' }, 400);
    }

    const name = body.name?.trim() || '';
    const raw = await storage.get(KV_MANUAL_SOURCES);
    const sources: SourceEntry[] = raw ? JSON.parse(raw) : [];

    if (sources.some((s) => s.url === url)) {
      return c.json({ error: 'Source already exists' }, 409);
    }

    const entry: SourceEntry = { name, url };
    if (configKey) entry.configKey = configKey;
    sources.push(entry);
    await storage.put(KV_MANUAL_SOURCES, JSON.stringify(sources));

    return c.json({ success: true });
  });

  app.delete('/admin/sources', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    let body: { url?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    const url = body.url?.trim();
    if (!url) return c.json({ error: 'URL is required' }, 400);

    const raw = await storage.get(KV_MANUAL_SOURCES);
    const sources: SourceEntry[] = raw ? JSON.parse(raw) : [];
    const filtered = sources.filter((s) => s.url !== url);
    await storage.put(KV_MANUAL_SOURCES, JSON.stringify(filtered));

    return c.json({ success: true });
  });

  // ─── JSON 导入 ─────────────────────────────────────────
  app.post('/admin/sources/import', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    let body: { input?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    const input = body.input?.trim();
    if (!input) return c.json({ error: 'input is required' }, 400);

    // 判断是 URL 还是 JSON 内容
    const isUrl = /^https?:\/\//i.test(input);
    let jsonText: string;
    let sourceUrl: string | null = null;

    // 自动提取 ;pk; 密钥
    let configKey: string | undefined;
    let fetchUrl = input;
    if (isUrl) {
      const pkMatch = input.match(/;pk;(.+)$/);
      if (pkMatch) {
        configKey = pkMatch[1];
        fetchUrl = input.replace(/;pk;.+$/, '');
      }
      sourceUrl = fetchUrl;
      try {
        const resp = await fetch(fetchUrl, {
          headers: { 'Accept': 'application/json, text/plain, */*', 'User-Agent': 'okhttp/3.12.0' },
        });
        if (!resp.ok) return c.json({ error: `Fetch failed: HTTP ${resp.status}` }, 502);
        const buffer = await resp.arrayBuffer();
        const decoded = await decodeConfigResponse(buffer, configKey);
        jsonText = decoded || '';
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return c.json({ error: `Fetch failed: ${msg}` }, 502);
      }
    } else {
      jsonText = input;
    }

    const parsed = parseConfigJson(jsonText);
    if (!parsed) return c.json({ error: 'Failed to parse JSON' }, 400);

    // 读取现有源
    const raw = await storage.get(KV_MANUAL_SOURCES);
    const sources: SourceEntry[] = raw ? JSON.parse(raw) : [];
    const existingUrls = new Set(sources.map(s => s.url));

    let added = 0;
    let duplicates = 0;
    const addedSources: string[] = [];

    if (isMultiRepoConfig(parsed)) {
      // 多仓：提取子 URL 批量添加
      const entries = extractMultiRepoEntries(parsed, 'Imported');
      for (const entry of entries) {
        if (existingUrls.has(entry.url)) {
          duplicates++;
        } else {
          sources.push(entry);
          existingUrls.add(entry.url);
          addedSources.push(entry.url);
          added++;
        }
      }
      await storage.put(KV_MANUAL_SOURCES, JSON.stringify(sources));
      return c.json({ type: 'multi', added, duplicates, sources: addedSources });
    } else {
      // 单仓
      if (sourceUrl) {
        // 来自 URL：直接添加
        if (existingUrls.has(sourceUrl)) {
          return c.json({ type: 'single', added: 0, duplicates: 1, sources: [] });
        }
        const entry: SourceEntry = { name: 'Imported', url: sourceUrl };
        if (configKey) entry.configKey = configKey;
        sources.push(entry);
        await storage.put(KV_MANUAL_SOURCES, JSON.stringify(sources));
        return c.json({ type: 'single', added: 1, duplicates: 0, sources: [sourceUrl] });
      } else {
        // 粘贴的内容：存 KV 用 inline:// 引用
        const key = `${KV_INLINE_PREFIX}${Date.now()}`;
        await storage.put(key, jsonText);
        const inlineUrl = `inline://${key}`;
        sources.push({ name: 'Inline Config', url: inlineUrl });
        await storage.put(KV_MANUAL_SOURCES, JSON.stringify(sources));
        return c.json({ type: 'single', added: 1, duplicates: 0, sources: [inlineUrl] });
      }
    }
  });

  // ─── 名称定制 API ──────────────────────────────────────
  app.get('/admin/name-transform', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const raw = await storage.get(KV_NAME_TRANSFORM);
    const transform: NameTransformConfig = raw ? JSON.parse(raw) : {};
    return c.json(transform);
  });

  app.put('/admin/name-transform', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    let body: NameTransformConfig;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    // 验证额外正则语法
    if (body.extraCleanPatterns) {
      for (const p of body.extraCleanPatterns) {
        try { new RegExp(p); } catch {
          return c.json({ error: `Invalid regex: ${p}` }, 400);
        }
      }
    }

    const transform: NameTransformConfig = {
      prefix: body.prefix || undefined,
      suffix: body.suffix || undefined,
      promoReplacement: body.promoReplacement || undefined,
      extraCleanPatterns: body.extraCleanPatterns?.length ? body.extraCleanPatterns : undefined,
    };

    await storage.put(KV_NAME_TRANSFORM, JSON.stringify(transform));
    return c.json({ success: true });
  });

  // ─── 定时任务间隔 API ──────────────────────────────────
  app.get('/admin/cron-interval', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const raw = await storage.get(KV_CRON_INTERVAL);
    const interval = raw ? parseInt(raw) : DEFAULT_CRON_INTERVAL;
    return c.json({ interval });
  });

  app.put('/admin/cron-interval', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    let body: { interval?: number };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    const interval = body.interval;
    const validIntervals = [60, 180, 360, 720, 1440];
    if (!interval || !validIntervals.includes(interval)) {
      return c.json({ error: `interval must be one of: ${validIntervals.join(', ')}` }, 400);
    }

    await storage.put(KV_CRON_INTERVAL, String(interval));

    if (deps.onCronIntervalChange) {
      deps.onCronIntervalChange(interval);
    }

    return c.json({ success: true, interval });
  });

  // ─── 站点测速开关 ──────────────────────────────────────
  app.get('/admin/speed-test', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const raw = await storage.get(KV_SPEED_TEST_ENABLED);
    return c.json({ enabled: raw !== 'false' });
  });

  app.put('/admin/speed-test', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    let body: { enabled?: boolean };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    if (typeof body.enabled !== 'boolean') {
      return c.json({ error: 'enabled must be a boolean' }, 400);
    }

    await storage.put(KV_SPEED_TEST_ENABLED, String(body.enabled));
    return c.json({ success: true, enabled: body.enabled });
  });

  // ─── 边缘函数代理配置 Admin API ──────────────────────
  app.get('/admin/edge-proxies', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    const raw = await storage.get(KV_EDGE_PROXIES);
    return c.json(raw ? JSON.parse(raw) : {});
  });

  app.put('/admin/edge-proxies', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    let body: { cf?: string; vercel?: string };
    try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
    // 清理尾部斜杠
    const clean = {
      cf: body.cf?.replace(/\/+$/, '') || undefined,
      vercel: body.vercel?.replace(/\/+$/, '') || undefined,
    };
    await storage.put(KV_EDGE_PROXIES, JSON.stringify(clean));
    return c.json({ success: true, ...clean });
  });

  // ─── Fetch 代理端点（仅 CF 版，供本地 Docker 中转请求）──
  if (config.workerBaseUrl) {
    app.get('/fetch-proxy', async (c) => {
      // 认证：adminToken 或 refreshToken
      const auth = c.req.raw.headers.get('Authorization');
      const validTokens = [config.adminToken, config.refreshToken].filter(Boolean);
      if (validTokens.length > 0 && !validTokens.some((t) => auth === `Bearer ${t}`)) {
        return c.json({ error: 'Unauthorized' }, 401);
      }

      const targetUrl = c.req.query('url');
      if (!targetUrl || (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://'))) {
        return c.json({ error: 'Missing or invalid ?url= parameter' }, 400);
      }

      try {
        const resp = await fetch(targetUrl, {
          headers: {
            'User-Agent': c.req.header('X-Proxy-UA') || 'okhttp/3.12.0',
          },
          redirect: 'follow',
        });

        return new Response(resp.body, {
          status: resp.status,
          headers: {
            'Content-Type': resp.headers.get('Content-Type') || 'application/octet-stream',
            'Access-Control-Allow-Origin': '*',
          },
        });
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return c.json({ error: msg }, 502);
      }
    });
  }

  // ─── 搜索配额管理 ──────────────────────────────────────
  app.get('/admin/search-quota', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    const quota = await loadSearchQuota(storage);
    return c.json(quota);
  });

  app.put('/admin/search-quota', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    let body: Partial<SearchQuotaConfig>;
    try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }

    const current = await loadSearchQuota(storage);
    if (typeof body.maxSearchable === 'number') current.maxSearchable = body.maxSearchable;
    if (Array.isArray(body.pinnedKeys)) current.pinnedKeys = body.pinnedKeys;

    await saveSearchQuota(storage, current);
    return c.json({ success: true, ...current });
  });

  app.post('/admin/search-quota/pinned', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    let body: { keys?: string[] };
    try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
    if (!Array.isArray(body.keys)) return c.json({ error: 'keys must be an array' }, 400);

    const current = await loadSearchQuota(storage);
    const set = new Set(current.pinnedKeys);
    for (const key of body.keys) set.add(key);
    current.pinnedKeys = [...set];
    await saveSearchQuota(storage, current);
    return c.json({ success: true, pinnedKeys: current.pinnedKeys });
  });

  // 重排 pinned 顺序（整体替换）
  app.put('/admin/search-quota/pinned', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    let body: { keys?: string[] };
    try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
    if (!Array.isArray(body.keys)) return c.json({ error: 'keys must be an array' }, 400);

    const current = await loadSearchQuota(storage);
    current.pinnedKeys = body.keys;
    await saveSearchQuota(storage, current);
    return c.json({ success: true, pinnedKeys: current.pinnedKeys });
  });

  app.delete('/admin/search-quota/pinned', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    let body: { keys?: string[] };
    try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
    if (!Array.isArray(body.keys)) return c.json({ error: 'keys must be an array' }, 400);

    const current = await loadSearchQuota(storage);
    const removeSet = new Set(body.keys);
    current.pinnedKeys = current.pinnedKeys.filter(k => !removeSet.has(k));
    await saveSearchQuota(storage, current);
    return c.json({ success: true, pinnedKeys: current.pinnedKeys });
  });

  // 报告（admin 需鉴权）
  app.get('/admin/search-quota/report', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    const raw = await storage.get(KV_SEARCH_QUOTA_REPORT);
    if (!raw) return c.json({ error: 'No report yet. Run aggregation first.' }, 404);
    return c.json(JSON.parse(raw));
  });

  // 报告精简版（dashboard 无需鉴权）
  app.get('/search-quota/summary', async (c) => {
    const raw = await storage.get(KV_SEARCH_QUOTA_REPORT);
    if (!raw) return c.json({ enabled: false });
    return c.json({ enabled: true, ...JSON.parse(raw) });
  });

  // ─── 网盘凭证管理 API ───────────────────────────────────

  // 查看所有已登录平台状态
  app.get('/admin/cloud-credentials', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    const creds = await loadCredentials(storage);
    const result: Record<string, any> = {};
    for (const [platform, cred] of creds) {
      result[platform] = {
        platform: cred.platform,
        status: cred.status,
        obtainedAt: cred.obtainedAt,
        expiresAt: cred.expiresAt,
        hasCredential: Object.keys(cred.credential).length > 0,
      };
    }
    return c.json({ platforms: PLATFORM_NAMES, credentials: result });
  });

  // 注销指定平台
  app.delete('/admin/cloud-credentials/:platform', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    const platform = c.req.param('platform') as CloudPlatform;
    if (!PLATFORM_NAMES[platform]) return c.json({ error: 'Unknown platform' }, 400);
    await deleteCredential(storage, platform);
    return c.json({ success: true });
  });

  // 手动粘贴凭证
  app.post('/admin/cloud-credentials/:platform', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    const platform = c.req.param('platform') as CloudPlatform;
    if (!PLATFORM_NAMES[platform]) return c.json({ error: 'Unknown platform' }, 400);

    let body: { credential?: Record<string, string> };
    try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
    if (!body.credential || typeof body.credential !== 'object') {
      return c.json({ error: 'credential object is required' }, 400);
    }

    const cred: CloudCredential = {
      platform,
      credential: body.credential,
      obtainedAt: new Date().toISOString(),
      status: 'valid',
    };
    await saveCredential(storage, cred);
    return c.json({ success: true });
  });

  // 生成二维码
  app.post('/admin/cloud-login/:platform/qr', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    const platform = c.req.param('platform') as CloudPlatform;
    if (!QR_PLATFORMS.includes(platform)) {
      return c.json({ error: `Platform ${platform} does not support QR login` }, 400);
    }

    try {
      const result = await generateQR(platform);
      return c.json(result);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, 502);
    }
  });

  // 轮询扫码状态
  app.get('/admin/cloud-login/:platform/poll', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    const platform = c.req.param('platform') as CloudPlatform;
    const token = c.req.query('token');
    if (!token) return c.json({ error: 'token is required' }, 400);

    try {
      const result = await pollQRStatus(platform, token);

      // 登录成功：自动保存凭证
      if (result.status === 'confirmed' && result.credential) {
        const cred: CloudCredential = {
          platform,
          credential: result.credential,
          obtainedAt: new Date().toISOString(),
          status: 'valid',
        };
        await saveCredential(storage, cred);
      }

      return c.json(result);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg, status: 'error' }, 502);
    }
  });

  // 密码登录（迅雷/PikPak）
  app.post('/admin/cloud-login/:platform/password', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    const platform = c.req.param('platform') as CloudPlatform;
    if (!PASSWORD_PLATFORMS.includes(platform)) {
      return c.json({ error: `Platform ${platform} does not support password login` }, 400);
    }

    let body: { username?: string; password?: string };
    try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }

    try {
      const result = await passwordLogin(platform, body.username || '', body.password || '');
      if (result.success && result.credential) {
        const cred: CloudCredential = {
          platform,
          credential: result.credential,
          obtainedAt: new Date().toISOString(),
          status: 'valid',
        };
        await saveCredential(storage, cred);
      }
      return c.json(result);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ success: false, message: msg }, 502);
    }
  });

  // 凭证注入策略
  app.get('/admin/credential-policy', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    return c.json(await loadCredentialPolicy(storage));
  });

  app.put('/admin/credential-policy', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    let body: { allowedHighRiskKeys?: string[]; deniedKeys?: string[] };
    try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }

    const policy = await loadCredentialPolicy(storage);
    if (Array.isArray(body.allowedHighRiskKeys)) policy.allowedHighRiskKeys = body.allowedHighRiskKeys;
    if (Array.isArray(body.deniedKeys)) policy.deniedKeys = body.deniedKeys;
    await saveCredentialPolicy(storage, policy);
    return c.json({ success: true, ...policy });
  });

  // 风险分级报告
  app.get('/admin/credential-risk-report', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    const configRaw = await storage.get(KV_MERGED_CONFIG_FULL);
    if (!configRaw) return c.json({ error: 'No config available. Run aggregation first.' }, 404);

    const parsed: TVBoxConfig = JSON.parse(configRaw);
    const sites = parsed.sites || [];
    const assessments = assessAllSources(sites);
    const policy = await loadCredentialPolicy(storage);

    const summary = { safe: 0, low: 0, high: 0, unaudited: 0 };
    for (const a of assessments) {
      summary[a.riskLevel]++;
    }

    return c.json({ summary, assessments, policy });
  });

  // 自托管 token.json
  // ─── 自托管 token.json（网盘凭证，最高敏感）────────────
  //
  // 客户端（FongMi/TVBox）只能裸 GET，带不了 Bearer，所以不能简单加鉴权；
  // 但一条公开路径 + 明文 Cookie/refresh_token/账号密码 = 任何人（含任意网页 JS）
  // 都能拿走用户的网盘。原来这里没有鉴权还有 ACAO:*，等于全网可读。
  //
  // 现在的模型：
  //   · /credential/<32hex>/token.json —— 路径段本身就是凭证，不可猜；聚合时自动注入到源 ext
  //   · /credential/token.json         —— 老路径，改为需要管理 token（手动排障用）
  // 两条都不再回 Access-Control-Allow-Origin: *（原生客户端不需要 CORS，
  // 需要跨域读它的只有浏览器，那正是要挡的）。
  const serveTokenJson = async (): Promise<Response> => {
    const creds = await loadCredentials(storage);
    const body = creds.size === 0 ? {} : generateTokenJson(creds);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  };

  app.get('/credential/:secret/token.json', async (c) => {
    const provided = c.req.param('secret') || '';
    const expected = await ensureCredentialTokenSecret(storage);
    if (!constantTimeEqual(provided, expected)) {
      return c.json({ error: 'Not Found' }, 404);
    }
    return serveTokenJson();
  });

  app.get('/credential/token.json', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    return serveTokenJson();
  });

  // ─── MacCMS API 代理（CF 版 + 本地版）──────────────────────
  if (config.workerBaseUrl || config.localBaseUrl) {
    app.all('/api/:key', async (c) => {
      const key = c.req.param('key');
      const raw = await storage.get(KV_MACCMS_SOURCES);
      const sources: MacCMSSourceEntry[] = raw ? JSON.parse(raw) : [];
      const source = sources.find((s) => s.key === key);

      if (!source) {
        return c.json({ error: 'Unknown MacCMS source' }, 404);
      }

      const targetUrl = new URL(source.api);
      const reqUrl = new URL(c.req.url);
      reqUrl.searchParams.forEach((v, k) => targetUrl.searchParams.set(k, v));

      // 构造候选请求链：本地模式下优先走 edge（Vercel → CF），兜底直连
      const attempts: { label: string; url: string; headers: Record<string, string> }[] = [];

      if (!config.workerBaseUrl) {
        const edgeRaw = await storage.get(KV_EDGE_PROXIES);
        if (edgeRaw) {
          const edge: EdgeProxyConfig = JSON.parse(edgeRaw);
          const encoded = encodeURIComponent(targetUrl.toString());
          if (edge.vercel) {
            attempts.push({
              label: 'vercel',
              url: `${edge.vercel.replace(/\/$/, '')}/api/proxy?url=${encoded}`,
              headers: {},
            });
          }
          if (edge.cf) {
            attempts.push({
              label: 'cf',
              url: `${edge.cf.replace(/\/$/, '')}/fetch-proxy?url=${encoded}`,
              headers: config.adminToken ? { Authorization: `Bearer ${config.adminToken}` } : {},
            });
          }
        }
      }

      attempts.push({ label: 'direct', url: targetUrl.toString(), headers: {} });

      let lastError = '';
      for (const { label, url, headers } of attempts) {
        try {
          const resp = await fetch(url, {
            headers: { 'User-Agent': 'okhttp/3.12.0', ...headers },
            signal: AbortSignal.timeout(8000),
          });
          if (!resp.ok) {
            lastError = `upstream ${resp.status}`;
            console.log(`[maccms-proxy] ${key} via ${label} fail: ${lastError}`);
            continue;
          }
          const data = await resp.json();
          console.log(`[maccms-proxy] ${key} via ${label} ok`);
          return c.json(data, 200, {
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=300',
          });
        } catch (error: unknown) {
          lastError = error instanceof Error ? error.message : String(error);
          console.log(`[maccms-proxy] ${key} via ${label} fail: ${lastError}`);
        }
      }

      return c.json({ error: lastError || 'All proxies failed' }, 502);
    });
  }

  // ─── JAR 代理 ─────────────────────────────────────────
  if (config.workerBaseUrl) {
    // CF 版：用 CF Cache + KV 二进制缓存
    app.get('/jar/:key', async (c) => {
      const key = c.req.param('key');

      // 1. 查 CF Cache
      const cache = (caches as any).default as Cache;
      const cacheKey = new Request(c.req.url);
      const cached = await cache.match(cacheKey);
      if (cached) return cached;

      // 2. 查 KV 拿原始 URL
      const originalUrl = await lookupJarUrl(key, storage);
      if (!originalUrl) {
        return c.json({ error: 'Unknown JAR key' }, 404);
      }

      // 3. 流式透传
      const ttl = isMd5Key(key) ? 86400 : 21600; // MD5 key → 24h, URL hash → 6h
      try {
        const resp = await fetch(originalUrl, {
          headers: { 'User-Agent': 'okhttp/3.12.0' },
        });

        if (resp.ok) {
          const response = new Response(resp.body, {
            headers: {
              'Content-Type': 'application/octet-stream',
              'Cache-Control': `public, max-age=${ttl}`,
              'Access-Control-Allow-Origin': '*',
            },
          });
          c.executionCtx.waitUntil(cache.put(cacheKey, response.clone()));
          return response;
        }

        // Origin 失败 → 降级到 KV 二进制缓存
        console.log(`[jar-proxy] Origin returned ${resp.status} for ${key}, trying KV binary cache`);
      } catch (error: unknown) {
        console.log(`[jar-proxy] Origin fetch error for ${key}: ${error instanceof Error ? error.message : error}`);
      }

      // 4. 降级：从 KV 读取 base64 编码的 JAR 二进制
      const binBase64 = await storage.get('jar_bin:' + key);
      if (binBase64) {
        console.log(`[jar-proxy] Serving ${key} from KV binary cache`);
        const binary = base64ToUint8Array(binBase64);
        const response = new Response(binary, {
          headers: {
            'Content-Type': 'application/octet-stream',
            'Cache-Control': `public, max-age=${ttl}`,
            'Access-Control-Allow-Origin': '*',
          },
        });
        c.executionCtx.waitUntil(cache.put(cacheKey, response.clone()));
        return response;
      }

      return c.json({ error: 'JAR unavailable from origin and no binary cache' }, 502);
    });
  } else if (config.localBaseUrl) {
    // Node.js 版：用文件系统缓存
    const fs = require('fs');
    const pathMod = require('path');
    const jarCacheDir = pathMod.resolve(process.env.DATA_DIR || pathMod.join(process.cwd(), 'data'), 'jars');
    if (!fs.existsSync(jarCacheDir)) fs.mkdirSync(jarCacheDir, { recursive: true });

    // 并发下载锁：防止同一 JAR 被多个请求同时下载
    const downloadLocks = new Map<string, Promise<Buffer | null>>();

    async function fetchAndCacheJar(key: string, originalUrl: string): Promise<Buffer | null> {
      try {
        const resp = await fetch(originalUrl, {
          headers: { 'User-Agent': 'okhttp/3.12.0' },
        });
        if (!resp.ok) {
          console.log(`[jar-proxy] Origin returned ${resp.status} for ${key}`);
          return null;
        }
        const buf = Buffer.from(await resp.arrayBuffer());
        fs.writeFileSync(pathMod.join(jarCacheDir, `${key}.jar`), buf);
        console.log(`[jar-proxy] Cached ${key}.jar (${(buf.length / 1024).toFixed(1)} KB)`);
        return buf;
      } catch (error: unknown) {
        console.log(`[jar-proxy] Fetch error for ${key}: ${error instanceof Error ? error.message : error}`);
        return null;
      }
    }

    app.get('/jar/:key', async (c) => {
      const key = c.req.param('key');

      // 1. 查 storage 拿原始 URL
      const originalUrl = await lookupJarUrl(key, storage);
      if (!originalUrl) {
        return c.json({ error: 'Unknown JAR key' }, 404);
      }

      // 2. 查文件缓存
      const cachePath = pathMod.join(jarCacheDir, `${key}.jar`);
      if (fs.existsSync(cachePath)) {
        const stat = fs.statSync(cachePath);
        const ttl = isMd5Key(key) ? 86400_000 : 21600_000;
        if (Date.now() - stat.mtimeMs < ttl) {
          const buf = fs.readFileSync(cachePath);
          return new Response(buf, {
            headers: {
              'Content-Type': 'application/octet-stream',
              'Cache-Control': `public, max-age=${ttl / 1000}`,
              'Access-Control-Allow-Origin': '*',
            },
          });
        }
      }

      // 3. 下载（带并发锁）
      let downloading = downloadLocks.get(key);
      if (!downloading) {
        downloading = fetchAndCacheJar(key, originalUrl).finally(() => downloadLocks.delete(key));
        downloadLocks.set(key, downloading);
      }

      const buf = await downloading;
      if (buf) {
        return new Response(buf, {
          headers: {
            'Content-Type': 'application/octet-stream',
            'Cache-Control': `public, max-age=${isMd5Key(key) ? 86400 : 21600}`,
            'Access-Control-Allow-Origin': '*',
          },
        });
      }

      return c.json({ error: 'JAR unavailable from origin' }, 502);
    });
  }

  // ─── 直播源代理（仅 CF 版）──────────────────────────────
  if (config.workerBaseUrl) {
    app.get('/live/:key', async (c) => {
      const key = c.req.param('key');

      // 1. 查 CF Cache
      const cache = (caches as any).default as Cache;
      const cacheKey = new Request(c.req.url);
      const cached = await cache.match(cacheKey);
      if (cached) return cached;

      // 2. 查 KV 拿原始 URL
      const originalUrl = await lookupLiveUrl(key, storage);
      if (!originalUrl) {
        return c.json({ error: 'Unknown live source key' }, 404);
      }

      // 3. 流式透传
      try {
        const resp = await fetch(originalUrl, {
          headers: { 'User-Agent': 'okhttp/3.12.0' },
        });

        if (!resp.ok) {
          return c.json({ error: `Origin returned ${resp.status}` }, 502);
        }

        // 4. 构建响应 + 异步写缓存
        const response = new Response(resp.body, {
          headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': `public, max-age=${LIVE_PROXY_TTL}`,
            'Access-Control-Allow-Origin': '*',
          },
        });

        c.executionCtx.waitUntil(cache.put(cacheKey, response.clone()));
        return response;
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return c.json({ error: msg }, 502);
      }
    });
  }

  // ─── 图片代理（仅 CF 版）──────────────────────────────
  if (config.workerBaseUrl) {
    app.get('/img/*', async (c) => {
      // 从完整 URL 中提取原始图片地址（/img/ 之后的所有内容，含 query string）
      const fullUrl = c.req.url;
      const marker = '/img/';
      const markerIdx = fullUrl.indexOf(marker);
      const originalUrl = fullUrl.substring(markerIdx + marker.length);

      if (!originalUrl.startsWith('http://') && !originalUrl.startsWith('https://')) {
        return c.json({ error: 'Invalid image URL' }, 400);
      }

      // 1. 查 CF Cache
      const cache = (caches as any).default as Cache;
      const cacheKey = new Request(c.req.url);
      const cached = await cache.match(cacheKey);
      if (cached) return cached;

      // 2. 回源拉取
      try {
        const resp = await fetch(originalUrl, {
          headers: { 'User-Agent': 'okhttp/3.12.0' },
        });

        if (!resp.ok) {
          return c.json({ error: `Origin returned ${resp.status}` }, 502);
        }

        // 3. 构建响应 + 异步写缓存
        const contentType = resp.headers.get('Content-Type') || 'image/jpeg';
        const response = new Response(resp.body, {
          headers: {
            'Content-Type': contentType,
            'Cache-Control': `public, max-age=${IMG_PROXY_TTL}`,
            'Access-Control-Allow-Origin': '*',
          },
        });

        c.executionCtx.waitUntil(cache.put(cacheKey, response.clone()));
        return response;
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return c.json({ error: msg }, 502);
      }
    });
  }

  // ─── Live Sources Admin API ────────────────────────────
  app.get('/admin/lives', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const raw = await storage.get(KV_LIVE_SOURCES);
    const entries: LiveSourceEntry[] = raw ? JSON.parse(raw) : [];
    return c.json(entries);
  });

  app.post('/admin/lives', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    let body: { name?: string; url?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    const url = body.url?.trim();
    if (!url) return c.json({ error: 'URL is required' }, 400);

    try {
      new URL(url);
    } catch {
      return c.json({ error: 'Invalid URL format' }, 400);
    }

    const name = body.name?.trim() || '';
    const raw = await storage.get(KV_LIVE_SOURCES);
    const entries: LiveSourceEntry[] = raw ? JSON.parse(raw) : [];

    if (entries.some((e) => e.url === url)) {
      return c.json({ error: 'Live source already exists' }, 409);
    }

    entries.push({ name, url });
    await storage.put(KV_LIVE_SOURCES, JSON.stringify(entries));

    return c.json({ success: true });
  });

  app.delete('/admin/lives', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    let body: { url?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    const url = body.url?.trim();
    if (!url) return c.json({ error: 'URL is required' }, 400);

    const raw = await storage.get(KV_LIVE_SOURCES);
    const entries: LiveSourceEntry[] = raw ? JSON.parse(raw) : [];
    const filtered = entries.filter((e) => e.url !== url);
    await storage.put(KV_LIVE_SOURCES, JSON.stringify(filtered));

    return c.json({ success: true });
  });

  // ─── MacCMS Admin API ─────────────────────────────────
  app.get('/admin/maccms', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const raw = await storage.get(KV_MACCMS_SOURCES);
    const sources: MacCMSSourceEntry[] = raw ? JSON.parse(raw) : [];
    return c.json(sources);
  });

  app.post('/admin/maccms', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    let body: MacCMSSourceEntry | MacCMSSourceEntry[];
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    const newEntries = Array.isArray(body) ? body : [body];

    // 验证字段
    for (const entry of newEntries) {
      if (!entry.key?.trim() || !entry.name?.trim() || !entry.api?.trim()) {
        return c.json({ error: 'Each entry requires key, name, and api' }, 400);
      }
      try {
        new URL(entry.api);
      } catch {
        return c.json({ error: `Invalid URL: ${entry.api}` }, 400);
      }
    }

    const raw = await storage.get(KV_MACCMS_SOURCES);
    const sources: MacCMSSourceEntry[] = raw ? JSON.parse(raw) : [];
    const existingKeys = new Set(sources.map((s) => s.key));

    let added = 0;
    for (const entry of newEntries) {
      if (!existingKeys.has(entry.key)) {
        sources.push({ key: entry.key.trim(), name: entry.name.trim(), api: entry.api.trim() });
        existingKeys.add(entry.key);
        added++;
      }
    }

    await storage.put(KV_MACCMS_SOURCES, JSON.stringify(sources));
    return c.json({ success: true, added, total: sources.length });
  });

  app.delete('/admin/maccms', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    let body: { key?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    const key = body.key?.trim();
    if (!key) return c.json({ error: 'key is required' }, 400);

    const raw = await storage.get(KV_MACCMS_SOURCES);
    const sources: MacCMSSourceEntry[] = raw ? JSON.parse(raw) : [];
    const filtered = sources.filter((s) => s.key !== key);
    await storage.put(KV_MACCMS_SOURCES, JSON.stringify(filtered));

    return c.json({ success: true });
  });

  app.post('/admin/maccms/validate', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    let body: { api?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    const api = body.api?.trim();
    if (!api) return c.json({ error: 'api is required' }, 400);

    const ok = await validateMacCMS(api, config.siteTimeoutMs);
    return c.json({ api, valid: ok });
  });

  // ─── Config Editor 页面 ─────────────────────────────────
  app.get('/admin/config-editor', (c) => {
    return c.html(configEditorHtml);
  });

  // ─── Config Editor API ─────────────────────────────────
  app.get('/admin/config-data', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    // 读取过滤前的完整配置（含被屏蔽的项），降级到已过滤配置
    const full = await storage.get(KV_MERGED_CONFIG_FULL);
    const cached = full || await storage.get(KV_MERGED_CONFIG);
    if (!cached) {
      return c.json({ sites: [], parses: [], lives: [] });
    }

    let parsed: TVBoxConfig;
    try {
      parsed = JSON.parse(cached);
    } catch {
      return c.json({ error: 'Config parse error' }, 500);
    }

    const blacklist = await loadBlacklist(storage);
    const siteSet = new Set(blacklist.sites);
    const parseSet = new Set(blacklist.parses);
    const liveSet = new Set(blacklist.lives);

    // 预编译正则规则用于标记 regexBlocked
    const activeRegexRules = blacklist.regexRules.filter(r => r.enabled);
    const compiledRegex: Array<{ re: RegExp; field: string }> = [];
    for (const rule of activeRegexRules) {
      try { compiledRegex.push({ re: new RegExp(rule.pattern, 'i'), field: rule.field }); } catch { /* skip */ }
    }
    const overrideSet = new Set(blacklist.regexBlockOverrides);

    // Build sites with fingerprint + blocked status + group
    // 指纹用聚合时在「凭证注入前」算好的那一份：输出配置里的 ext 已被注入改写，
    // 现算会和黑名单（注入前算）对不上，界面上就会出现「明明拉黑了却不显示已屏蔽」，
    // 从这里点「屏蔽」写进去的指纹也永远不会命中。
    let fpCache: Map<string, string> | null = null;
    try {
      const rawFp = await storage.get(KV_SITE_FP);
      if (rawFp) {
        const parsedFp = JSON.parse(rawFp) as { map?: Record<string, string> };
        if (parsedFp?.map) fpCache = new Map(Object.entries(parsedFp.map));
      }
    } catch { /* 缓存缺失就走现算 */ }
    const sites = [];
    for (const site of parsed.sites || []) {
      const fp = await siteFingerprintCached(site, fpCache);
      const api = site.api || '';
      let group = '其他';
      if (api.startsWith('csp_') || api.startsWith('py_') || api.startsWith('js_')) {
        group = api;
      } else if (api.startsWith('http')) {
        try { group = '远程: ' + new URL(api).hostname; } catch { group = '远程源'; }
      }
      const fpBlocked = siteSet.has(fp);
      let regexBlocked = false;
      let regexPattern = '';
      if (!fpBlocked && !overrideSet.has(site.name || '')) {
        for (const { re, field } of compiledRegex) {
          const value = String((site as unknown as Record<string, unknown>)[field] || '');
          if (re.test(value)) { regexBlocked = true; regexPattern = re.source; break; }
        }
      }
      sites.push({ ...site, fingerprint: fp, blocked: fpBlocked || regexBlocked, regexBlocked, regexPattern, group });
    }

    const parses = (parsed.parses || []).map(p => ({
      ...p,
      blocked: parseSet.has(p.url),
    }));

    const lives = (parsed.lives || []).map(l => ({
      ...l,
      blocked: liveSet.has(l.url || l.api || ''),
    }));

    return c.json({ sites, parses, lives });
  });

  app.post('/admin/blacklist', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    let body: { type?: string; id?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    const { type, id } = body;
    if (!type || !id) return c.json({ error: 'type and id are required' }, 400);
    if (!['sites', 'parses', 'lives'].includes(type)) {
      return c.json({ error: 'type must be sites, parses, or lives' }, 400);
    }

    const blacklist = await loadBlacklist(storage);
    const list = blacklist[type as keyof typeof blacklist] as string[];
    if (!list.includes(id)) {
      list.push(id);
    }
    await saveBlacklist(storage, blacklist);
    await patchMergedConfig();

    return c.json({ success: true });
  });

  app.post('/admin/blacklist/batch', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    let body: { type?: string; ids?: string[] };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    const { type, ids } = body;
    if (!type || !Array.isArray(ids) || ids.length === 0) {
      return c.json({ error: 'type and ids[] are required' }, 400);
    }
    if (ids.length > 500) {
      return c.json({ error: 'Too many ids (max 500)' }, 400);
    }
    if (!['sites', 'parses', 'lives'].includes(type)) {
      return c.json({ error: 'type must be sites, parses, or lives' }, 400);
    }

    const blacklist = await loadBlacklist(storage);
    const list = blacklist[type as keyof typeof blacklist] as string[];
    let added = 0;
    for (const id of ids) {
      if (typeof id === 'string' && !list.includes(id)) {
        list.push(id);
        added++;
      }
    }
    await saveBlacklist(storage, blacklist);
    await patchMergedConfig();

    return c.json({ success: true, added });
  });

  app.delete('/admin/blacklist', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    let body: { type?: string; id?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    const { type, id } = body;
    if (!type || !id) return c.json({ error: 'type and id are required' }, 400);
    if (!['sites', 'parses', 'lives'].includes(type)) {
      return c.json({ error: 'type must be sites, parses, or lives' }, 400);
    }

    const blacklist = await loadBlacklist(storage);
    const key = type as keyof typeof blacklist;
    (blacklist[key] as string[]) = (blacklist[key] as string[]).filter((v: string) => v !== id);
    await saveBlacklist(storage, blacklist);
    await patchMergedConfig();

    return c.json({ success: true });
  });

  // ─── 黑名单变更后实时 patch merged_config ──────────────
  async function patchMergedConfig(): Promise<void> {
    const fullRaw = await storage.get(KV_MERGED_CONFIG_FULL);
    if (!fullRaw) return;
    const blacklist = await loadBlacklist(storage);
    const hasBlacklist = blacklist.sites.length > 0 || blacklist.parses.length > 0 || blacklist.lives.length > 0 || blacklist.regexRules.some(r => r.enabled);

    let result: TVBoxConfig;
    if (!hasBlacklist) {
      result = JSON.parse(fullRaw);
    } else {
      const fullConfig: TVBoxConfig = JSON.parse(fullRaw);
      const { config: filtered } = await applyBlacklist(fullConfig, blacklist);
      result = filtered;
    }

    // 保留当前已合并的 Native lives（避免回退到 FongMi 格式）
    const currentRaw = await storage.get(KV_MERGED_CONFIG);
    if (currentRaw) {
      try {
        const current: TVBoxConfig = JSON.parse(currentRaw);
        if (Array.isArray(current.lives) && current.lives.length > 0 && current.lives[0]?.group) {
          result.lives = current.lives;
        }
      } catch { /* ignore parse error */ }
    }

    // 重新应用 JAR proxy rewrite（与 aggregator Step 7 一致）
    result = await rewriteJarUrls(result, BASE_URL_PLACEHOLDER, storage);
    await storage.put(KV_MERGED_CONFIG, JSON.stringify(result));
  }

  // ─── 正则黑名单 ─────────────────────────────────────────
  app.get('/admin/blacklist/regex', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    const blacklist = await loadBlacklist(storage);
    return c.json({ rules: blacklist.regexRules, overrides: blacklist.regexBlockOverrides });
  });

  app.post('/admin/blacklist/regex', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    if (deps.isSyncing?.()) return c.json({ error: 'Aggregation in progress, try later' }, 409);
    const body = await c.req.json<{ pattern: string; field: 'name' | 'api' | 'key'; enabled?: boolean }>();
    if (!body.pattern || !['name', 'api', 'key'].includes(body.field)) {
      return c.json({ error: 'Invalid input: pattern and field (name|api|key) required' }, 400);
    }
    const validation = validateRegexRule(body.pattern);
    if (!validation.ok) return c.json({ error: validation.error }, 400);
    const rule = {
      id: crypto.randomUUID().slice(0, 8),
      pattern: body.pattern,
      field: body.field,
      enabled: body.enabled !== false,
      createdAt: new Date().toISOString(),
    };
    const blacklist = await loadBlacklist(storage);
    await saveRegexRule(storage, blacklist, rule);
    await patchMergedConfig();
    return c.json({ success: true, rule });
  });

  app.put('/admin/blacklist/regex/:id', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    if (deps.isSyncing?.()) return c.json({ error: 'Aggregation in progress, try later' }, 409);
    const id = c.req.param('id');
    const body = await c.req.json<{ pattern?: string; field?: 'name' | 'api' | 'key'; enabled?: boolean }>();
    if (body.pattern) {
      const validation = validateRegexRule(body.pattern);
      if (!validation.ok) return c.json({ error: validation.error }, 400);
    }
    if (body.field && !['name', 'api', 'key'].includes(body.field)) {
      return c.json({ error: 'Invalid field' }, 400);
    }
    const blacklist = await loadBlacklist(storage);
    if (!blacklist.regexRules.find(r => r.id === id)) return c.json({ error: 'Rule not found' }, 404);
    await updateRegexRule(storage, blacklist, id, body);
    await patchMergedConfig();
    return c.json({ success: true });
  });

  app.delete('/admin/blacklist/regex/:id', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    const id = c.req.param('id');
    const blacklist = await loadBlacklist(storage);
    if (!blacklist.regexRules.find(r => r.id === id)) return c.json({ error: 'Rule not found' }, 404);
    await deleteRegexRule(storage, blacklist, id);
    await patchMergedConfig();
    return c.json({ success: true });
  });

  app.post('/admin/blacklist/regex/test', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    const body = await c.req.json<{ pattern: string; field: 'name' | 'api' | 'key' }>();
    if (!body.pattern || !['name', 'api', 'key'].includes(body.field)) {
      return c.json({ error: 'Invalid input' }, 400);
    }
    const validation = validateRegexRule(body.pattern);
    if (!validation.ok) return c.json({ error: validation.error }, 400);
    const raw = await storage.get(KV_MERGED_CONFIG_FULL);
    if (!raw) return c.json({ matched: [] });
    const fullConfig: TVBoxConfig = JSON.parse(raw);
    const result = testRegexAgainstSites(fullConfig.sites || [], body.pattern, body.field);
    return c.json(result);
  });

  // ─── 聚合日志 ──────────────────────────────────────────
  app.get('/admin/agg-logs', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const raw = await storage.get(KV_AGG_LOGS);
    const logs = raw ? JSON.parse(raw) : [];
    const limitStr = c.req.query('limit');
    const limit = limitStr ? Math.min(parseInt(limitStr) || 20, 50) : 20;
    const sliced = logs.slice(-limit).reverse();
    return c.json({ total: logs.length, logs: sliced });
  });

  app.delete('/admin/agg-logs', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    await storage.put(KV_AGG_LOGS, '[]');
    return c.json({ success: true });
  });

  // ─── 分组排序 ──────────────────────────────────────────
  app.get('/admin/group-order', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const cfg = await loadGroupOrder(storage);
    return c.json(cfg);
  });

  app.put('/admin/group-order', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    let body: { rules?: unknown; unmatchedPosition?: string; enabled?: boolean };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }
    const cfg = {
      rules: Array.isArray(body.rules) ? body.rules : [],
      unmatchedPosition: (body.unmatchedPosition === 'before' ? 'before' : 'after') as 'before' | 'after',
      enabled: body.enabled !== false,
    };
    await saveGroupOrder(storage, cfg);
    return c.json({ success: true, ...cfg });
  });

  // ─── 去重配置 ──────────────────────────────────────────
  app.get('/admin/dedup-config', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const raw = await storage.get(KV_DEDUP_CONFIG);
    if (!raw) {
      return c.json({ similarDedup: true, similarDedupThreshold: 0.85 });
    }
    try {
      return c.json(JSON.parse(raw));
    } catch {
      return c.json({ similarDedup: true, similarDedupThreshold: 0.85 });
    }
  });

  app.put('/admin/dedup-config', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    let body: { similarDedup?: boolean; similarDedupThreshold?: number };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }
    const cfg = {
      similarDedup: body.similarDedup !== false,
      similarDedupThreshold: typeof body.similarDedupThreshold === 'number'
        ? Math.max(0.5, Math.min(1.0, body.similarDedupThreshold))
        : 0.85,
    };
    await storage.put(KV_DEDUP_CONFIG, JSON.stringify(cfg));
    return c.json({ success: true, ...cfg });
  });

  // ─── 背景设置 ──────────────────────────────────────────
  app.get('/api/bg-settings', async (c) => {
    const raw = await storage.get(KV_BG_SETTINGS);
    if (!raw) return c.json({ type: 'default' });
    try {
      return c.json(JSON.parse(raw));
    } catch {
      return c.json({ type: 'default' });
    }
  });

  app.put('/admin/bg-settings', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    let body: { type?: string; imageUrl?: string; overlay?: number; solidColor?: string; gradient?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }
    const cfg = {
      type: body.type || 'default',
      imageUrl: body.imageUrl || '',
      overlay: typeof body.overlay === 'number' ? Math.max(0, Math.min(100, body.overlay)) : 85,
      solidColor: body.solidColor || '#0a0e14',
      gradient: body.gradient || '',
    };
    await storage.put(KV_BG_SETTINGS, JSON.stringify(cfg));
    return c.json({ success: true, ...cfg });
  });

  // ─── 刷新 ─────────────────────────────────────────────
  // 注意：只有配了 REFRESH_TOKEN / ADMIN_TOKEN 才校验。两者都空时这里放行 ——
  // 即「默认部署任何人可触发聚合」。这是刻意保留的（TVBox 侧/脚本要能触发），
  // 代价是未配 token 的实例可被外部反复触发重跑；需要收紧就配 ADMIN_TOKEN。
  app.post('/refresh', async (c) => {
    if (config.refreshToken || config.adminToken) {
      const auth = c.req.raw.headers.get('Authorization');
      const validTokens = [config.refreshToken, config.adminToken].filter(Boolean);
      if (!validTokens.some((t) => auth === `Bearer ${t}`)) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
    }

    try {
      await deps.triggerRefresh();
      return c.json({ success: true, message: 'Refresh completed' });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      return c.json({ success: false, error: msg }, 500);
    }
  });

  // ─── 输出前复核首位源开关 ──────────────────────────────────
  // 默认开；这条曾因死锁被手工置 false，界面上必须能看见、能改回来
  app.get('/admin/live-head-verify', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    const raw = await storage.get(KV_LIVE_HEAD_VERIFY);
    return c.json({ enabled: raw !== 'false' });
  });

  app.put('/admin/live-head-verify', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    const body = await c.req.json<{ enabled: boolean }>();
    await storage.put(KV_LIVE_HEAD_VERIFY, body.enabled ? 'true' : 'false');
    return c.json({ success: true, enabled: !!body.enabled });
  });

  // ─── 直播禁用开关 ─────────────────────────────────────────
  app.get('/admin/live-disabled', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    const raw = await storage.get(KV_LIVE_DISABLED);
    return c.json({ disabled: raw === 'true' });
  });

  app.put('/admin/live-disabled', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    if (deps.isSyncing?.()) {
      return c.json({ error: 'Aggregation in progress, try later' }, 409);
    }
    const body = await c.req.json<{ disabled: boolean }>();
    await storage.put(KV_LIVE_DISABLED, body.disabled ? 'true' : 'false');
    return c.json({ success: true, disabled: body.disabled });
  });

  // ─── 直播合并模式 ─────────────────────────────────────────
  app.get('/admin/live-merge-mode', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    const raw = await storage.get(KV_LIVE_MERGE_MODE);
    return c.json({ mode: raw || 'separated' });
  });

  app.put('/admin/live-merge-mode', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    if (deps.isSyncing?.()) {
      return c.json({ error: 'Aggregation in progress, try later' }, 409);
    }
    const body = await c.req.json<{ mode: string }>();
    const mode = body.mode === 'merged' ? 'merged' : 'separated';
    await storage.put(KV_LIVE_MERGE_MODE, mode);
    try { await deps.triggerRefresh(); } catch { /* best effort */ }
    return c.json({ success: true, mode });
  });

  // ─── 智能 Base URL 开关 ──────────────────────────────────
  app.get('/admin/smart-base-url', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    const raw = await storage.get(KV_SMART_BASE_URL_ENABLED);
    return c.json({ enabled: raw === 'true' });
  });

  app.put('/admin/smart-base-url', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    const body = await c.req.json<{ enabled: boolean }>();
    await storage.put(KV_SMART_BASE_URL_ENABLED, body.enabled ? 'true' : 'false');
    return c.json({ success: true, enabled: body.enabled });
  });

  // ─── 站点验活设置 ───────────────────────────────────────
  app.get('/admin/site-probe-depth', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    const raw = await storage.get(KV_SITE_PROBE_DEPTH);
    return c.json({ depth: raw || 'deep' });
  });

  app.put('/admin/site-probe-depth', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    const body = await c.req.json<{ depth: 'shallow' | 'deep' }>();
    if (!['shallow', 'deep'].includes(body.depth)) return c.json({ error: 'Invalid depth' }, 400);
    await storage.put(KV_SITE_PROBE_DEPTH, body.depth);
    return c.json({ success: true, depth: body.depth });
  });

  app.get('/admin/site-auto-clean', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    const raw = await storage.get(KV_SITE_AUTO_CLEAN);
    return c.json({ enabled: raw === 'true' });
  });

  app.put('/admin/site-auto-clean', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    const body = await c.req.json<{ enabled: boolean }>();
    await storage.put(KV_SITE_AUTO_CLEAN, body.enabled ? 'true' : 'false');
    return c.json({ success: true, enabled: body.enabled });
  });

  // 「保留链接」开关 + 跳过名单管理
  app.get('/admin/site-keep-link', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    const raw = await storage.get(KV_SITE_KEEP_LINK);
    const skip = await loadSkipList(storage);
    return c.json({ enabled: raw === 'true', skipped: skip.length });
  });

  app.put('/admin/site-keep-link', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    const body = await c.req.json<{ enabled: boolean }>();
    await storage.put(KV_SITE_KEEP_LINK, body.enabled ? 'true' : 'false');
    return c.json({ success: true, enabled: body.enabled });
  });

  app.delete('/admin/site-keep-link', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    await clearSkipList(storage);
    return c.json({ success: true });
  });

  // ─── FTP 对外发布 ───────────────────────────────────
  app.get('/admin/ftp-sync', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    const cfg = await loadFtpConfig(storage);
    const { password, ...rest } = cfg;
    return c.json({ ...rest, hasPassword: !!password });
  });

  app.put('/admin/ftp-sync', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    const body = await c.req.json<Partial<FtpSyncConfig>>();
    const current = await loadFtpConfig(storage);
    const next: FtpSyncConfig = {
      enabled: body.enabled !== undefined ? !!body.enabled : current.enabled,
      host: (body.host ?? current.host).trim(),
      port: Number(body.port) > 0 ? Number(body.port) : current.port,
      user: (body.user ?? current.user).trim(),
      // 密码留空表示不修改
      password: body.password ? body.password : current.password,
      remotePath: (body.remotePath ?? current.remotePath) || '/live.txt',
      secure: body.secure !== undefined ? !!body.secure : current.secure,
      publicUrl: (body.publicUrl ?? current.publicUrl).trim(),
    };
    await saveFtpConfig(storage, next);
    return c.json({ success: true, enabled: next.enabled });
  });

  app.post('/admin/ftp-sync/test', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    const body = await c.req.json<Partial<FtpSyncConfig>>();
    const current = await loadFtpConfig(storage);
    const cfg: FtpSyncConfig = {
      ...current,
      ...body,
      password: body.password ? body.password : current.password,
      host: (body.host ?? current.host).trim(),
      user: (body.user ?? current.user).trim(),
      port: Number(body.port) > 0 ? Number(body.port) : current.port,
    } as FtpSyncConfig;
    if (!cfg.host || !cfg.user) return c.json({ ok: false, error: '请先填写主机和用户名' });
    const res = await testFtpConnection(cfg);
    return c.json(res);
  });

  app.post('/admin/ftp-sync/run', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    const cfg = await loadFtpConfig(storage);
    if (!cfg.host || !cfg.user) return c.json({ ok: false, error: 'FTP 未配置' });

    const raw = await storage.get(KV_MERGED_CONFIG);
    if (!raw) return c.json({ ok: false, error: '还没有生成过配置，请先刷新一次' });
    try {
      const full = JSON.parse(raw);
      const lives = Array.isArray(full.lives) ? full.lives : [];
      if (lives.length === 0) return c.json({ ok: false, error: '当前没有直播数据' });
      const txt = formatLiveGroupsAsTxt(lives as unknown as TVBoxLiveGroup[]);
      const res = await uploadLiveTxt(cfg, txt);
      return c.json(res);
    } catch (err) {
      return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/admin/site-health', async (c) => {
    if (!verifyAdmin(c.req.raw, config)) return c.json({ error: 'Unauthorized' }, 401);
    const raw = await storage.get(KV_SITE_HEALTH_MAP);
    const healthMap = raw ? JSON.parse(raw) : {};
    return c.json(healthMap);
  });

  // 频道级测速 admin 路由（仅 Node/Docker 启用）
  if (deps.enableChannelProbe) {
    mountChannelProbeRoutes(app, { storage, config, triggerRefresh: deps.triggerRefresh });
    mountChannelOrderRoutes(app, { storage, config, triggerRefresh: deps.triggerRefresh });
    mountChannelRoutes(app, { storage, config, triggerRefresh: deps.triggerRefresh });
    mountHealthRoutes(app, { storage, config });
    mountSchedulerRoutes(app, { storage, config, isSyncing: deps.isSyncing });
    mountCurationRoutes(app, { storage, config, triggerRefresh: deps.triggerRefresh });
  }

  // Builder 路由（仅 Node/Docker 启用，动态 import 避免 CF bundle 引入 fs/path）
  if (deps.enableBuilder) {
    import('./routes/builder').then(({ mountBuilderRoutes }) => {
      mountBuilderRoutes(app, { storage, config });
    });
  }

  // ─── 图片代理（供 reader 漫画阅读器使用）─────────────────
  app.get('/img-proxy', async (c) => {
    const url = c.req.query('url');
    const check = checkPublicUrl(url);
    if (!check.ok || !check.url) return c.text(check.reason || 'missing url', 400);

    let referer = c.req.query('referer') || check.url.origin + '/';
    if (!checkPublicUrl(referer).ok) referer = check.url.origin + '/';

    try {
      const resp = await fetchPublic(check.url.toString(), {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Referer': referer,
          'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
        },
      });

      if (!resp.ok) return c.body(null, resp.status as 502);

      return new Response(resp.body, {
        headers: {
          'Content-Type': resp.headers.get('content-type') || 'image/jpeg',
          'Cache-Control': 'public, max-age=86400',
          'Access-Control-Allow-Origin': '*',
        },
      });
    } catch {
      return c.body(null, 502);
    }
  });

  // ─── Reader 通用代理（无 auth，供 reader 后端中转被封站点）──
  // 无鉴权 + 任意 URL = SSRF 入口（实测可读 127.0.0.1）。这里拦私网/回环/非 http(s)，
  // 并逐跳校验重定向；公网站点中转能力保持不变。
  app.get('/reader-proxy', async (c) => {
    const url = c.req.query('url');
    const check = checkPublicUrl(url);
    if (!check.ok || !check.url) return c.text(check.reason || 'missing url', 400);

    let referer = c.req.query('referer') || check.url.origin + '/';
    if (!checkPublicUrl(referer).ok) referer = check.url.origin + '/';
    const cookie = c.req.query('cookie') || '';

    const headers: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
      'Referer': referer,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
    };
    if (cookie) headers['Cookie'] = cookie;

    try {
      const resp = await fetchPublic(check.url.toString(), { headers });

      return new Response(resp.body, {
        status: resp.status,
        headers: {
          'Content-Type': resp.headers.get('content-type') || 'text/plain',
          'Access-Control-Allow-Origin': '*',
        },
      });
    } catch {
      return c.body(null, 502);
    }
  });

  return app;
}

