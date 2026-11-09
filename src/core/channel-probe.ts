// 频道级 URL 测速（方案 D+，仅 Node/Docker 跑）
// 独立模块：不阻塞主聚合，失败不影响聚合产出

import type { Storage } from '../storage/interface';
import type { TVBoxLiveGroup, ChannelSpeedMap, ChannelSpeedEntry, ChannelProbeStatus } from './types';
import {
  KV_CHANNEL_SPEED_MAP,
  KV_CHANNEL_PROBE_STATUS,
  KV_CHANNEL_PROBE_ENABLED,
  KV_CHANNEL_MERGED_TREE,
  CHANNEL_PROBE_CONCURRENCY,
  CHANNEL_PROBE_TIMEOUT_MS,
  CHANNEL_PROBE_SAMPLES,
  CHANNEL_PROBE_BUDGET_MS,
  CHANNEL_PROBE_SEGMENT_TIMEOUT_MS,
  CHANNEL_PROBE_SEGMENT_BYTES,
  CHANNEL_PROBE_SEGMENT_MIN_BYTES,
  CHANNEL_SPEED_TTL_MS,
  CHANNEL_DEAD_RECHECK_MS,
  CHANNEL_PROBE_RULE_VERSION,
  CHANNEL_DEAD_FAILS,
  TVBOX_UA,
} from './config';
import { extractAllUrls } from './live-merger';
import { removeRecoveredUrls } from './live-deadlist';

// ─── 开关/状态 ─────────────────────────────────────────

export async function isProbeEnabled(storage: Storage): Promise<boolean> {
  const v = await storage.get(KV_CHANNEL_PROBE_ENABLED);
  return v === 'true';
}

export async function setProbeEnabled(storage: Storage, enabled: boolean): Promise<void> {
  await storage.put(KV_CHANNEL_PROBE_ENABLED, enabled ? 'true' : 'false');
}

export async function loadStatus(storage: Storage): Promise<ChannelProbeStatus> {
  const raw = await storage.get(KV_CHANNEL_PROBE_STATUS);
  if (raw) {
    try {
      return JSON.parse(raw);
    } catch {
      /* fallthrough */
    }
  }
  return {
    state: 'idle',
    totalUrls: 0,
    probed: 0,
    success: 0,
    failed: 0,
    totalChannels: 0,
    coverage: 0,
  };
}

async function saveStatus(storage: Storage, status: ChannelProbeStatus): Promise<void> {
  await storage.put(KV_CHANNEL_PROBE_STATUS, JSON.stringify(status));
}

// ─── 测速缓存 ──────────────────────────────────────────

export async function loadSpeedMap(storage: Storage): Promise<ChannelSpeedMap> {
  const raw = await storage.get(KV_CHANNEL_SPEED_MAP);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function saveSpeedMap(storage: Storage, map: ChannelSpeedMap): Promise<void> {
  await storage.put(KV_CHANNEL_SPEED_MAP, JSON.stringify(map));
}

/** 清理 7 天前的测速缓存 */
/**
 * 清空测速缓存，强制下一轮全量重测。
 * 用途：改了判定规则（比如这次加了分片复验）之后，旧结论不能再用，否则要等 TTL 到期。
 */
export async function clearSpeedMap(storage: Storage): Promise<number> {
  const before = await loadSpeedMap(storage);
  await saveSpeedMap(storage, {});
  return Object.keys(before).length;
}

export function pruneExpired(map: ChannelSpeedMap): ChannelSpeedMap {
  const now = Date.now();
  const out: ChannelSpeedMap = {};
  for (const [url, entry] of Object.entries(map)) {
    const ts = Date.parse(entry.probedAt);
    if (isFinite(ts) && now - ts < CHANNEL_SPEED_TTL_MS) {
      out[url] = entry;
    }
  }
  return out;
}

// ─── L2：分片复验 ─────────────────────────────────────

/** 读满 maxBytes（或流结束）后拼成文本；播放列表通常几 KB 就结束 */
async function readTextUpTo(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  first: Uint8Array | undefined,
  maxBytes: number,
): Promise<string> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (first && first.length > 0) {
    chunks.push(first);
    total += first.length;
  }
  while (total < maxBytes) {
    const { value, done } = await reader.read();
    if (done || !value) break;
    chunks.push(value);
    total += value.length;
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    // 只按 maxBytes 截断，避免超长 VOD 列表把内存吃掉
    const slice = off + c.length > maxBytes ? c.subarray(0, maxBytes - off) : c;
    buf.set(slice, off);
    off += slice.length;
  }
  return new TextDecoder().decode(buf.subarray(0, off));
}

