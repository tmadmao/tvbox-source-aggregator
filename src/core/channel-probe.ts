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
  CHANNEL_PROBE_SEGMENT_MIN_KBPS,
  CHANNEL_SPEED_TTL_MS,
  CHANNEL_SPEED_MAP_KEEP_MS,
  CHANNEL_DEAD_RECHECK_MS,
  CHANNEL_PROBE_RULE_VERSION,
  CHANNEL_DEAD_FAILS,
  KV_CHANNEL_PROBE_SEGMENT,
  TVBOX_UA,
} from './config';
import { extractAllUrls } from './live-merger';
import { buildUrlTierMap, TIER_RANK } from './channel-curation';
import { fetchPrefix } from './probe-net';
import { recordProbe } from './source-health';
import {
  removeRecoveredUrls,
  loadDeadRows,
  touchProbed,
  DEAD_RETEST_MS,
  CONDEMNED_RETEST_MS,
} from './live-deadlist';
import {
  loadHostMap,
  saveHostRows,
  hostSampleQuota,
  sampleHostUrls,
  applyHostOutcomes,
  hostOf,
  HOST_MIN_URLS,
  type HostProbeOutcome,
} from './host-health';

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

/**
 * 写回测速缓存。
 *
 * 两个坑：
 *  1) 落盘前裁掉物理过期项（7 天），否则这张表只增不减；
 *  2) `merge=true` 用于「只改了一部分条目」的写入方（守夜、输出前复核、聚合头部复核）。
 *     它们各自 load → 改几条 → 全量写，两个任务并发时后写会把前写的改动整段抹掉
 *     （全量覆盖写 + 无锁）。合并策略按 probedAt 取新者，互不覆盖。
 *     全量测速自己那一路（map 是从当前频道树重建的）必须保持 replace 语义，
 *     否则频道树里已经消失的 URL 会被旧缓存复活。
 */
export async function saveSpeedMap(
  storage: Storage,
  map: ChannelSpeedMap,
  opts: { merge?: boolean } = {},
): Promise<void> {
  let out = map;
  if (opts.merge) {
    try {
      const raw = await storage.get(KV_CHANNEL_SPEED_MAP);
      if (raw) {
        const disk = JSON.parse(raw) as ChannelSpeedMap;
        const merged: ChannelSpeedMap = { ...disk };
        for (const [url, mine] of Object.entries(map)) {
          const theirs = disk[url];
          if (!theirs) { merged[url] = mine; continue; }
          const tMine = Date.parse(mine.probedAt) || 0;
          const tTheirs = Date.parse(theirs.probedAt) || 0;
          merged[url] = tMine >= tTheirs ? mine : theirs;
        }
        out = merged;
      }
    } catch {
      // 磁盘内容坏了就整段覆盖，至少本轮结论不丢
    }
  }
  await storage.put(KV_CHANNEL_SPEED_MAP, JSON.stringify(pruneExpired(out)));
}

/**
 * 清空测速缓存，强制下一轮全量重测。
 * 用途：改了判定规则（比如这次加了分片复验）之后，旧结论不能再用，否则要等 TTL 到期。
 */
export async function clearSpeedMap(storage: Storage): Promise<number> {
  const before = await loadSpeedMap(storage);
  await saveSpeedMap(storage, {});
  return Object.keys(before).length;
}

/**
 * 裁掉物理过期的条目（7 天）。
 *
 * 注意与 `CHANNEL_SPEED_TTL_MS`（6 小时）的区别：那个是「该重测了」，
 * 这个是「留着也没用了」。不裁的结果是 channel_speed_map 只增不减 ——
 * 历史 URL 全留着，单 key 体积一直涨（CF 侧单 value 有 25MB 上限）。
 */
export function pruneExpired(map: ChannelSpeedMap, now = Date.now()): ChannelSpeedMap {
  const out: ChannelSpeedMap = {};
  for (const [url, entry] of Object.entries(map)) {
    const ts = Date.parse(entry.probedAt);
    if (isFinite(ts) && now - ts < CHANNEL_SPEED_MAP_KEEP_MS) {
      out[url] = entry;
    }
  }
  return out;
}

// ─── L2：分片复验 ─────────────────────────────────────

/** 读满 maxBytes（或流结束）后拼成文本；播放列表通常几 KB 就结束 */
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

