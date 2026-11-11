// 聚合流程编排

import type { Storage } from './storage/interface';
import type { AppConfig, SourceEntry, SourcedConfig, MacCMSSourceEntry, SourceFetchResult, SourceHealthRecord, AggregationLog, AggLogFailedSource, AggLogSiteChange, TVBoxSite } from './core/types';
import { fetchConfigs } from './core/fetcher';
import { mergeConfigs, cleanLocalRefs, cleanEmptyEntries } from './core/merger';
import { batchSiteSpeedTest, appendSpeedToName, filterUnreachableSites, type SiteProbeResult } from './core/speedtest';
import { macCMSToTVBoxSites, processMacCMSForLocal } from './core/maccms';
import { rewriteJarUrls } from './core/jar-proxy';
import { mergeLivesToNative, separatedMergeLives, formatLiveGroupsAsTxt, type LiveSourceInput } from './core/live-merger';
import { loadDeadUrls, purgeProtectedUrls, condemnExpired } from './core/live-deadlist';
import { loadHostMap, isHostCondemned } from './core/host-health';
import { reverifyHeadSources } from './core/live-verify';
import { withProbeNet } from './core/probe-net';
import { trimGroupsToTopN } from './core/live-url';
import { loadChannelOrder, applyChannelOrder } from './core/live-order';
import { loadOverrides, curateGroups, isFocusChannel, loadCurationRules, applyChannelExclusions } from './core/channel-curation';
import { resolveCrossChannelConflicts } from './core/channel-conflicts';
import { runQualityGuarantee, buildCoverageReport, type GuaranteeStats } from './core/source-guarantee';
import { loadRegistry, saveRegistry, upsertFromGroups } from './core/channel-registry';
import { loadLiveGroupMerge } from './core/live-groups';
import { loadShoppingFilter } from './core/live-filters';
import { loadFtpConfig, uploadLiveTxt } from './core/ftp-sync';
import { loadSkipList, addSkipList } from './core/site-skip';
import { bareUrl } from './core/live-url';
import { loadSpeedMap as loadChannelSpeedMap, saveSpeedMap, runChannelProbe, isProbeEnabled } from './core/channel-probe';
import { KV_MERGED_CONFIG, KV_MERGED_CONFIG_FULL, KV_SOURCE_URLS, KV_LAST_UPDATE, KV_MANUAL_SOURCES, KV_MACCMS_SOURCES, KV_LIVE_SOURCES, KV_BLACKLIST, KV_INLINE_PREFIX, KV_NAME_TRANSFORM, KV_SOURCE_HEALTH, KV_SPEED_TEST_ENABLED, KV_EDGE_PROXIES, KV_SEARCH_QUOTA_REPORT, KV_CHANNEL_MERGED_TREE, KV_AGG_LOGS, AGG_LOGS_MAX, KV_SITE_SNAPSHOT, KV_SITE_KEEP_LINK, KV_CHANNEL_PROBE_INLINE, KV_CHANNEL_PROBE_SEGMENT, KV_LIVE_HEAD_VERIFY, KV_LIVE_TOP_N, KV_LIVE_USE_CONFIG_LIVES, KV_LIVE_HIDE_DEAD, KV_DEDUP_CONFIG, KV_LIVE_DISABLED, KV_LIVE_MERGE_MODE, BASE_URL_PLACEHOLDER, KV_SITE_HEALTH_MAP, KV_SITE_PROBE_DEPTH, KV_SITE_AUTO_CLEAN, KV_SITE_FP, KV_SOURCE_MAP, KV_LIVE_QUALITY_GUARANTEE, KV_LIVE_QUALITY_GAP, QUALITY_GUARANTEE_BUDGET_MS } from './core/config';
import { loadBlacklist, applyBlacklist, pruneBlacklist, saveBlacklist, computeFingerprints, siteFingerprintCached } from './core/blacklist';
import { transformSiteNames } from './core/cleaner';
import { parseConfigJson, type FetchProxyConfig } from './core/fetcher';
import { scrapeSourceList, scrapeMacCMSSources, type ScrapeSourceConfig, type ScrapeMacCMSConfig } from './core/source-scraper';
import { loadSearchQuota, applySearchQuota } from './core/search-quota';
import { loadCredentials, loadCredentialPolicy, ensureCredentialTokenSecret } from './core/credential-store';
import { injectCredentials } from './core/credential-injector';
import { loadGroupOrder, applyGroupOrder } from './core/group-order';
import { deduplicateSimilarNames } from './core/dedup';
import { logger } from './core/logger';
import type { NameTransformConfig, EdgeProxyConfig, TVBoxLiveGroup } from './core/types';

export async function runAggregation(storage: Storage, config: AppConfig): Promise<void> {
  const startTime = Date.now();
  logger.info('aggregation', 'Starting...');

  try {
    await _runAggregation(storage, config, startTime);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : '';
    logger.error('aggregation', `FATAL ERROR: ${msg}`);
    logger.error('aggregation', `Stack: ${stack}`);
    // 写入错误信息方便调试
    await storage.put(KV_LAST_UPDATE, `ERROR @ ${new Date().toISOString()}: ${msg}`);

    await appendAggLog(storage, {
      id: new Date(startTime).toISOString(),
      startTime: new Date(startTime).toISOString(),
      endTime: new Date().toISOString(),
      durationMs: Date.now() - startTime,
      success: false,
      errorMessage: msg,
      totalSources: 0,
      okSources: 0,
      failedSources: [],
      addedSites: [],
      removedSites: [],
      finalSiteCount: 0,
      finalParseCount: 0,
      finalLiveCount: 0,
      blacklistRemovedSites: 0,
      blacklistRemovedParses: 0,
      blacklistRemovedLives: 0,
    });
  }
}