/** 取播放列表里第一个非 # 开头的行，按 base 解析成绝对 URL */
export function firstUri(playlist: string, base: string): string | null {
  for (const raw of playlist.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    try {
      const u = new URL(line, base);
      return u.toString();
    } catch {
      return null;
    }
  }
  return null;
}

/** 小请求取文本（用于跟进主播放列表的子列表） */
async function fetchTextQuick(url: string, maxBytes = 32768): Promise<string | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), CHANNEL_PROBE_SEGMENT_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': TVBOX_UA } });
    if (!resp.ok) return null;
    const reader = resp.body?.getReader();
    if (!reader) return null;
    try {
      return await readTextUpTo(reader, undefined, maxBytes);
    } finally {
      clearTimeout(timer);
      reader.cancel().catch(() => {});
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 拉一小段分片，确认真能出数据（不是错误页、不是空响应） */
async function probeSegment(url: string): Promise<{ ok: boolean; bytes: number; note?: string }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), CHANNEL_PROBE_SEGMENT_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': TVBOX_UA } });
    if (!resp.ok) return { ok: false, bytes: 0, note: `分片 HTTP ${resp.status}` };
    const reader = resp.body?.getReader();
    if (!reader) return { ok: false, bytes: 0, note: '分片无响应体' };

    let got = 0;
    try {
      while (got < CHANNEL_PROBE_SEGMENT_BYTES) {
        const { value, done } = await reader.read();
        if (done || !value) break;
        got += value.length;
      }
    } finally {
      clearTimeout(timer);
      reader.cancel().catch(() => {});
    }

    if (got >= CHANNEL_PROBE_SEGMENT_MIN_BYTES) return { ok: true, bytes: got };
    return { ok: false, bytes: got, note: `分片仅 ${got}B` };
  } catch (e) {
    const timedOut = e instanceof Error && e.name === 'AbortError';
    return { ok: false, bytes: 0, note: timedOut ? '分片超时' : '分片请求失败' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 判断一个 m3u8 是否「真能播」：跟着播放列表找到第一个分片，拉 2~8KB 验证。
 * 主播放列表（含 #EXT-X-STREAM-INF）最多往下钻两层。
 *
 * 返回 ok=true 且 note='无分片' 表示列表里没有分片（罕见），保守判为可用，
 * 避免把写法特殊的源误杀。
 */
export async function verifyPlayable(
  playlistText: string,
  baseUrl: string,
): Promise<{ ok: boolean; note?: string; segUrl?: string }> {
  let body = playlistText;
  let base = baseUrl;

  for (let level = 0; level < 2 && body.includes('#EXT-X-STREAM-INF'); level++) {
    const variant = firstUri(body, base);
    if (!variant) return { ok: false, note: '子列表地址缺失' };
    const text = await fetchTextQuick(variant);
    if (!text || !text.includes('#EXTM3U')) return { ok: false, note: '子列表不可达' };
    body = text;
    base = variant;
  }

  const seg = firstUri(body, base);
  if (!seg) return { ok: true, note: '无分片' };

  const r = await probeSegment(seg);
  return { ok: r.ok, note: r.note, segUrl: seg };
}

// ─── 单 URL 测试 ───────────────────────────────────────

interface ProbeResult {
  url: string;
  speedMs: number;
  kind: 'm3u8' | 'ts' | 'tcp' | 'fail';
  samples: number;
  /** 判定依据：playlist=只看清单（L1）/ segment=验过分片（L2） */
  stage?: 'playlist' | 'segment';
  /** 失败原因，用于后台展示「为什么不可用」 */
  note?: string;
}

/** L2 分片复验开关；由 runChannelProbe 读取 KV 后设置，默认开启 */
let segmentCheckEnabled = true;

export function setSegmentCheckEnabled(v: boolean): void {
  segmentCheckEnabled = v;
}

interface OnceResult {
  speedMs: number;
  kind: 'm3u8' | 'ts' | 'tcp' | 'fail';
  timedOut: boolean;
  stage?: 'playlist' | 'segment';
  note?: string;
}

async function probeOnce(url: string, skipL2 = false): Promise<OnceResult> {
  const isM3U8 = /\.m3u8(\?|$)/i.test(url);
  const isTs = /\.(ts|flv|mp4)(\?|$)/i.test(url);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHANNEL_PROBE_TIMEOUT_MS);
  const start = Date.now();

  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': TVBOX_UA },
    });
    const ttfb = Date.now() - start;

    if (!resp.ok) {
      clearTimeout(timer);
      return { speedMs: 0, kind: 'fail', timedOut: false };
    }

    const reader = resp.body?.getReader();
    if (!reader) {
      clearTimeout(timer);
      return { speedMs: ttfb, kind: 'tcp', timedOut: false };
    }

    try {
      const { value } = await reader.read();
      if (!value) {
        return { speedMs: ttfb, kind: 'tcp', timedOut: false };
      }

      // 有些源地址不以 .m3u8 结尾（migu.php?pid=… / 直播壳短链），但返回的确实是播放列表。
      // 只按扩展名判断会让它们绕过 L2，直接以「首包可达」排到最前。
      const headText = new TextDecoder().decode(value.slice(0, Math.min(2048, value.length)));
      const playlistLike = isM3U8 || (!isTs && headText.includes('#EXTM3U'));

      if (playlistLike) {
        // 列表本身很小（几 KB），读完再判断；只看前 1KB 会漏掉后面的 #EXT-X-STREAM-INF
        const playlist = await readTextUpTo(reader, value, 64 * 1024);
        if (!playlist.includes('#EXTM3U')) {
          return { speedMs: 0, kind: 'fail', timedOut: false, stage: 'playlist', note: '不是 m3u8' };
        }
        if (!segmentCheckEnabled || skipL2) {
          return { speedMs: ttfb, kind: 'm3u8', timedOut: false, stage: 'playlist' };
        }

        // L2：列表可达不等于能播 —— 分片可能指向另一台已失效的源站。
        // 先释放列表连接，再单独拉分片（分片有自己的 4 秒超时）。
        await reader.cancel().catch(() => {});
        const check = await verifyPlayable(playlist, url);
        if (!check.ok) {
          return { speedMs: 0, kind: 'fail', timedOut: false, stage: 'segment', note: check.note };
        }
        return { speedMs: ttfb, kind: 'm3u8', timedOut: false, stage: 'segment', note: check.note };
      }

      if (isTs) {
        // 检查 sync byte 0x47（4KB 内任何位置）
        const end = Math.min(4096, value.length);
        for (let i = 0; i < end; i += 188) {
          if (value[i] === 0x47) {
            return { speedMs: ttfb, kind: 'ts', timedOut: false };
          }
        }
        // 没找到 sync byte 也不一定失败（可能是 HTTP-FLV 等），用 tcp 标记
        return { speedMs: ttfb, kind: 'tcp', timedOut: false };
      }

      return { speedMs: ttfb, kind: 'tcp', timedOut: false };
    } finally {
      clearTimeout(timer);
      reader.cancel().catch(() => {});
    }
  } catch (e: unknown) {
    clearTimeout(timer);
    const timedOut = e instanceof Error && e.name === 'AbortError';
    return { speedMs: 0, kind: 'fail', timedOut };
  }
}