/** 取播放列表里最后一个分片（直播边缘比首个分片更能代表「现在能不能播」） */
export function lastUri(playlist: string, base: string): string | null {
  let last: string | null = null;
  for (const raw of playlist.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    try {
      last = new URL(line, base).toString();
    } catch {
      return null;
    }
  }
  return last;
}

/** 小请求取文本（用于跟进主播放列表的子列表） */
async function fetchTextQuick(url: string, maxBytes = 32768): Promise<string | null> {
  const r = await fetchPrefix(url, maxBytes, CHANNEL_PROBE_SEGMENT_TIMEOUT_MS, {
    'User-Agent': TVBOX_UA,
  });
  if (r.status === 0 || r.status >= 400 || r.data.length === 0) return null;
  return r.data.toString('utf8');
}

/** 拉一小段分片，确认真能出数据（不是错误页、不是空响应） */
async function probeSegment(url: string): Promise<{ ok: boolean; bytes: number; note?: string }> {
  const r = await fetchPrefix(url, CHANNEL_PROBE_SEGMENT_BYTES, CHANNEL_PROBE_SEGMENT_TIMEOUT_MS, {
    'User-Agent': TVBOX_UA,
  });
  if (r.status === 0) return { ok: false, bytes: 0, note: r.timedOut ? '分片超时' : '分片请求失败' };
  if (r.status >= 400) return { ok: false, bytes: 0, note: `分片 HTTP ${r.status}` };
  const ctype = r.contentType.toLowerCase();
  if (/text\/html|application\/json|text\/plain/.test(ctype)) {
    return { ok: false, bytes: r.data.length, note: `分片类型 ${ctype.split(';')[0]}` };
  }
  const kbps = Math.round((r.data.length / 1024) / Math.max(0.001, r.ms / 1000));
  if (r.data.length < CHANNEL_PROBE_SEGMENT_MIN_BYTES) {
    return { ok: false, bytes: r.data.length, note: r.timedOut ? '分片超时' : `分片仅 ${r.data.length}B` };
  }
  if (kbps < CHANNEL_PROBE_SEGMENT_MIN_KBPS) {
    return { ok: false, bytes: r.data.length, note: `吞吐仅 ${kbps}KB/s` };
  }
  return { ok: true, bytes: r.data.length };
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

  // 用最后一个分片：首个分片常被 CDN 缓存，不能代表当前直播边缘
  const seg = lastUri(body, base);
  if (!seg) return { ok: false, note: '无分片' };

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

/** L2 分片复验开关；由 runChannelProbe 读 KV 后设置（也可由调用方按次传入），默认开启 */
let segmentCheckEnabled = true;

export function setSegmentCheckEnabled(v: boolean): void {
  segmentCheckEnabled = v;
}

export interface OnceResult {
  speedMs: number;
  kind: 'm3u8' | 'ts' | 'tcp' | 'fail';
  timedOut: boolean;
  stage?: 'playlist' | 'segment';
  note?: string;
}

/**
 * @param skipL2  本次强制只看清单（多次采样时后续采样用）
 * @param requireSegment 本次的分片复验开关；不传则用模块级设置
 */
export async function probeUrlOnce(url: string, skipL2 = false, requireSegment?: boolean): Promise<OnceResult> {
  const segEnabled = requireSegment ?? segmentCheckEnabled;
  const isM3U8 = /\.m3u8(\?|$)/i.test(url);
  const isTs = /\.(ts|flv|mp4)(\?|$)/i.test(url);

  // 读满 64KB 再判断：只读首包会放过「开头出数据、随后卡死」的源。
  // fetchPrefix 用 undici.request 的 Node Readable，读够就 destroy，不会触发
  // WebStream 的 ERR_INVALID_STATE 崩溃。
  const r = await fetchPrefix(url, CHANNEL_PROBE_SEGMENT_BYTES, CHANNEL_PROBE_TIMEOUT_MS, {
    'User-Agent': TVBOX_UA,
  });
  if (r.status === 0) {
    return { speedMs: 0, kind: 'fail', timedOut: r.timedOut, note: r.timedOut ? '连接超时' : '连接失败' };
  }
  if (r.status >= 400) {
    return { speedMs: 0, kind: 'fail', timedOut: false, note: `HTTP ${r.status}` };
  }
  const ctype = r.contentType.toLowerCase();
  if (/text\/html|application\/json|text\/plain/.test(ctype)) {
    return { speedMs: 0, kind: 'fail', timedOut: false, note: `非视频内容 ${ctype.split(';')[0]}` };
  }

  const data = r.data;
  const headText = data.subarray(0, Math.min(2048, data.length)).toString('utf8');
  const playlistLike = isM3U8 || (!isTs && headText.includes('#EXTM3U'));

  if (playlistLike) {
    const playlist = data.toString('utf8');
    if (!playlist.includes('#EXTM3U')) {
      return { speedMs: 0, kind: 'fail', timedOut: false, stage: 'playlist', note: '不是 m3u8' };
    }
    if (!segEnabled || skipL2) {
      return { speedMs: r.ms, kind: 'm3u8', timedOut: false, stage: 'playlist' };
    }
    const check = await verifyPlayable(playlist, url);
    if (!check.ok) {
      return { speedMs: 0, kind: 'fail', timedOut: false, stage: 'segment', note: check.note };
    }
    return { speedMs: r.ms, kind: 'm3u8', timedOut: false, stage: 'segment', note: check.note };
  }

  const binaryLike = isTs || /octet-stream|video\//.test(ctype);
  if (!binaryLike) {
    return { speedMs: 0, kind: 'fail', timedOut: false, note: '非视频内容' };
  }

  const kbps = Math.round((data.length / 1024) / Math.max(0.001, r.ms / 1000));
  if (data.length < CHANNEL_PROBE_SEGMENT_MIN_BYTES) {
    return { speedMs: 0, kind: 'fail', timedOut: r.timedOut, stage: 'segment', note: r.timedOut ? '读取超时' : `仅 ${data.length}B` };
  }
  if (kbps < CHANNEL_PROBE_SEGMENT_MIN_KBPS) {
    return { speedMs: 0, kind: 'fail', timedOut: false, stage: 'segment', note: `吞吐 ${kbps}KB/s` };
  }

  const end = Math.min(4096, data.length);
  let hasTsSync = false;
  for (let i = 0; i < end; i += 188) {
    if (data[i] === 0x47) { hasTsSync = true; break; }
  }
  if (hasTsSync) return { speedMs: r.ms, kind: 'ts', timedOut: false, stage: 'segment' };
  const isFlv = data.length > 3 && data[0] === 0x46 && data[1] === 0x4c && data[2] === 0x56;
  const isMp4 = data.length > 8 && data[4] === 0x66 && data[5] === 0x74 && data[6] === 0x79 && data[7] === 0x70;
  if (isFlv || isMp4) return { speedMs: r.ms, kind: 'tcp', timedOut: false, stage: 'segment' };
  return { speedMs: 0, kind: 'fail', timedOut: false, note: '无法识别容器' };
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
    const r = await probeUrlOnce(url, i > 0);
    if (r.kind === 'fail') {
      if (r.stage === 'segment') {
        // 分片 404 / 拉不到数据：重试无意义，直接判死并记下原因
        segNote = r.note;
        break;
      }
      if (r.timedOut) break;
      const retry = await probeUrlOnce(url, true);
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

  // 把界面上的「L2 分片复验」开关真正接进探测路径。
  // 以前这个 KV 只被评分侧读成 requireSegment（放宽分数），探测侧照旧发分片请求，
  // 等于「关了开关只是判得松一点」，与界面承诺不符。
  setSegmentCheckEnabled((await storage.get(KV_CHANNEL_PROBE_SEGMENT)) !== 'false');
  /**
   * 测速优先级：央视 → 卫视 → 地方台 → 其他。
   *
   * 以前待测队列只按「上次测速时间」排，预算紧的时候（单轮 20 分钟）可能整轮都
   * 没轮到央视，输出用的就是半天前的旧结论。用户看的就是央视和卫视，
   * 这两档的结论必须是本轮的。
   */
  const tierMap = buildUrlTierMap(groups);
  const tierRankOf = (u: string): number => TIER_RANK.get(tierMap.get(u) ?? 'other') ?? 9;

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
    // 死源台账：决定「判过死的源多久回测一次」。台账里没有的，仍走原来的 6h/24h 规则。
    const deadLedger = new Map((await loadDeadRows(storage)).map((r) => [r.url, r]));
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
      // 失败结论与判定深度无关（列表都拿不到），视为当前版本
      if (e.kind === 'fail') return CHANNEL_PROBE_RULE_VERSION;
      // 成功但没盖版本号 = 更早的规则判的，按当前规则重判一次
      return 2;
    };

    // 判定规则变过（版本落后）的条目：必须重测一次，否则旧结论会一直沿用
    const isOutdated = (u: string): boolean => {
      const e = cached[u];
      return !!e && entryVersion(e) !== CHANNEL_PROBE_RULE_VERSION;
    };

    /**
     * 分级回测间隔：
     *   成功源 6 小时；失败但未确认 6 小时；
     *   进了台账的：待观察 7 天、判死 30 天（台账就是「这源判过死」的记录，比 fails 计数更权威）；
     *   没进台账但连续失败的，仍按 24 小时。
     * 规则版本落后的条目不看时间，直接进队列。
     */
    const recheckInterval = (u: string, e: ChannelSpeedEntry): number => {
      const row = deadLedger.get(u);
      if (row) return row.state === 2 ? CONDEMNED_RETEST_MS : DEAD_RETEST_MS;
      if (e.kind === 'fail' && (e.fails ?? 0) >= CHANNEL_DEAD_FAILS) return CHANNEL_DEAD_RECHECK_MS;
      return CHANNEL_SPEED_TTL_MS;
    };

    const isStale = (u: string): boolean => {
      const e = cached[u];
      if (!e) return true;
      if (isOutdated(u)) return true;
      const t = Date.parse(e.probedAt);
      return !isFinite(t) || nowMs - t > recheckInterval(u, e);
    };

    // 待测队列：规则升级的排最前（它们决定排序是否可信），其余按上次测速时间由旧到新
    const staleUrls = urls.filter(isStale).sort((a, b) => {
      const ta = tierRankOf(a);
      const tb = tierRankOf(b);
      if (ta !== tb) return ta - tb;
      const oa = isOutdated(a) ? 0 : 1;
      const ob = isOutdated(b) ? 0 : 1;
      if (oa !== ob) return oa - ob;
      const ma = cached[a] ? Date.parse(cached[a].probedAt) || 0 : 0;
      const mb = cached[b] ? Date.parse(cached[b].probedAt) || 0 : 0;
      return ma - mb;
    });

    /**
     * 域名层收口（实测：1859 个域名名下 12352 条源一条都播不出来）：
     *   · 域名进了台账且还没到复验时间 → 名下整片跳过，一条都不测
     *   · 到了复验时间 → 只抽 3 条（按哈希均匀取，不是取前 3 条）
     *   · 域名不在台账 → 原样全测
     * 这样把「一两万条死链每周全测一遍」压到「两千个域名各抽 3 条」。
     */
    const hostMap = await loadHostMap(storage);
    const toProbe: string[] = [];
    let sampledHosts = 0;
    {
      const byHost = new Map<string, string[]>();
      for (const u of staleUrls) {
        const h = hostOf(u);
        const list = byHost.get(h);
        if (list) list.push(u); else byHost.set(h, [u]);
      }
      for (const [h, list] of byHost) {
        const quota = hostSampleQuota(hostMap.get(h), nowMs);
        if (quota < 0) { toProbe.push(...list); continue; }
        if (quota === 0) {
          // 域名还没到复验时间：普通源整域跳过，但重点频道（央视/卫视/地方台）
          // 不吃这一刀 —— 它们正是「打开电视就看」的那几十个台，结论过期比浪费请求更糟。
          const focus = list.filter((u) => tierRankOf(u) <= 2);
          if (focus.length > 0) toProbe.push(...focus);
          continue;
        }
        const picked = sampleHostUrls(list, quota);
        if (picked.length < list.length) sampledHosts++;
        toProbe.push(...picked);
      }
      toProbe.sort((a, b) => {
        const ta = tierRankOf(a);
        const tb = tierRankOf(b);
        if (ta !== tb) return ta - tb;
        const oa = isOutdated(a) ? 0 : 1;
        const ob = isOutdated(b) ? 0 : 1;
        if (oa !== ob) return oa - ob;
        const ma = cached[a] ? Date.parse(cached[a].probedAt) || 0 : 0;
        const mb = cached[b] ? Date.parse(cached[b].probedAt) || 0 : 0;
        return ma - mb;
      });
    }
    const freshCount = urls.length - toProbe.length;
    const outdatedCount = urls.filter(isOutdated).length;
    console.log(
      `[channel-probe] ${toProbe.length} URLs to probe ` +
      `(${freshCount} fresh, ${sampledHosts} hosts sampled, ${outdatedCount} from older rules, ` +
      `ttl=${Math.round(CHANNEL_SPEED_TTL_MS / 3600000)}h)`,
    );

    // 只保留仍在当前频道树里的 URL（老 URL 自然淘汰）
    const urlSet = new Set(urls);
    const next: ChannelSpeedMap = {};
    for (const [u, e] of Object.entries(cached)) {
      if (urlSet.has(u)) next[u] = e;
    }

    // 本轮恢复可用的 URL（用于自动移出死源台账）
    const recovered: string[] = [];
    // 台账里被回测过的 URL（用于刷新 probedAt，让周/月周期从这次算起）
    const probedInLedger: Array<{ url: string; ok: boolean }> = [];
    // 域名维度的本轮战果：域名 → 测了几条、通了几条
    const hostResults = new Map<string, { probed: number; ok: number }>();

    // 每条结果即时落到 next，并定期落盘 —— 跑 20 分钟的任务不能一崩全丢
    const applyResult = (r: ProbeResult): void => {
      if (!r || !r.url) return;
      if (r.kind === 'fail') failed++;
      else {
        success++;
        recovered.push(r.url);
      }
      if (deadLedger.has(r.url)) probedInLedger.push({ url: r.url, ok: r.kind !== 'fail' });
      const h = hostOf(r.url);
      if (h) {
        const cur = hostResults.get(h) || { probed: 0, ok: 0 };
        cur.probed++;
        if (r.kind !== 'fail') cur.ok++;
        hostResults.set(h, cur);
      }
      // 健康字段只经由 recordProbe 写入，probe 与「输出前复核」共用同一口径
      const entry = recordProbe(next, r.url, r);
      entry.ruleVer = CHANNEL_PROBE_RULE_VERSION;
      if (r.kind !== 'fail') entry.samples = r.samples;
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

    // 自愈：之前被判死、这次又活了的 URL，移出死源台账
    if (recovered.length > 0) {
      const revived = await removeRecoveredUrls(storage, recovered);
      if (revived > 0) console.log(`[channel-probe] ${revived} URLs recovered, removed from dead ledger`);
    }

    // 回测过但仍死的：只刷新「上次回测时间」，让 7 天 / 30 天的周期从这次重新计时
    const stillDead = probedInLedger.filter((x) => !x.ok).map((x) => x.url);
    if (stillDead.length > 0) await touchProbed(storage, stillDead);

    /**
     * 域名台账结算：
     *   有任一条通 → 域名恢复正常（撤销记录，名下源重新参与输出）
     *   抽样全失败且样本 ≥ 2 条 → 可疑；可疑满 30 天 → 判死（名下源不再输出）
     * 只测了 1 条就全失败的不下结论 —— 单条失败可能只是那个地址坏了，不能代表整个域名。
     */
    const outcomes: HostProbeOutcome[] = [];
    for (const [h, o] of hostResults) {
      if (o.ok > 0 || o.probed >= HOST_MIN_URLS) outcomes.push({ host: h, probed: o.probed, ok: o.ok });
    }
    if (outcomes.length > 0) {
      const applied = applyHostOutcomes(hostMap, outcomes, Date.now());
      // 落盘条件必须是「本轮改过台账」而不是「计数非 0」：
      // 已有域名再次抽样全失败时 revived/marked/condemned 都可能为 0，
      // 但 probedAt 必须刷新，否则 7 天 / 30 天的复验周期永远不前进（P0-2）。
      if (applied.touched > 0) {
        await saveHostRows(storage, [...hostMap.values()]);
        console.log(
          `[channel-probe] host ledger: revived=${applied.revived} marked=${applied.marked} ` +
          `condemned=${applied.condemned} touched=${applied.touched}`,
        );
      }
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