async function _runAggregation(storage: Storage, config: AppConfig, startTime: number): Promise<void> {

  // ── 日志收集用局部变量 ──
  let logFetchResults: SourceFetchResult[] = [];
  let logBlacklistRemovedSites = 0;
  let logBlacklistRemovedParses = 0;
  let logBlacklistRemovedLives = 0;

  // 读取上次站点快照（用于计算 diff）
  const snapshotRaw = await storage.get(KV_SITE_SNAPSHOT);
  const prevSiteKeys: Set<string> = snapshotRaw ? new Set(JSON.parse(snapshotRaw)) : new Set();

  // Step 0: 自动抓取源（需配置 SCRAPE_SOURCE_URL 环境变量，referer 可选）
  if (config.scrapeSourceUrl) {
    logger.info('aggregation', 'Step 0: Auto-scraping sources...');
    try {
      const scrapeCfg: ScrapeSourceConfig = { url: config.scrapeSourceUrl, referer: config.scrapeSourceReferer || '' };
      const scraped = await scrapeSourceList(scrapeCfg);
      if (scraped.length > 0) {
        const existingRaw = await storage.get(KV_MANUAL_SOURCES);
        const existingSources: SourceEntry[] = existingRaw ? JSON.parse(existingRaw) : [];
        const existingUrls = new Set(existingSources.map(s => s.url));

        let added = 0;
        for (const source of scraped) {
          if (!existingUrls.has(source.url)) {
            existingSources.push(source);
            existingUrls.add(source.url);
            added++;
          }
        }

        if (added > 0) {
          await storage.put(KV_MANUAL_SOURCES, JSON.stringify(existingSources));
          logger.infoFields('aggregation', 'auto-scrape-added', { added, total: existingSources.length });
        } else {
          logger.infoFields('aggregation', 'auto-scrape-none-new', { scraped: scraped.length });
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn('aggregation', `Auto-scrape failed (non-blocking): ${msg}`);
    }
  }

  // Step 0.5: MacCMS 资源站自动抓取（需配置 MACCMS_API_URL 环境变量）
  if (config.maccmsApiUrl && config.maccmsAesKey && config.maccmsAesIv) {
    logger.info('aggregation', 'Step 0.5: Auto-scraping MacCMS sources...');
    try {
      const maccmsCfg: ScrapeMacCMSConfig = { apiUrl: config.maccmsApiUrl, aesKey: config.maccmsAesKey, aesIv: config.maccmsAesIv };
      const scraped = await scrapeMacCMSSources(maccmsCfg);
      if (scraped.length > 0) {
        await storage.put(KV_MACCMS_SOURCES, JSON.stringify(scraped));
        logger.infoFields('aggregation', 'maccms-auto-scraped', { count: scraped.length });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn('aggregation', `MacCMS auto-scrape failed (non-blocking): ${msg}`);
    }
  }

  // Step 1: 读取手动配置的源（含自动抓取合并后的）
  logger.info('aggregation', 'Step 1: Loading sources...');
  const raw = await storage.get(KV_MANUAL_SOURCES);
  const sources: SourceEntry[] = raw ? JSON.parse(raw) : [];

  // 检查是否有 MacCMS 源（即使没有 config 源也可以继续）
  const macCMSRaw = await storage.get(KV_MACCMS_SOURCES);
  const hasMacCMS = macCMSRaw ? JSON.parse(macCMSRaw).length > 0 : false;

  // 纯直播用法：只有 txt/m3u 直播源、不配任何点播配置源，也应该能聚合
  // （默认的「源列表为空就直接 return」会让这类用户完全跑不出东西）
  const liveRawPeek = await storage.get(KV_LIVE_SOURCES);
  let hasLiveSources = false;
  if (liveRawPeek) {
    try {
      hasLiveSources = JSON.parse(liveRawPeek).length > 0;
    } catch {
      hasLiveSources = false;
    }
  }

  if (sources.length === 0 && !hasMacCMS && !hasLiveSources) {
    logger.warn('aggregation', 'No sources configured, nothing to do');
    return;
  }

  logger.infoFields('aggregation', 'sources-loaded', { count: sources.length });
  await storage.put(KV_SOURCE_URLS, JSON.stringify(sources));

  // Step 1.5: 处理 MacCMS 源
  logger.info('aggregation', 'Step 1.5: Processing MacCMS sources...');
  const macCMSConfigs = await processMacCMSSources(storage, config);

  // Step 1.6: 直播源频道级合并移至 Step 6.5（方案 D+）

  // Step 1.8: 分离 inline:// 源，从 KV 直接加载
  const remoteSources = sources.filter(s => !s.url.startsWith('inline://'));
  const inlineSources = sources.filter(s => s.url.startsWith('inline://'));
  const inlineConfigs: SourcedConfig[] = [];

  for (const src of inlineSources) {
    const kvKey = src.url.replace('inline://', '');
    const raw = await storage.get(kvKey);
    if (raw) {
      const parsed = parseConfigJson(raw);
      if (parsed) {
        inlineConfigs.push({ sourceUrl: src.url, sourceName: src.name || 'Inline', config: parsed });
        logger.info('aggregation', `Loaded inline config: ${kvKey}`);
      } else {
        logger.warn('aggregation', `Failed to parse inline config: ${kvKey}`);
      }
    } else {
      logger.warn('aggregation', `Inline config not found in KV: ${kvKey}`);
    }
  }

  // Step 2: 批量 fetch 配置 JSON（本地模式可通过边缘代理回退）
  logger.info('aggregation', 'Step 2: Fetching configs...');
  let proxyConfig: FetchProxyConfig | undefined;
  if (!config.workerBaseUrl) {
    // 本地模式：读取边缘代理配置
    const edgeRaw = await storage.get(KV_EDGE_PROXIES);
    if (edgeRaw) {
      const edge: EdgeProxyConfig = JSON.parse(edgeRaw);
      const urls: string[] = [];
      if (edge.cf) urls.push(`${edge.cf}/fetch-proxy`);
      if (edge.vercel) urls.push(`${edge.vercel}/api/proxy`);
      if (urls.length > 0) {
        proxyConfig = { urls, token: config.adminToken };
        logger.info('aggregation', `Edge proxies configured: ${urls.join(', ')}`);
      }
    }
  }
  const { configs: sourcedConfigs, fetchResults } = await fetchConfigs(remoteSources, config.fetchTimeoutMs, proxyConfig);
  logFetchResults = fetchResults;

  // 更新源健康状态
  await updateSourceHealth(storage, fetchResults);

  if (sourcedConfigs.length === 0 && inlineConfigs.length === 0 && macCMSConfigs.length === 0 && !hasLiveSources) {
    logger.warn('aggregation', 'No valid configs fetched and no MacCMS/inline sources, keeping previous cache');
    return;
  }

  // Step 3: 用 fetch 耗时筛选配置源
  let filteredConfigs: SourcedConfig[] = sourcedConfigs;

  const configsWithSpeed = sourcedConfigs.filter((c) => c.speedMs != null);
  if (configsWithSpeed.length > 0) {
    logger.info('aggregation', 'Step 3: Filtering configs by fetch speed...');
    filteredConfigs = sourcedConfigs.filter((c) => {
      if (c.speedMs == null) return true; // 没有测速数据的保留
      if (c.speedMs <= config.speedTimeoutMs) return true;
      logger.infoFields('aggregation', 'speed-filter-removed', { url: c.sourceUrl, speedMs: c.speedMs, threshold: config.speedTimeoutMs });
      return false;
    });

    if (filteredConfigs.length === 0) {
      logger.warn('aggregation', 'All configs failed speed filter, using all fetched configs');
      filteredConfigs = sourcedConfigs;
    } else {
      logger.infoFields('aggregation', 'speed-filter-passed', { passed: filteredConfigs.length, total: sourcedConfigs.length });
    }
  } else {
    logger.info('aggregation', 'Step 3: No speed data available, skipping filter');
  }

  // Step 4: 合并（包含 MacCMS 源，投票制 spider 分配）
  logger.info('aggregation', 'Step 4: Merging configs...');
  const allConfigs = [...filteredConfigs, ...inlineConfigs, ...macCMSConfigs];
  const mergeResult = mergeConfigs(allConfigs);
  let merged = mergeResult.config;
  const { siteSourceMap, parseSourceMap, liveSourceMap } = mergeResult;

  // Step 4.5: 黑名单过滤
  logger.info('aggregation', 'Step 4.5: Applying blacklist...');
  const blacklist = await loadBlacklist(storage);
  const hasBlacklist = blacklist.sites.length > 0 || blacklist.parses.length > 0 || blacklist.lives.length > 0 || blacklist.regexRules.some(r => r.enabled);

  // 保存过滤前的完整配置（供配置编辑器显示已屏蔽项）
  await storage.put(KV_MERGED_CONFIG_FULL, JSON.stringify(merged));

  // 保存源追踪映射（供 builder 使用）
  await storage.put(KV_SOURCE_MAP, JSON.stringify({
    sites: Object.fromEntries(siteSourceMap),
    parses: Object.fromEntries(parseSourceMap),
    lives: Object.fromEntries(liveSourceMap),
  }));

  if (hasBlacklist) {
    // 自动清理黑名单中已不存在的条目（必须在过滤前比对，否则被屏蔽的条目会被误判为"过时"而清掉）
    const pruned = await pruneBlacklist(blacklist, merged);
    if (JSON.stringify(pruned) !== JSON.stringify(blacklist)) {
      await saveBlacklist(storage, pruned);
    }

    const { config: filtered, removedSites, removedParses, removedLives, removedByRegex } = await applyBlacklist(merged, pruned);
    merged = filtered;
    logBlacklistRemovedSites = removedSites;
    logBlacklistRemovedParses = removedParses;
    logBlacklistRemovedLives = removedLives;
    logger.infoFields('aggregation', 'blacklist-removed', { sites: removedSites, parses: removedParses, lives: removedLives, regex: removedByRegex });
  } else {
    logger.info('aggregation', 'Step 4.5: No blacklist entries, skipping');
  }

  // Step 4.6: 清洗无效数据（空条目 + 本地引用）— 必须在搜索配额前，避免配额分给随后被清理的站点
  logger.info('aggregation', 'Step 4.6: Cleaning invalid entries...');
  merged = cleanEmptyEntries(merged);
  merged = cleanLocalRefs(merged);

  // Step 4.7: 搜索配额（JS 排除 + 置顶排序 + 可选截断）
  const quotaConfig = await loadSearchQuota(storage);
  if (merged.sites) {
    const { sites: quotaSites, quotaReport } = applySearchQuota(merged.sites, quotaConfig, siteSourceMap);
    merged.sites = quotaSites;
    logger.infoFields('aggregation', 'search-quota', {
      total: quotaReport.totalSites, jsExcluded: quotaReport.jsExcluded,
      pinned: quotaReport.pinnedCount, truncated: quotaReport.truncated, searchable: quotaReport.searchable,
    });
    await storage.put(KV_SEARCH_QUOTA_REPORT, JSON.stringify({
      updatedAt: new Date().toISOString(),
      ...quotaReport,
    }));
  }

  // Step 5.5: 名称定制（清洗推广文字 + 前缀后缀）
  const ntRaw = await storage.get(KV_NAME_TRANSFORM);
  const nameTransform: NameTransformConfig = ntRaw ? JSON.parse(ntRaw) : {};
  const hasTransform = nameTransform.prefix || nameTransform.suffix || nameTransform.promoReplacement || nameTransform.extraCleanPatterns?.length;
  if (hasTransform) {
    logger.info('aggregation', 'Step 5.5: Applying name transform...');
    merged = transformSiteNames(merged, nameTransform);
  } else {
    // 即使没有自定义配置，默认清洗推广文字也要执行
    logger.info('aggregation', 'Step 5.5: Cleaning promo text from site names...');
    merged = transformSiteNames(merged, {});
  }

  // Step 5.6: 站点指纹（必须在凭证注入之前算）
  //
  // 指纹里含 ext，而注入会改写 ext。若在注入前后各算一次，黑名单（Step 4，注入前）
  // 与跳过名单（Step 6，注入后）用的是两套哈希，永远不相交；凭证一刷新（重新扫码、
  // cookie 重取），跳过名单里几百条还会集体失配、全部恢复探测。
  // 这里算一次，后面 skip 过滤 / 自动清理 / 配置编辑器全部复用。
  const siteFpCache = await computeFingerprints(merged.sites || []);
  if (siteFpCache.size > 0) {
    await storage.put(KV_SITE_FP, JSON.stringify({
      v: 1,
      at: new Date().toISOString(),
      map: Object.fromEntries(siteFpCache),
    }));
  }

  // Step 5.7: 网盘凭证注入
  const credentials = await loadCredentials(storage);
  if (credentials.size > 0 && merged.sites && merged.sites.length > 0) {
    logger.info('aggregation', 'Step 5.7: Injecting cloud credentials...');
    const credentialPolicy = await loadCredentialPolicy(storage);
    const jarBaseUrl = config.workerBaseUrl || config.localBaseUrl;
    const credTokenUrl = `${jarBaseUrl}/credential/${await ensureCredentialTokenSecret(storage)}/token.json`;
    const { sites: injectedSites, report: injReport } = injectCredentials(
      merged.sites, credentials, credentialPolicy, jarBaseUrl, credTokenUrl,
    );
    merged.sites = injectedSites;
    logger.infoFields('aggregation', 'credentials-injected', {
      injected: injReport.injected, skippedSafe: injReport.skippedSafe,
      highRisk: injReport.skippedHighRisk, unaudited: injReport.skippedUnaudited,
      noRule: injReport.skippedNoRule, noCredential: injReport.skippedNoCredential,
    });
  } else {
    logger.info('aggregation', 'Step 5.7: No cloud credentials configured, skipping');
  }

  // Step 6: 站点验活 + 不可达过滤 + name 标记（CF 和 Node.js 统一）
  const speedTestRaw = await storage.get(KV_SPEED_TEST_ENABLED);
  const speedTestEnabled = speedTestRaw !== 'false';
  const probeDepthRaw = await storage.get(KV_SITE_PROBE_DEPTH);
  const probeDeep = probeDepthRaw !== 'shallow' && !config.workerBaseUrl; // CF Worker 强制 shallow
  let siteProbeMap: Map<string, SiteProbeResult> = new Map();
  let siteSpeedMap: Map<string, number | null> = new Map();

  if (!speedTestEnabled) {
    logger.info('aggregation', 'Step 6: Speed test disabled, skipping');
  } else if (merged.sites && merged.sites.length > 0) {
    // 「保留链接」模式下，被判定不可达的站点留在输出里，但不再重复探测（省掉大量超时等待）。
    // 指纹必须用注入前算好的那份，否则凭证刷新后整份跳过名单失配（P1-9）
    const skipList = new Set(await loadSkipList(storage));
    let probeTargets = merged.sites;
    if (skipList.size > 0) {
      const kept = [];
      for (const site of merged.sites) {
        const fp = await siteFingerprintCached(site, siteFpCache);
        if (!skipList.has(fp)) kept.push(site);
      }
      probeTargets = kept;
      if (kept.length < merged.sites.length) {
        logger.infoFields('aggregation', 'Step 6: skip-listed sites excluded from probe', {
          skipped: merged.sites.length - kept.length, left: kept.length,
        });
      }
    }

    logger.infoFields('aggregation', 'Step 6: site probe', { depth: probeDeep ? 'deep' : 'shallow' });
    // 站点验活也走独立连接池：跑完就销毁，不污染后续的直播下载与合并
    siteProbeMap = await withProbeNet(
      () => batchSiteSpeedTest(probeTargets, config.siteTimeoutMs, probeDeep),
      { connections: 48, connectTimeoutMs: 5000 },
    );

    // 提取纯 speedMs map 供后续 dedup 使用
    for (const [key, probe] of siteProbeMap) {
      siteSpeedMap.set(key, probe.speedMs);
    }

    if (siteProbeMap.size > 0) {
      const { sites: filteredSites, filtered } = filterUnreachableSites(merged.sites, siteProbeMap);
      merged.sites = filteredSites;

      if (!config.workerBaseUrl) {
        merged.sites = appendSpeedToName(merged.sites, siteProbeMap);
      }
    }

    // 更新站点健康状态 & 自动标记/屏蔽
    await updateSiteHealth(storage, siteProbeMap, merged, siteFpCache);
  } else {
    logger.info('aggregation', 'Step 6: No sites to test');
  }

  // Step 6.2: 相似名称去重（保留响应速度最快的站点）
  const dedupRaw = await storage.get(KV_DEDUP_CONFIG);
  let similarDedupEnabled = true;
  let similarDedupThreshold = 0.85;
  if (dedupRaw) {
    try {
      const dedupCfg = JSON.parse(dedupRaw);
      similarDedupEnabled = dedupCfg.similarDedup !== false;
      similarDedupThreshold = typeof dedupCfg.similarDedupThreshold === 'number'
        ? dedupCfg.similarDedupThreshold
        : 0.85;
    } catch { /* ignore */ }
  }

  if (similarDedupEnabled && merged.sites && merged.sites.length > 0) {
    logger.infoFields('aggregation', 'Step 6.2: similar-name-dedup', { threshold: similarDedupThreshold });
    merged.sites = deduplicateSimilarNames(merged.sites, siteSpeedMap, similarDedupThreshold);
    logger.infoFields('aggregation', 'similar-dedup-done', { sites: merged.sites.length });
  } else {
    logger.info('aggregation', 'Step 6.2: Similar-name dedup disabled, skipping');
  }

  // 编排规则外置到 KV：台序、每台保留条数、各档保底条数、付费/海外排除名单都在这里。
  // 读一次，后面的合并过滤、黑名单豁免、质量保障、编排共用同一份。
  const curationRules = await loadCurationRules(storage);
  const requireSegment = (await storage.get(KV_CHANNEL_PROBE_SEGMENT)) !== 'false';
  let qualityStats: GuaranteeStats | null = null;

  // Step 6.5: 直播源频道级合并（方案 D+）
  // 收集所有 m3u/txt URL（配置源合来的 FongMi 格式 lives + admin 手动源）
  // → 下载 → 解析 → 按频道名合并 urls → 输出 TVBoxLiveGroup[]
  // CF Worker 免费版 50 子请求上限，Step 6.5 要再下载 N 个 m3u 会爆，整段跳过
  // CF 部署保留 FongMi 格式，lives[0] 崩溃风险保留；建议 CF 用户切 Docker
  // 直播禁用开关
  const liveDisabledRaw = await storage.get(KV_LIVE_DISABLED);
  const liveDisabled = liveDisabledRaw === 'true';

  if (liveDisabled) {
    logger.info('aggregation', 'Step 6.5: Live disabled, skipping');
    merged.lives = [];
  } else if (config.workerBaseUrl) {
    logger.info('aggregation', 'Step 6.5: Skipped on CF (subrequest limit, use Docker for channel merging)');
  } else {
  logger.info('aggregation', 'Step 6.5: Channel-level live merging...');
  {
    const liveInputs: LiveSourceInput[] = [];

    // 配置源自带的 lives 默认不采用：它们常挂整份音乐/歌单播放列表，
    // 一个源就能掺进来几万条非电视条目（实测「境内专题」被灌到 2.3 万）
    const useConfigLives = (await storage.get(KV_LIVE_USE_CONFIG_LIVES)) === 'true';
    if (!useConfigLives && Array.isArray(merged.lives) && merged.lives.length > 0) {
      logger.infoFields('aggregation', 'Step 6.5: config lives ignored', { count: merged.lives.length });
    }

    // 配置源合并来的 lives（FongMi 格式）
    for (const l of (useConfigLives ? (merged.lives || []) : []) as Array<{ name?: string; url?: string; api?: string; ua?: string; header?: Record<string, string>; group?: string }>) {
      // 跳过已经是 Native 格式的（含 group 字段无 url）
      if (l.group && !l.url && !l.api) continue;
      const u = l.url || l.api;
      if (!u || !/^https?:\/\//i.test(u)) continue;
      if (u.includes('127.0.0.1') || u.includes('localhost')) continue;
      liveInputs.push({
        name: l.name || 'source',
        url: u,
        ua: l.ua,
        header: l.header,
      });
    }

    // admin 手动源
    const liveRaw = await storage.get(KV_LIVE_SOURCES);
    if (liveRaw) {
      try {
        const manual: Array<{ name: string; url: string }> = JSON.parse(liveRaw);
        for (const m of manual) {
          if (!m.url || !/^https?:\/\//i.test(m.url)) continue;
          if (m.url.includes('127.0.0.1') || m.url.includes('localhost')) continue;
          liveInputs.push({ name: m.name || 'manual', url: m.url });
        }
      } catch {
        /* ignore */
      }
    }

    // URL 去重
    const seen = new Set<string>();
    const uniqueInputs = liveInputs.filter((i) => {
      if (seen.has(i.url)) return false;
      seen.add(i.url);
      return true;
    });

    if (uniqueInputs.length === 0) {
      logger.info('aggregation', 'Step 6.5: No live sources to merge');
      merged.lives = [];
    } else {
      const liveMergeMode = (await storage.get(KV_LIVE_MERGE_MODE)) || 'separated';
      logger.infoFields('aggregation', 'Step 6.5: live-sources', { unique: uniqueInputs.length, mode: liveMergeMode });

      // 测速前置：用上一轮落盘的频道树先测速，合并时一次拿到新鲜结果。
      // 反过来（合并 → 测速 → 再合并）会把所有直播源下载两遍；而测速跑完上万次请求后
      // 连接池会退化，第二遍下载经常整批超时（另一分支上实测直接把 lives 清成 0）。
      const inlineProbe = (await storage.get(KV_CHANNEL_PROBE_INLINE)) !== 'false';
      if (inlineProbe && (await isProbeEnabled(storage))) {
        logger.info('aggregation', 'Step 6.5a: channel probe before merge...');
        const probeStatus = await withProbeNet(() => runChannelProbe(storage));
        logger.infoFields('aggregation', 'inline-probe-done', {
          state: probeStatus.state, probed: probeStatus.probed,
          coverage: probeStatus.coverage, dead: probeStatus.dead ?? 0,
        });
      }

      // 两种模式都要用测速结果排序，否则「按源分开」模式下测速形同虚设
      const channelSpeedMap = await loadChannelSpeedMap(storage);
      // 分组归并：把各源自带的几百个杂组收进标准分组（只在合并模式下生效）
      const groupMerge = await loadLiveGroupMerge(storage);
      const shopping = await loadShoppingFilter(storage);

      let mergeResult;
      if (liveMergeMode === 'separated') {
        mergeResult = await separatedMergeLives(uniqueInputs, config.fetchTimeoutMs, channelSpeedMap);
      } else {
        mergeResult = await mergeLivesToNative(uniqueInputs, config.fetchTimeoutMs, channelSpeedMap, { groupMerge, shopping });
      }

      // 下载/解析整体失败时不要把直播树清空——沿用上次结果，避免电视端直播源突然变空
      if (mergeResult.groups.length === 0) {
        const prevTree = await storage.get(KV_CHANNEL_MERGED_TREE);
        if (prevTree) {
          try {
            const prev = applyChannelExclusions(JSON.parse(prevTree), curationRules);
            merged.lives = prev.groups;
            logger.warn('aggregation', 'Step 6.5: live merge produced 0 groups, reusing previous tree');
          } catch {
            merged.lives = [];
          }
        } else {
          merged.lives = [];
        }
      } else {
        // 付费台 / 海外台在这里就摘掉：下一轮测速不再为它们浪费请求，
        // 频道目录与缺口报表也不会再出现这些台。
        const kept = applyChannelExclusions(mergeResult.groups, curationRules);
        merged.lives = kept.groups;
        if (kept.removedChannels > 0) {
          logger.infoFields('aggregation', 'excluded-channels', {
            channels: kept.removedChannels, groups: kept.removedGroups,
          });
        }

        // 保存合并树供 channel-probe 使用（存过滤后的树）
        await storage.put(KV_CHANNEL_MERGED_TREE, JSON.stringify(kept.groups));
      }

      logger.infoFields('aggregation', 'live-merge-done', {
        downloaded: mergeResult.sourcesDownloaded, total: uniqueInputs.length,
        groups: mergeResult.groups.length, channels: mergeResult.totalChannels, urls: mergeResult.totalUrls,
        diversified: mergeResult.diversifiedChannels ?? 0,
      });
    }
  }
  }

  // 编排规则外置到 KV：台序、每台保留条数、各档保底可播条数都在这里。
  // 读一次，后面的黑名单豁免、质量保障、编排共用同一份，避免三处各自读盘。
  // Step 6.6: 死源黑名单过滤（管理后台「清理死源」按钮写入）
  // 只过滤输出，不影响测速：测速仍按完整频道树跑，源恢复后会自动移出黑名单
  if (Array.isArray(merged.lives) && merged.lives.length > 0) {
    // 先把受保护域名（南京广电官方源等）从台账里回捞，避免历史误判继续吃台
    const revivedProtected = await purgeProtectedUrls(storage);
    if (revivedProtected > 0) {
      logger.infoFields('aggregation', 'dead-list-protected-revived', { urls: revivedProtected });
    }

    // 死满一个月且仍然死 → 转「判死」（只降频，不删除）
    if (Array.isArray(merged.lives) && merged.lives.length > 0) {
      const curSpeed = await loadChannelSpeedMap(storage);
      const condemned = await condemnExpired(storage, (u) => {
        const e = curSpeed[u];
        return !e || e.kind === 'fail';
      });
      if (condemned.promoted > 0) {
        logger.infoFields('aggregation', 'dead-list-condemned', condemned);
      }
    }

    const deadUrls = await loadDeadUrls(storage);
    // 域名已判死的，名下源整片不输出（比逐条记 URL 台账更省，也更快）
    const hostMap = await loadHostMap(storage);
    if (deadUrls.length > 0 || hostMap.size > 0) {
      const deadSet = new Set(deadUrls);
      const keptGroups: typeof merged.lives = [];
      let droppedUrls = 0;
      let droppedChannels = 0;
      let exemptChannels = 0;

      for (const group of merged.lives as Array<{ group?: string; channels?: Array<{ name: string; urls: string[] }> }>) {
        if (!Array.isArray(group.channels)) {
          keptGroups.push(group as never);
          continue;
        }
        const channels: Array<{ name: string; urls: string[] }> = [];
        for (const ch of group.channels) {
          // 重点频道（央视/卫视/南京）不吃黑名单：它们的源少，命中一次就整台消失，
          // 而用户打开电视找的就是这几个台。死链仍会排到末尾。
          if (isFocusChannel(ch.name, curationRules)) {
            channels.push(ch);
            exemptChannels++;
            continue;
          }
          const kept = (ch.urls || []).filter((u) => !deadSet.has(bareUrl(u)) && !isHostCondemned(hostMap, u));
          droppedUrls += (ch.urls || []).length - kept.length;
          if (kept.length > 0) channels.push({ ...ch, urls: kept });
          else droppedChannels++;
        }
        if (channels.length > 0) keptGroups.push({ ...group, channels } as never);
      }

      merged.lives = keptGroups;
      logger.infoFields('aggregation', 'dead-list-filtered', {
        deadList: deadUrls.length, droppedUrls, droppedChannels, exemptChannels, leftGroups: keptGroups.length,
      });
    }
  }

  // Step 6.6c: 分级源质量保障（央视 → 卫视 → 重点地方台）
  // 「保量」从「每台 8 条源」改成「每台 N 条**本轮实测能播、延迟低于客户端超时、不同域名**的源」。
  // 缺口从完整源池里继续补测（很多台输出 8 条、池子里还有几十条），
  // 补不到的记缺口报表，不再靠给 78% 的单源小台盲目塞源。
  if ((await storage.get(KV_LIVE_QUALITY_GUARANTEE)) !== 'false'
    && Array.isArray(merged.lives) && merged.lives.length > 0) {
    const qMap = await loadChannelSpeedMap(storage);
    const result = await withProbeNet(() => runQualityGuarantee(
      merged.lives as unknown as TVBoxLiveGroup[],
      qMap,
      { rules: curationRules, requireSegment, budgetMs: QUALITY_GUARANTEE_BUDGET_MS },
    ));
    await saveSpeedMap(storage, qMap, { merge: true });
    qualityStats = result.stats;
    await storage.put(KV_LIVE_QUALITY_GAP, JSON.stringify({
      at: new Date().toISOString(),
      stats: result.stats,
      coverage: result.coverage,
      gaps: result.gaps.slice(0, 120),
    }));
    logger.infoFields('aggregation', 'quality-guarantee', {
      channels: result.stats.channels,
      probed: result.stats.probed,
      fixed: result.stats.fixed,
      gapBefore: result.stats.gapBefore,
      gapAfter: result.stats.gapAfter,
      ms: result.stats.elapsedMs,
      exhausted: result.stats.budgetExhausted,
      cctvMet: `${result.stats.byTier.find((x) => x.tier === 'cctv')?.metAfter ?? 0}/${result.stats.byTier.find((x) => x.tier === 'cctv')?.channels ?? 0}`,
      satMet: `${result.stats.byTier.find((x) => x.tier === 'satellite')?.metAfter ?? 0}/${result.stats.byTier.find((x) => x.tier === 'satellite')?.channels ?? 0}`,
      localMet: `${result.stats.byTier.find((x) => x.tier === 'local')?.metAfter ?? 0}/${result.stats.byTier.find((x) => x.tier === 'local')?.channels ?? 0}`,
    });
  }

  // Step 6.6a: 一键选优（每频道保留 topN 条源）
  const topN = Number(await storage.get(KV_LIVE_TOP_N)) || 0;
  if (topN > 0 && Array.isArray(merged.lives) && merged.lives.length > 0) {
    const before = merged.lives.reduce((n: number, g: { channels?: Array<{ urls?: string[] }> }) =>
      n + (g.channels || []).reduce((m, ch) => m + (ch.urls || []).length, 0), 0);
    const trimmed = trimGroupsToTopN(merged.lives as unknown as TVBoxLiveGroup[], topN);
    const after = trimmed.reduce((n, g) =>
      n + (g.channels || []).reduce((m, ch) => m + (ch.urls || []).length, 0), 0);
    merged.lives = trimmed as never;
    if (after !== before) logger.infoFields('aggregation', 'top-n-applied', { topN, before, after });
  }

  // Step 6.6b: 输出前复核首位源
  // 测速是「过去某一刻」的事实，实测首位可播率只有 73%：第一位不行就换下一位，
  // 让电视端少等一轮超时。只复核每个频道的前 3 条，同域并发限 4，避免把源打崩。
  if ((await storage.get(KV_LIVE_HEAD_VERIFY)) !== 'false' && Array.isArray(merged.lives) && merged.lives.length > 0) {
    const verifyMap = await loadChannelSpeedMap(storage);
    const { stats } = await withProbeNet(() => reverifyHeadSources(
      merged.lives as unknown as TVBoxLiveGroup[],
      verifyMap,
      { requireSegment },
    ));
    if (stats.requests > 0) {
      await saveSpeedMap(storage, verifyMap, { merge: true });
      logger.infoFields('aggregation', 'head-reverify-done', {
        channels: stats.checked, promoted: stats.promoted, allDead: stats.allDead,
        unknown: stats.unknown, requests: stats.requests, ms: stats.elapsedMs,
      });
    }
  }

  // Step 6.7: 分组内频道自定义顺序（后台「频道排序」保存的拖动结果）
  if (Array.isArray(merged.lives) && merged.lives.length > 0) {
    const orderConfig = await loadChannelOrder(storage);
    if (Object.keys(orderConfig.groups).length > 0) {
      merged.lives = applyChannelOrder(merged.lives as never, orderConfig) as never;
      logger.infoFields('aggregation', 'channel-order-applied', { groups: Object.keys(orderConfig.groups).length });
    }
  }

  // Step 6.7b: 重点频道编排（央视 / 卫视 / 南京地方台）
  // 放在自定义顺序之后：编排是「按台的重要性算出来的规则」，优先级高于一次性拖动结果，
  // 否则源里一冒出新写法就永远沉在组尾（南京那批台就是这样消失的）。
  if (Array.isArray(merged.lives) && merged.lives.length > 0) {
    const overrides = await loadOverrides(storage);
    const curateSpeedMap = await loadChannelSpeedMap(storage);
    const curated = curateGroups(merged.lives as never, overrides, curateSpeedMap, {
      rules: curationRules,
      requireSegment,
    });
    // 编排会把 CCTV5高清 这类名字并进 CCTV5，可能在合并阶段之后又把同一路流带回来，
    // 所以定稿后再做一次跨频道裁决（CCTV5 / CCTV5+ 的归属以最终频道为准）。
    const finalConflicts = resolveCrossChannelConflicts(curated.groups);
    if (finalConflicts.length > 0) {
      logger.infoFields('aggregation', 'cross-channel-conflicts', { removed: finalConflicts.length });
      for (const c of finalConflicts.slice(0, 3)) {
        logger.info('aggregation', `  ${c.url} -> ${c.to} (removed from ${c.from})`);
      }
    }

    merged.lives = curated.groups as never;
    logger.infoFields('aggregation', 'channel-curated', {
      mergedDupes: curated.mergedDupes, disabled: curated.disabled, rescued: curated.rescued,
      pinned: Object.values(overrides).filter((o) => o?.pinned).length,
    });

    // Step 6.7c: 隐藏「所有源都不可用」的频道
    // 实测 379/1166（32.5%）的台一条可播源都没有，留着就是让人点进去看黑屏。
    // 默认开；KV 置 'false' 可退回「保留但沉底」的旧行为。
    if ((await storage.get(KV_LIVE_HIDE_DEAD)) !== 'false') {
      let hidden = 0;
      const keptGroups: TVBoxLiveGroup[] = [];
      for (const g of merged.lives as TVBoxLiveGroup[]) {
        const channels = (g.channels || []).filter((ch) => {
          // 没测过（无条目）不算死：不知道就不该删
          const playable = (ch.urls || []).some((u) => {
            const e = curateSpeedMap[bareUrl(u)];
            return !e || e.kind !== 'fail';
          });
          if (!playable) hidden++;
          return playable;
        });
        if (channels.length > 0) keptGroups.push({ group: g.group, channels });
      }
      merged.lives = keptGroups as never;
      logger.infoFields('aggregation', 'dead-channels-hidden', { hidden, leftGroups: keptGroups.length });
    }

    // 用**最终输出树**重算达标情况：合并同名、改名、隐藏全死台之后，
    // 数字才和电视上真正看到的频道对得上（保障阶段那会儿 CCTV1 还有 3 种写法）。
    try {
      const finalReport = buildCoverageReport(
        curated.groups, curateSpeedMap, curationRules, requireSegment,
      );
      await storage.put(KV_LIVE_QUALITY_GAP, JSON.stringify({
        at: new Date().toISOString(),
        stats: qualityStats,
        coverage: finalReport.coverage,
        gaps: finalReport.gaps,
        channels: finalReport.channels,
      }));
      logger.infoFields('aggregation', 'quality-coverage', {
        channels: finalReport.channels,
        ...Object.fromEntries(finalReport.coverage
          .filter((x) => x.channels > 0)
          .map((x) => [x.tier, `${x.met}/${x.channels}`])),
        gaps: finalReport.gaps.length,
      });
    } catch (err) {
      logger.warn('aggregation', `quality coverage failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 编排会把频道改成正式名（江苏·南京新闻 → 南京新闻综合），目录要跟着补槽，
    // 否则后台看到的 id 是空的、未识别队列里全是刚改好名的频道。
    try {
      const reg = await loadRegistry(storage);
      const { added } = upsertFromGroups(reg, curated.groups);
      if (added > 0) {
        await saveRegistry(storage, reg);
        logger.infoFields('aggregation', 'registry-synced', { added });
      }
    } catch (err) {
      logger.warn('aggregation', `registry sync failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Step 6.8: 自定义分组排序
  const groupOrderCfg = await loadGroupOrder(storage);
  if (groupOrderCfg.enabled && merged.sites && merged.sites.length > 0) {
    logger.info('aggregation', 'Step 6.8: Applying custom group order...');
    merged.sites = applyGroupOrder(merged.sites, groupOrderCfg);
  } else {
    logger.info('aggregation', 'Step 6.8: Group order disabled or no rules, skipping');
  }

  // Step 7: JAR URL 改写（统一用占位符，请求时替换为实际 base URL）
  logger.infoFields('aggregation', 'Step 7: rewriting JAR URLs', { placeholder: BASE_URL_PLACEHOLDER });
  merged = await rewriteJarUrls(merged, BASE_URL_PLACEHOLDER, storage);

  // Step 7.5: 注入图片代理前缀（统一用占位符或边缘代理）
  const edgeRaw = await storage.get(KV_EDGE_PROXIES);
  if (edgeRaw) {
    const edge: EdgeProxyConfig = JSON.parse(edgeRaw);
    if (edge.cf) {
      merged.pic = `${edge.cf.replace(/\/$/, '')}/img/`;
      logger.infoFields('aggregation', 'pic-proxy-injected-edge', { pic: merged.pic });
    } else {
      merged.pic = `${BASE_URL_PLACEHOLDER}/img/`;
      logger.infoFields('aggregation', 'pic-proxy-placeholder', { pic: merged.pic });
    }
  } else {
    merged.pic = `${BASE_URL_PLACEHOLDER}/img/`;
    logger.infoFields('aggregation', 'pic-proxy-placeholder', { pic: merged.pic });
  }

  // Step 8: 存入存储
  const mergedJson = JSON.stringify(merged);
  await storage.put(KV_MERGED_CONFIG, mergedJson);
  await storage.put(KV_LAST_UPDATE, new Date().toISOString());

  // Step 8.5: 对外发布——把最新的 live.txt 覆盖上传到 FTP（失败不影响聚合结果）
  if (!config.workerBaseUrl && Array.isArray(merged.lives) && merged.lives.length > 0) {
    try {
      const ftpCfg = await loadFtpConfig(storage);
      if (ftpCfg.enabled && ftpCfg.host) {
        const txt = formatLiveGroupsAsTxt(merged.lives as unknown as TVBoxLiveGroup[]);
        const res = await uploadLiveTxt(ftpCfg, txt);
        if (res.ok) {
          logger.infoFields('aggregation', 'ftp-published', { bytes: res.bytes, path: ftpCfg.remotePath });
        } else {
          logger.warn('aggregation', `ftp publish failed: ${res.error}`);
        }
      }
    } catch (err) {
      logger.warn('aggregation', `ftp publish error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  logger.infoFields('aggregation', 'done', {
    elapsed: `${elapsed}s`, sites: merged.sites?.length, parses: merged.parses?.length, lives: merged.lives?.length,
  });

  // Step 9: 聚合日志
  const nowSiteKeys = new Set((merged.sites || []).map(s => s.key));
  const siteKeyToName = new Map((merged.sites || []).map(s => [s.key, s.name || s.key]));

  const addedSites: AggLogSiteChange[] = [];
  for (const key of nowSiteKeys) {
    if (!prevSiteKeys.has(key)) {
      addedSites.push({ key, name: siteKeyToName.get(key) });
    }
  }

  const removedSites: AggLogSiteChange[] = [];
  for (const key of prevSiteKeys) {
    if (!nowSiteKeys.has(key)) {
      removedSites.push({ key });
    }
  }

  const failedSources: AggLogFailedSource[] = logFetchResults
    .filter(r => r.status !== 'ok')
    .map(r => ({ url: r.url, name: r.name, status: r.status, errorMessage: r.errorMessage }));

  const aggLog: AggregationLog = {
    id: new Date(startTime).toISOString(),
    startTime: new Date(startTime).toISOString(),
    endTime: new Date().toISOString(),
    durationMs: Date.now() - startTime,
    success: true,
    totalSources: logFetchResults.length,
    okSources: logFetchResults.filter(r => r.status === 'ok').length,
    failedSources,
    addedSites,
    removedSites,
    finalSiteCount: merged.sites?.length || 0,
    finalParseCount: merged.parses?.length || 0,
    finalLiveCount: merged.lives?.length || 0,
    blacklistRemovedSites: logBlacklistRemovedSites,
    blacklistRemovedParses: logBlacklistRemovedParses,
    blacklistRemovedLives: logBlacklistRemovedLives,
  };

  await appendAggLog(storage, aggLog);
  await storage.put(KV_SITE_SNAPSHOT, JSON.stringify([...nowSiteKeys]));

  if (addedSites.length > 0 || removedSites.length > 0) {
    logger.infoFields('aggregation', 'site-diff', { added: addedSites.length, removed: removedSites.length });
  }
}

/**
 * 处理 MacCMS 源：
 * - CF 版（有 workerBaseUrl）：直接转换，API 指向代理路由
 * - 本地版（无 workerBaseUrl）：并发验证 + 过滤不可达站点 + 收集延迟
 */
async function processMacCMSSources(
  storage: Storage,
  config: AppConfig,
): Promise<SourcedConfig[]> {
  const raw = await storage.get(KV_MACCMS_SOURCES);
  const entries: MacCMSSourceEntry[] = raw ? JSON.parse(raw) : [];

  if (entries.length === 0) {
    logger.info('aggregation', 'No MacCMS sources configured');
    return [];
  }

  logger.infoFields('aggregation', 'maccms-sources-found', { count: entries.length });

  let validEntries: MacCMSSourceEntry[];
  let speedMap: Map<string, number> | undefined;

  const edgeProxiesRaw = !config.workerBaseUrl ? await storage.get(KV_EDGE_PROXIES) : null;

  if (config.workerBaseUrl || edgeProxiesRaw) {
    // CF 版或本地有 edge proxy：跳过验证，运行时代理兜底
    logger.info('aggregation', `Skipping MacCMS validation (${config.workerBaseUrl ? 'CF proxy' : 'edge proxy configured'})`);
    validEntries = entries;
  } else {
    // 本地版无 edge proxy：并发验证，过滤不可达站点
    logger.info('aggregation', 'Local mode (no edge proxy): validating MacCMS sources...');
    const result = await processMacCMSForLocal(entries, config.siteTimeoutMs);
    validEntries = result.passed;
    speedMap = result.speedMap;
  }

  if (validEntries.length === 0) {
    logger.warn('aggregation', 'No valid MacCMS sources after processing');
    return [];
  }

  const sites = macCMSToTVBoxSites(validEntries, BASE_URL_PLACEHOLDER, speedMap);
  logger.infoFields('aggregation', 'maccms-converted', { sites: sites.length });

  return [{
    sourceUrl: 'maccms://builtin',
    sourceName: 'MacCMS Sources',
    config: { sites },
  }];
}

/**
 * 更新源健康状态：读取历史 → merge 本次 fetch 结果 → 写回
 */
async function updateSourceHealth(storage: Storage, fetchResults: SourceFetchResult[]): Promise<void> {
  if (fetchResults.length === 0) return;

  const now = new Date().toISOString();

  // 读取历史健康记录
  const raw = await storage.get(KV_SOURCE_HEALTH);
  const oldRecords: SourceHealthRecord[] = raw ? JSON.parse(raw) : [];
  const oldMap = new Map(oldRecords.map(r => [r.url, r]));

  // 本次参与 fetch 的 URL 集合
  const fetchedUrls = new Set(fetchResults.map(r => r.url));

  // Merge 逻辑
  const newRecords: SourceHealthRecord[] = [];

  for (const fr of fetchResults) {
    const old = oldMap.get(fr.url);

    if (fr.status === 'ok') {
      newRecords.push({
        url: fr.url,
        name: fr.name,
        latestStatus: 'ok',
        consecutiveFailures: 0,
        lastSuccessTime: now,
        lastFailTime: old?.lastFailTime,
        lastFailReason: old?.lastFailReason,
        lastSpeedMs: fr.speedMs,
      });
    } else {
      newRecords.push({
        url: fr.url,
        name: fr.name,
        latestStatus: fr.status,
        consecutiveFailures: (old?.consecutiveFailures ?? 0) + 1,
        lastSuccessTime: old?.lastSuccessTime,
        lastFailTime: now,
        lastFailReason: fr.errorMessage,
        lastSpeedMs: old?.lastSpeedMs,
      });
    }
  }

  // 保留未参与本次 fetch 的历史记录（源可能被临时排除但还在列表中）
  // 但已被用户删除的源不应保留——这由 fetchResults 只包含当前源列表来保证
  // 如果老记录的 URL 不在本次 fetch 中，丢弃（源已被删除）
  // 注：inline:// 源不经过 fetcher，不会出现在 fetchResults 中，也不需要追踪

  const failCount = newRecords.filter(r => r.consecutiveFailures > 0).length;
  if (failCount > 0) {
    logger.infoFields('aggregation', 'source-health', { ok: newRecords.length - failCount, failing: failCount });
  }

  await storage.put(KV_SOURCE_HEALTH, JSON.stringify(newRecords));
}

async function updateSiteHealth(
  storage: Storage,
  probeMap: Map<string, SiteProbeResult>,
  merged: { sites?: TVBoxSite[] },
  fpCache?: Map<string, string>,
): Promise<void> {
  if (probeMap.size === 0) return;

  const raw = await storage.get(KV_SITE_HEALTH_MAP);
  const healthMap: Record<string, { consecutiveFailures: number; lastProbeTime: string; lastProbeResult: string; lastSuccessTime?: string }> = raw ? JSON.parse(raw) : {};
  const now = new Date().toISOString();

  for (const [key, probe] of probeMap) {
    const prev = healthMap[key];
    if (probe.result === 'ok') {
      healthMap[key] = { consecutiveFailures: 0, lastProbeTime: now, lastProbeResult: 'ok', lastSuccessTime: now };
    } else {
      healthMap[key] = {
        consecutiveFailures: (prev?.consecutiveFailures ?? 0) + 1,
        lastProbeTime: now,
        lastProbeResult: probe.result,
        lastSuccessTime: prev?.lastSuccessTime,
      };
    }
  }

  // 标记连续失败 >= 3 的站点
  if (merged.sites) {
    for (let i = 0; i < merged.sites.length; i++) {
      const h = healthMap[merged.sites[i].key];
      if (h && h.consecutiveFailures >= 3) {
        const name = merged.sites[i].name || merged.sites[i].key;
        if (!name.includes('[⚠]')) {
          merged.sites[i] = { ...merged.sites[i], name: `${name} [⚠]` };
        }
      }
    }
  }

  // 自动清理：连续失败 >= 5 时加黑名单（需开关开启）
  const autoCleanRaw = await storage.get(KV_SITE_AUTO_CLEAN);
  const keepLinkRaw = await storage.get(KV_SITE_KEEP_LINK);
  const keepLink = keepLinkRaw === 'true';
  if (autoCleanRaw === 'true' && merged.sites) {
    const blacklist = await loadBlacklist(storage);
    const skipFps: string[] = [];
    let cleaned = 0;
    const MAX_AUTO_CLEAN = 5;

    for (const site of merged.sites) {
      if (cleaned >= MAX_AUTO_CLEAN) break;
      const h = healthMap[site.key];
      if (h && h.consecutiveFailures >= 5) {
        const fp = await siteFingerprintCached(site, fpCache);
        if (keepLink) {
          // 保留链接：不删站点，只记入跳过名单，后续聚合不再探测它
          if (!skipFps.includes(fp)) {
            skipFps.push(fp);
            cleaned++;
            logger.infoFields('aggregation', 'auto-clean-skip-listed', { key: site.key, name: site.name, failures: h.consecutiveFailures });
          }
        } else if (!blacklist.sites.includes(fp)) {
          blacklist.sites.push(fp);
          cleaned++;
          logger.infoFields('aggregation', 'auto-clean-blacklisted', { key: site.key, name: site.name, failures: h.consecutiveFailures });
        }
      }
    }

    if (keepLink && skipFps.length > 0) {
      await addSkipList(storage, skipFps);
    }
    if (cleaned > 0) {
      await saveBlacklist(storage, blacklist);
      logger.infoFields('aggregation', 'auto-clean-done', { cleaned });
    }
  }

  await storage.put(KV_SITE_HEALTH_MAP, JSON.stringify(healthMap));
}

async function appendAggLog(storage: Storage, log: AggregationLog): Promise<void> {
  try {
    const raw = await storage.get(KV_AGG_LOGS);
    const logs: AggregationLog[] = raw ? JSON.parse(raw) : [];
    logs.push(log);
    while (logs.length > AGG_LOGS_MAX) {
      logs.shift();
    }
    await storage.put(KV_AGG_LOGS, JSON.stringify(logs));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('aggregation', `Failed to write agg log: ${msg}`);
  }
}