/**
 * 多次采样取中位数：单次 TTFB 抖动很大（DNS/首包/CDN 调度），
 * 用中位数排序才能让「真正快」的源稳定排第一。
 *
 * 失败重试策略：只有「快速失败」（连接被拒/404）才重试，
 * 超时已经等满 5 秒，再试一次纯属浪费——死链占大头，这一步能省一半时间。
 */
async function probeSingle(url: string): Promise<ProbeResult> {
  const ok: Array<{ speedMs: number; kind: 'm3u8' | 'ts' | 'tcp' }> = [];
  let segNote: string | undefined;
  let verified = false;

  for (let i = 0; i < CHANNEL_PROBE_SAMPLES; i++) {
    // L2 结果对同一条 URL 是结构性的，只在第一次采样做，后续采样跳过（省一半分片请求）
    const r = await probeOnce(url, i > 0);
    if (r.kind === 'fail') {
      if (r.stage === 'segment') {
        // 分片 404 / 拉不到数据：重试无意义，直接判死并记下原因
        segNote = r.note;
        break;
      }
      if (r.timedOut) break;
      const retry = await probeOnce(url, true);
      if (retry.kind === 'fail') break;
      ok.push({ speedMs: retry.speedMs, kind: retry.kind });
    } else {
      if (r.stage === 'segment') verified = true;
      ok.push({ speedMs: r.speedMs, kind: r.kind });
    }
  }

  if (ok.length === 0) {
    return {
      url, speedMs: 0, kind: 'fail', samples: 0,
      stage: segNote ? 'segment' : 'playlist',
      note: segNote,
    };
  }

  const speeds = ok.map((r) => r.speedMs).sort((a, b) => a - b);
  const median = speeds[Math.floor(speeds.length / 2)];
  // 保留最具体的判定（m3u8 > ts > tcp）
  const best = ok.find((r) => r.kind === 'm3u8') || ok.find((r) => r.kind === 'ts') || ok[0];

  return {
    url, speedMs: median, kind: best.kind, samples: ok.length,
    stage: verified ? 'segment' : 'playlist',
  };
}

// ─── 并发池 ────────────────────────────────────────────

async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  onProgress?: (done: number, total: number) => void,
  deadline?: number,
): Promise<{ results: R[]; done: number; budgetExhausted: boolean }> {
  const results: R[] = new Array(items.length);
  let index = 0;
  let done = 0;
  let budgetExhausted = false;

  async function worker() {
    while (index < items.length) {
      if (deadline && Date.now() >= deadline) {
        budgetExhausted = true;
        return;
      }
      const i = index++;
      try {
        results[i] = await fn(items[i], i);
      } catch {
        // 兜底：fn 理论上已内部 try/catch；此路径保险返回显式 fail 对象
        results[i] = { url: String(items[i]), speedMs: 0, kind: 'fail', samples: 0 } as R;
      }
      done++;
      if (onProgress && done % 50 === 0) onProgress(done, items.length);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  if (onProgress) onProgress(done, items.length);
  return { results, done, budgetExhausted };
}

// ─── 主入口 ────────────────────────────────────────────

let running = false;

export async function runChannelProbe(storage: Storage): Promise<ChannelProbeStatus> {
  if (running) {
    console.log('[channel-probe] Already running, skipping');
    return loadStatus(storage);
  }

  if (!(await isProbeEnabled(storage))) {
    console.log('[channel-probe] Disabled by user, skipping');
    return loadStatus(storage);
  }

  // 读取上次合并的频道树
  const treeRaw = await storage.get(KV_CHANNEL_MERGED_TREE);
  if (!treeRaw) {
    console.log('[channel-probe] No merged tree available, skipping (run main aggregation first)');
    const status: ChannelProbeStatus = {
      state: 'error',
      totalUrls: 0,
      probed: 0,
      success: 0,
      failed: 0,
      totalChannels: 0,
      coverage: 0,
      error: 'No merged channel tree (run main aggregation first)',
    };
    await saveStatus(storage, status);
    return status;
  }

  let groups: TVBoxLiveGroup[];
  try {
    groups = JSON.parse(treeRaw);
  } catch (err) {
    const status: ChannelProbeStatus = {
      state: 'error',
      totalUrls: 0,
      probed: 0,
      success: 0,
      failed: 0,
      totalChannels: 0,
      coverage: 0,
      error: `Parse merged tree failed: ${err}`,
    };
    await saveStatus(storage, status);
    return status;
  }

  const urls = extractAllUrls(groups);
  const totalChannels = groups.reduce((n, g) => n + g.channels.length, 0);

  if (urls.length === 0) {
    const status: ChannelProbeStatus = {
      state: 'done',
      totalUrls: 0,
      probed: 0,
      success: 0,
      failed: 0,
      totalChannels,
      coverage: 0,
      finishedAt: new Date().toISOString(),
      durationMs: 0,
    };
    await saveStatus(storage, status);
    return status;
  }

  running = true;
  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  let success = 0;
  let failed = 0;

  const status: ChannelProbeStatus = {
    state: 'running',
    startedAt,
    totalUrls: urls.length,
    probed: 0,
    success: 0,
    failed: 0,
    totalChannels,
    coverage: 0,
  };
  await saveStatus(storage, status);

  console.log(`[channel-probe] Started: ${urls.length} URLs, ${totalChannels} channels, concurrency=${CHANNEL_PROBE_CONCURRENCY}`);

  try {
    // 读旧缓存：不过期就复用，过期的全部重测（旧实现是「测过就永不再测」，导致排序永久固化）
    const cached = await loadSpeedMap(storage);
    const nowMs = Date.now();
    /**
     * 条目版本：显式写了 ruleVer 就用它；没写但带 stage 的，说明是「分片复验」之后产生的，
     * 视为当前版本（迁移老缓存时避免整表重测一次）；两者都没有的才是上个时代的结论。
     */
    /**
     * 条目版本：显式写了 ruleVer 就用它。老条目没有版本号，按「判定深度」推断：
     *   · 验过分片（stage=segment）→ 当前版本，不用重测
     *   · 失败条目 → 结论本身与分片无关（列表就拿不到），也算当前版本
     *   · 成功但只看了清单（stage=playlist，多为 tcp/ts 或非 .m3u8 地址）→ 版本 2，需要补一次分片复验
     */
    const entryVersion = (e: ChannelSpeedEntry): number => {
      if (e.ruleVer) return e.ruleVer;
      if (e.kind === 'fail') return CHANNEL_PROBE_RULE_VERSION;
      if (e.stage === 'segment') return CHANNEL_PROBE_RULE_VERSION;
      return 2;
    };

    // 判定规则变过（版本落后）的条目：必须重测一次，否则旧结论会一直沿用
    const isOutdated = (u: string): boolean => {
      const e = cached[u];
      return !!e && entryVersion(e) !== CHANNEL_PROBE_RULE_VERSION;
    };

    /**
     * 分级回测间隔：
     *   成功源 6 小时；失败但未确认 6 小时；确认死链 24 小时（撞一次要等满超时，不必和好源一样勤）
     * 规则版本落后的条目不看时间，直接进队列。
     */
    const recheckInterval = (e: ChannelSpeedEntry): number => {
      if (e.kind === 'fail' && (e.fails ?? 0) >= CHANNEL_DEAD_FAILS) return CHANNEL_DEAD_RECHECK_MS;
      return CHANNEL_SPEED_TTL_MS;
    };

    const isStale = (u: string): boolean => {
      const e = cached[u];
      if (!e) return true;
      if (isOutdated(u)) return true;
      const t = Date.parse(e.probedAt);
      return !isFinite(t) || nowMs - t > recheckInterval(e);
    };

    // 待测队列：规则升级的排最前（它们决定排序是否可信），其余按上次测速时间由旧到新
    const toProbe = urls.filter(isStale).sort((a, b) => {
      const oa = isOutdated(a) ? 0 : 1;
      const ob = isOutdated(b) ? 0 : 1;
      if (oa !== ob) return oa - ob;
      const ta = cached[a] ? Date.parse(cached[a].probedAt) || 0 : 0;
      const tb = cached[b] ? Date.parse(cached[b].probedAt) || 0 : 0;
      return ta - tb;
    });
    const freshCount = urls.length - toProbe.length;
    const outdatedCount = urls.filter(isOutdated).length;
    console.log(
      `[channel-probe] ${toProbe.length} URLs to probe ` +
      `(${freshCount} fresh, ${outdatedCount} from older rules, ttl=${Math.round(CHANNEL_SPEED_TTL_MS / 3600000)}h)`,
    );

    // 只保留仍在当前频道树里的 URL（老 URL 自然淘汰）
    const urlSet = new Set(urls);
    const next: ChannelSpeedMap = {};
    for (const [u, e] of Object.entries(cached)) {
      if (urlSet.has(u)) next[u] = e;
    }

    // 本轮恢复可用的 URL（用于自动移出死源黑名单）
    const recovered: string[] = [];

    // 每条结果即时落到 next，并定期落盘 —— 跑 20 分钟的任务不能一崩全丢
    const applyResult = (r: ProbeResult): void => {
      if (!r || !r.url) return;
      const prev = next[r.url];
      if (r.kind === 'fail') {
        failed++;
        // 连续失败累计：达到阈值才算死链（单次抖动不算）
        next[r.url] = {
          speedMs: 0,
          probedAt: new Date().toISOString(),
          kind: 'fail',
          fails: (prev?.fails ?? 0) + 1,
          ruleVer: CHANNEL_PROBE_RULE_VERSION,
          stage: r.stage,
          note: r.note,
        };
      } else {
        success++;
        recovered.push(r.url);
        next[r.url] = {
          speedMs: r.speedMs,
          probedAt: new Date().toISOString(),
          kind: r.kind,
          fails: 0,
          samples: r.samples,
          ruleVer: CHANNEL_PROBE_RULE_VERSION,
          stage: r.stage,
        };
      }
    };

    const { done, budgetExhausted } = await runWithConcurrency(
      toProbe,
      CHANNEL_PROBE_CONCURRENCY,
      async (url) => {
        const r = await probeSingle(url);
        applyResult(r);
        return r;
      },
      (d, total) => {
        status.probed = d + freshCount; // 含缓存命中
        status.success = success;
        status.failed = failed;
        saveStatus(storage, status).catch(() => {});
        if (d % 300 === 0) {
          saveSpeedMap(storage, next).catch(() => {});
          console.log(`[channel-probe] Progress: ${d}/${total}`);
        }
      },
      startMs + CHANNEL_PROBE_BUDGET_MS,
    );

    await saveSpeedMap(storage, next);

    // 自愈：之前被判死、这次又活了的 URL，移出死源黑名单
    if (recovered.length > 0) {
      const revived = await removeRecoveredUrls(storage, recovered);
      if (revived > 0) console.log(`[channel-probe] ${revived} URLs recovered, removed from dead list`);
    }

    // 覆盖率按「可用缓存」算：成功 + 未过期未重测的
    const okCached = Object.entries(next).filter(
      ([, e]) => e.kind !== 'fail' && nowMs - (Date.parse(e.probedAt) || 0) <= CHANNEL_SPEED_TTL_MS,
    ).length;
    const deadCount = Object.values(next).filter((e) => (e.fails ?? 0) >= CHANNEL_DEAD_FAILS).length;
    const durationMs = Date.now() - startMs;
    const coverage = urls.length > 0 ? Math.round((okCached / urls.length) * 100) : 0;

    const finalStatus: ChannelProbeStatus = {
      state: budgetExhausted ? 'partial' : 'done',
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs,
      totalUrls: urls.length,
      probed: done + freshCount,
      success,
      failed,
      totalChannels,
      coverage,
      pending: toProbe.length - done,
      dead: deadCount,
    };
    await saveStatus(storage, finalStatus);

    console.log(
      `[channel-probe] ${budgetExhausted ? 'Budget reached' : 'Done'} in ${(durationMs / 1000).toFixed(1)}s: ` +
      `probed ${done}/${toProbe.length}, ok=${okCached}/${urls.length} (${coverage}%), dead=${deadCount}` +
      (budgetExhausted ? `, ${toProbe.length - done} left for next round` : ''),
    );

    return finalStatus;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const errStatus: ChannelProbeStatus = {
      state: 'error',
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startMs,
      totalUrls: urls.length,
      probed: status.probed,
      success,
      failed,
      totalChannels,
      coverage: 0,
      error: msg,
    };
    await saveStatus(storage, errStatus);
    console.error(`[channel-probe] Error: ${msg}`);
    return errStatus;
  } finally {
    running = false;
  }
}

export function isRunning(): boolean {
  return running;
}
