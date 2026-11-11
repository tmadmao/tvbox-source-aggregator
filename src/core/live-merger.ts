// 直播源频道级合并（方案 D+）
// 流程：下载各源 m3u/txt → 解析为频道条目 → 规范化频道名 → 按频道合并 urls → 排序 → 组装 TVBoxLiveGroup[]

import type {
  TVBoxLiveGroup,
  TVBoxLiveChannel,
  ChannelSpeedMap,
} from './types';
import { TVBOX_UA, BROWSER_UA, CHANNEL_HOST_DIVERSIFY, LIVE_MIRROR_PREFIXES, LIVE_MIRROR_HOSTS } from './config';
import { splitUrlSource, bareUrl, joinUrlSource, compareBySpeed, diversifyByHost } from './live-url';
import { normalizeGroupName, groupPriority, type LiveGroupMergeConfig } from './live-groups';
import { isShoppingChannel, type ShoppingFilterConfig } from './live-filters';
import { resolveCrossChannelConflicts } from './channel-conflicts';

// ─── 输入条目 ──────────────────────────────────────────

export interface LiveSourceInput {
  name: string;     // 源显示名
  url: string;      // m3u/txt 文件地址
  ua?: string;
  header?: Record<string, string>;
  speedMs?: number; // 源级速度（用于粗粒度排序）
}

// ─── 解析后的频道条目 ──────────────────────────────────

interface ChannelEntry {
  group: string;
  name: string;
  logo?: string;
  url: string;
  source: string;       // 源 name，用作 $ 后缀
  sourceSpeedMs?: number;
}

// ─── 频道名规范化 ──────────────────────────────────────

const TRAD_SIMP_MAP: Record<string, string> = {
  '電': '电', '視': '视', '臺': '台', '頻': '频', '道': '道',
  '綜': '综', '藝': '艺', '體': '体', '育': '育', '劇': '剧',
  '經': '经', '華': '华', '東': '东', '西': '西', '國': '国',
  '際': '际', '亞': '亚', '歐': '欧', '財': '财', '鳳': '凤',
};

const SUFFIX_PATTERNS = [
  /\s*\[?hd\]?$/i,
  /\s*\[?uhd\]?$/i,
  /\s*\[?fhd\]?$/i,
  /\s*高清$/,
  /\s*超清$/,
  /\s*蓝光$/,
  /\s*藍光$/,
  /\s*4k$/i,
  /\s*1080p?$/i,
  /\s*720p?$/i,
];

/**
 * 央视编号归一：各源的写法五花八门
 *   CCTV-1 / CCTV 1 / CCTV1高清 / CCTV1综合 / CCTV1综合频道 → CCTV1
 *   CCTV-5+体育 / CCTV5+ / CCTV5+体育赛事 → CCTV5+
 *   CCTV4K / CCTV8K / CCTV16-4K 单独保留，不并入 CCTV4/8/16
 */
const CCTV_BRAND_SUFFIX = /(综合|财经|综艺|中文国际|体育赛事|体育|电影|国防军事|军事|电视剧|纪录|科教|戏曲|社会与法|新闻|少儿|音乐|农业农村|农业|高清|超清|频道)$/;

function normalizeCctvName(s: string): string | null {
  if (/^CCTV-?4K$/i.test(s)) return 'CCTV4K';
  if (/^CCTV-?8K$/i.test(s)) return 'CCTV8K';
  if (/^CCTV-?16-?4K$/i.test(s)) return 'CCTV16-4K';

  const m = s.match(/^CCTV[-_]?(\d{1,2})([+\-]?)(.*)$/i);
  if (!m) return null;
  const num = parseInt(m[1], 10);
  if (!(num >= 1 && num <= 20)) return null;

  const sep = m[2] || '';
  let tail = (m[3] || '').replace(/^[-_\s]+/, '');

  if (sep === '+') return `CCTV${num}+`;
  tail = tail.replace(CCTV_BRAND_SUFFIX, '');
  return tail ? `CCTV${num}${tail}` : `CCTV${num}`;
}

/** 央视中文台名 → 编号：央视一套 / 中央一台 → CCTV1 */
const CN_NUM = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二', '十三', '十四', '十五', '十六', '十七'];

function normalizeChannelName(raw: string): string {
  let s = raw.trim();
  // 繁→简
  let out = '';
  for (const ch of s) out += TRAD_SIMP_MAP[ch] || ch;
  s = out.replace(/\s+/g, '');

  const cctv = normalizeCctvName(s);
  if (cctv) return cctv;

  // 央视一套 / 中央一台 / 央视13套
  const cn = s.match(/^(央视|中央)([一二三四五六七八九十]+)套?台?$/);
  if (cn) {
    const idx = CN_NUM.indexOf(cn[2]);
    if (idx >= 0) return `CCTV${idx + 1}`;
  }

  // 去后缀
  for (const p of SUFFIX_PATTERNS) s = s.replace(p, '');
  return s.trim() || raw.trim(); // 规范化空则退回原名
}

// ─── m3u/txt 解析 ──────────────────────────────────────

/**
 * 解析 m3u 格式
 *   #EXTM3U
 *   #EXTINF:-1 tvg-name="..." tvg-logo="..." group-title="央视",CCTV-1
 *   http://...
 */
function parseM3U(content: string, source: string, sourceSpeedMs?: number): ChannelEntry[] {
  const lines = content.split(/\r?\n/);
  const out: ChannelEntry[] = [];
  let currentName = '';
  let currentGroup = '其他';
  let currentLogo: string | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (line.startsWith('#EXTINF')) {
      // 解析属性
      const grpM = line.match(/group-title="([^"]+)"/i);
      currentGroup = grpM ? grpM[1] : '其他';
      const logoM = line.match(/tvg-logo="([^"]+)"/i);
      currentLogo = logoM ? logoM[1] : undefined;
      const commaIdx = line.lastIndexOf(',');
      currentName = commaIdx > 0 ? line.slice(commaIdx + 1).trim() : '';
    } else if (line.startsWith('#')) {
      continue; // 其他指令忽略
    } else if (currentName && /^https?:\/\//i.test(line)) {
      const { url, source: urlSource } = splitUrlSource(line, source);
      out.push({
        group: currentGroup,
        name: currentName,
        logo: currentLogo,
        url,
        source: urlSource,
        sourceSpeedMs,
      });
      currentName = '';
      currentLogo = undefined;
    }
  }
  return out;
}

/**
 * 解析 DIYP/txt 格式
 *   央视,#genre#
 *   CCTV-1,http://url1$源A#http://url2$源B
 *   CCTV-2,http://...
 */
function parseTxt(content: string, source: string, sourceSpeedMs?: number): ChannelEntry[] {
  const lines = content.split(/\r?\n/);
  const out: ChannelEntry[] = [];
  let currentGroup = '其他';

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const idx = line.indexOf(',');
    if (idx <= 0) continue;
    const left = line.slice(0, idx).trim();
    const right = line.slice(idx + 1).trim();

    if (right === '#genre#') {
      currentGroup = left || '其他';
      continue;
    }

    // 右侧可能包含多个 URL，用 # 分隔
    const urls = right.split('#').filter((u) => /^https?:\/\//i.test(u.trim()));
    for (const u of urls) {
      const { url, source: urlSource } = splitUrlSource(u.trim(), source);
      out.push({
        group: currentGroup,
        name: left,
        url,
        source: urlSource,
        sourceSpeedMs,
      });
    }
  }
  return out;
}

function sanitizeTxtLabel(label: string, fallback: string): string {
  const cleaned = label.replace(/[\r\n]+/g, ' ').replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned || fallback;
}

/**
 * 将 TVBox Native live groups 转为 DIYP/txt 格式：
 *   央视,#genre#
 *   CCTV-1,http://url1$源A#http://url2$源B
 */
export function formatLiveGroupsAsTxt(groups: TVBoxLiveGroup[]): string {
  const lines: string[] = [];

  for (const group of groups) {
    const groupName = sanitizeTxtLabel(group.group || '', '其他');
    lines.push(`${groupName},#genre#`);

    for (const channel of group.channels || []) {
      const urls = (channel.urls || []).filter((url) => url.trim());
      if (urls.length === 0) continue;

      const channelName = sanitizeTxtLabel(channel.name || '', '未命名');
      lines.push(`${channelName},${urls.join('#')}`);
    }
  }

  return lines.join('\n');
}

/**
 * 自动识别 m3u 还是 txt
 *
 * 不能用 content.includes('#EXTINF')：只要频道名或 URL 里偶然出现这几个字符，
 * 整份 txt 就会被误判成 m3u，解析结果为 0 个频道（真实源里确实出现过）。
 * 只认「行首」的 m3u 标记。
 */
const MAX_ENTRIES_PER_SOURCE = 30000;

export function parseLiveContent(content: string, source: string, sourceSpeedMs?: number): ChannelEntry[] {
  const head = content.replace(/^\uFEFF/, '').trimStart();

  // 内容类型闸：有些源挂的 m3u 地址实际返回 HTML 或 JSON，
  // 按 txt 解析会把页面里的链接全部当成频道（实测能炸出 43 万条垃圾条目）
  if (!head) return [];
  if (head.startsWith('<') || head.startsWith('{') || head.startsWith('[')) {
    console.warn(`[live-merger] Skip non-playlist content from ${source} (starts with "${head.slice(0, 20)}")`);
    return [];
  }

  const isM3U = head.startsWith('#EXTM3U') || /^#EXTINF/m.test(head);
  const entries = isM3U ? parseM3U(content, source, sourceSpeedMs) : parseTxt(content, source, sourceSpeedMs);

  if (entries.length > MAX_ENTRIES_PER_SOURCE) {
    console.warn(`[live-merger] ${source} has ${entries.length} entries, truncated to ${MAX_ENTRIES_PER_SOURCE}`);
    return entries.slice(0, MAX_ENTRIES_PER_SOURCE);
  }
  return entries;
}

// ─── 下载 m3u/txt ──────────────────────────────────────

/**
 * 该地址是否需要走镜像回退。
 *
 * 只对 GitHub raw 生效：正常源（guovin / hacks.tools / gitee）直连好好的，
 * 给它套一层镜像只会增加一次失败的超时等待。
 */
export function mirrorCandidates(url: string): string[] {
  if (LIVE_MIRROR_PREFIXES.length === 0) return [];
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return [];
  }
  if (!LIVE_MIRROR_HOSTS.some((h) => host === h)) return [];
  return LIVE_MIRROR_PREFIXES.map((p) => `${p}${url}`);
}

async function fetchOnce(url: string, ua: string, header: Record<string, string> | undefined, timeoutMs: number): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': ua, ...(header || {}) },
    });
    clearTimeout(timer);
    if (resp.ok) {
      const text = await resp.text();
      if (text && text.length > 20) return text;
    }
  } catch {
    clearTimeout(timer);
  }
  return null;
}

async function downloadLive(input: LiveSourceInput, timeoutMs: number): Promise<string | null> {
  const uas = [input.ua || TVBOX_UA, BROWSER_UA];
  // 直连优先：镜像本身也可能挂，能直连就没必要绕
  for (const ua of uas) {
    const text = await fetchOnce(input.url, ua, input.header, timeoutMs);
    if (text) return text;
  }
  // 直连失败再走镜像（GitHub raw 在 NAS/家宽上普遍 443 不通）
  const mirrors = mirrorCandidates(input.url);
  for (const m of mirrors) {
    for (const ua of uas) {
      const text = await fetchOnce(m, ua, input.header, timeoutMs);
      if (text) {
        console.log(`[live-merger] ${input.name || input.url} fetched via mirror ${new URL(m).host}`);
        return text;
      }
    }
  }
  return null;
}

// ─── 严格过滤：移除含 "type" 字段/字样的危险值 ────────

/**
 * TVBox 通过 `lives.contains("type")` 字符串匹配判断格式
 * 输出 Native 格式时，任何出现 `"type"` 字面量都会被误判为 FongMi 格式
 * 策略：对 group/name 中出现 "type" 字样做替换；URL 单独走 scrubUrlType
 */
function scrubTypeLiteral(s: string): string {
  return s.replace(/type/gi, 'tp');
}

/**
 * URL 中的 type 子串做 RFC 3986 URL-encode（首字符 t/T → %74/%54），
 * 保留原大小写以兼容 case-sensitive 的查询参数校验
 * 主流 HTTP 服务器会自动 URL-decode 还原为原串，功能不受影响
 * 用于 urls[] 元素，避免 TVBox lives.contains("type") 误判
 */
function scrubUrlType(url: string): string {
  return url.replace(/type/gi, (m) => {
    const hex = m.charCodeAt(0).toString(16).toUpperCase();
    return '%' + hex + m.slice(1);
  });
}

// ─── 主合并流程 ────────────────────────────────────────

export interface MergeLivesResult {
  groups: TVBoxLiveGroup[];
  totalChannels: number;
  totalUrls: number;
  sourcesDownloaded: number;
  sourcesFailed: number;
  /** 前 3 条原本同域名、被重新错开的频道数（观测用） */
  diversifiedChannels?: number;
}

export interface LiveMergeOptions {
  groupMerge?: LiveGroupMergeConfig;
  shopping?: ShoppingFilterConfig;
}

export async function mergeLivesToNative(
  sources: LiveSourceInput[],
  fetchTimeoutMs: number,
  channelSpeedMap?: ChannelSpeedMap,
  opts?: LiveMergeOptions,
): Promise<MergeLivesResult> {
  const groupMerge = opts?.groupMerge;
  const shopping = opts?.shopping;
  if (sources.length === 0) {
    return { groups: [], totalChannels: 0, totalUrls: 0, sourcesDownloaded: 0, sourcesFailed: 0 };
  }

  console.log(`[live-merger] Downloading ${sources.length} live source files...`);

  // 并发下载
  const downloadResults = await Promise.allSettled(
    sources.map((s) => downloadLive(s, fetchTimeoutMs).then((content) => ({ input: s, content }))),
  );

  let sourcesDownloaded = 0;
  let sourcesFailed = 0;
  const allEntries: ChannelEntry[] = [];

  for (const r of downloadResults) {
    if (r.status === 'fulfilled' && r.value.content) {
      sourcesDownloaded++;
      try {
        const entries = parseLiveContent(r.value.content, r.value.input.name, r.value.input.speedMs);
        for (const e of entries) {
          if (isShoppingChannel(e.name, shopping)) continue;
          allEntries.push(e);
        }
      } catch (err) {
        console.warn(`[live-merger] Parse failed for ${r.value.input.name}: ${err}`);
      }
    } else {
      sourcesFailed++;
    }
  }

  console.log(
    `[live-merger] Downloaded ${sourcesDownloaded}/${sources.length} sources, ` +
    `parsed ${allEntries.length} channel entries`,
  );

  // 按频道名（规范化）+ group 合并 urls
  // key: normalizedName → { group, rawName, logo, urls: Map<url, ChannelEntry> }
  interface AggChannel {
    group: string;              // 出现次数最多的分组（多数决），平票时取标准分组优先级更高的
    groupVotes: Map<string, number>;
    rawName: string;            // 使用第一次出现的 raw name（最常用的）
    logo?: string;
    urls: Map<string, ChannelEntry>; // url → entry（含源名、速度）
  }
  const channelMap = new Map<string, AggChannel>();

  for (const e of allEntries) {
    const normName = normalizeChannelName(e.name);
    if (!normName) continue;

    const groupName = groupMerge?.enabled
      ? normalizeGroupName(e.group || '其他', groupMerge)
      : (e.group || '其他');

    let agg = channelMap.get(normName);
    if (!agg) {
      agg = {
        group: groupName,
        groupVotes: new Map([[groupName, 1]]),
        rawName: e.name,
        logo: e.logo,
        urls: new Map(),
      };
      channelMap.set(normName, agg);
    } else {
      // 多数决：同一个台被不同源标到不同分组时，信"票数最多的那个"
      // （避免某个源把「东方卫视」错标进央视，整台就被拽到央视）
      agg.groupVotes.set(groupName, (agg.groupVotes.get(groupName) || 0) + 1);
      let best = agg.group;
      let bestVotes = agg.groupVotes.get(best) || 0;
      for (const [g, v] of agg.groupVotes) {
        if (v > bestVotes) { best = g; bestVotes = v; continue; }
        if (v === bestVotes && groupMerge?.enabled && groupPriority(g, groupMerge) < groupPriority(best, groupMerge)) {
          best = g;
        }
      }
      agg.group = best;
    }
    if (!agg.urls.has(e.url)) {
      agg.urls.set(e.url, e);
    }
    if (!agg.logo && e.logo) agg.logo = e.logo;
  }

  // 按 group 组织
  const groupMap = new Map<string, TVBoxLiveChannel[]>();
  let totalUrls = 0;
  let diversifiedChannels = 0; // 做过域名去相关（前 3 条原本同域名）的频道数

  for (const [, agg] of channelMap) {
    // 对 urls 排序：最快的排第一（这是「选优」的核心）
    const sortedUrls = Array.from(agg.urls.values()).sort((a, b) => compareBySpeed(a, b, channelSpeedMap));
    // 再做域名去相关：前 3 条不要挤在同一个域名，否则该域名一抖就连挂三次
    const urlList = diversifyByHost(sortedUrls, CHANNEL_HOST_DIVERSIFY);
    if (urlList.some((u, i) => u !== sortedUrls[i])) diversifiedChannels++;

    // 拼 $ 源名（URL 预防性 encode 避免 type 泄漏）
    const urlStrs = urlList.map((e) => joinUrlSource(scrubUrlType(e.url), scrubTypeLiteral(e.source)));
    totalUrls += urlStrs.length;

    const channel: TVBoxLiveChannel = {
      name: scrubTypeLiteral(agg.rawName),
      urls: urlStrs,
    };
    // TVBoxLiveChannel 定义只有 name/urls，logo 不加（避免意外引入 type 风险字段）

    const groupKey = scrubTypeLiteral(agg.group || '其他');
    let list = groupMap.get(groupKey);
    if (!list) {
      list = [];
      groupMap.set(groupKey, list);
    }
    list.push(channel);
  }

  // 组装 groups（启用分组归并时按标准分组顺序排列，央视/卫视在最前）
  const groups: TVBoxLiveGroup[] = [];
  for (const [group, channels] of groupMap) {
    groups.push({ group, channels });
  }
  if (groupMerge?.enabled) {
    const idx = new Map<string, number>();
    groupMerge.standard.forEach((g, i) => idx.set(g, i));
    groups.sort((a, b) => {
      const ia = idx.has(a.group) ? idx.get(a.group)! : 999;
      const ib = idx.has(b.group) ? idx.get(b.group)! : 999;
      return ia - ib;
    });
  }

  // 跨频道重复源裁决：同一路流被标成 CCTV5 和 CCTV5+ 时，按来源票数归一边，
  // 避免「CCTV5 里播的是 CCTV5+」。
  const conflicts = resolveCrossChannelConflicts(groups);
  if (conflicts.length > 0) {
    console.log(`[live-merger] Cross-channel conflicts: removed ${conflicts.length} duplicate URLs`);
    for (const c of conflicts.slice(0, 5)) {
      console.log(`[live-merger]   ${c.url} -> ${c.to} (removed from ${c.from})`);
    }
  }

  // 最终安全校验（双保险第二道）：
  //   1) 先移除 "type" 字段名（若意外进入）
  //   2) 再扫描 value 内 type 子串，统一 URL-encode 替换为 %74ype
  let finalJson = JSON.stringify(groups);
  let cleanedGroups: TVBoxLiveGroup[] = groups;

  if (/"type"\s*:/i.test(finalJson)) {
    console.warn('[live-merger] WARNING: "type" field leaked into output, stripping...');
    finalJson = finalJson
      .replace(/,\s*"type"\s*:\s*("[^"]*"|[\d.]+|null|true|false)/gi, '')
      .replace(/"type"\s*:\s*("[^"]*"|[\d.]+|null|true|false)\s*,?/gi, '');
    cleanedGroups = JSON.parse(finalJson);
  }

  // value 内 type 子串兜底：排除字段名（"xxx":）位置，其他全部 encode
  if (/type/i.test(finalJson)) {
    console.warn('[live-merger] WARNING: "type" substring in value, encoding to %74ype...');
    finalJson = finalJson.replace(/type/gi, (m) => {
      const hex = m.charCodeAt(0).toString(16).toUpperCase();
      return '%' + hex + m.slice(1);
    });
    cleanedGroups = JSON.parse(finalJson);
    return {
      groups: cleanedGroups,
      totalChannels: channelMap.size,
      totalUrls,
      sourcesDownloaded,
      sourcesFailed,
      diversifiedChannels,
    };
  }

  if (cleanedGroups !== groups) {
    return {
      groups: cleanedGroups,
      totalChannels: channelMap.size,
      totalUrls,
      sourcesDownloaded,
      sourcesFailed,
      diversifiedChannels,
    };
  }

  console.log(
    `[live-merger] Merged ${channelMap.size} channels / ${totalUrls} URLs across ${groups.length} groups`,
  );

  return {
    groups,
    totalChannels: channelMap.size,
    totalUrls,
    sourcesDownloaded,
    sourcesFailed,
    diversifiedChannels,
  };
}

/**
 * 按源分类模式：每个源独立解析，用「源名」前缀拼接 group 名，不做跨源去重
 */
export async function separatedMergeLives(
  sources: LiveSourceInput[],
  fetchTimeoutMs: number,
  channelSpeedMap?: ChannelSpeedMap,
): Promise<MergeLivesResult> {
  if (sources.length === 0) {
    return { groups: [], totalChannels: 0, totalUrls: 0, sourcesDownloaded: 0, sourcesFailed: 0 };
  }

  console.log(`[live-merger] Separated mode: downloading ${sources.length} live source files...`);

  const downloadResults = await Promise.allSettled(
    sources.map((s) => downloadLive(s, fetchTimeoutMs).then((content) => ({ input: s, content }))),
  );

  let sourcesDownloaded = 0;
  let sourcesFailed = 0;
  const allGroups: TVBoxLiveGroup[] = [];
  let totalChannels = 0;
  let totalUrls = 0;

  for (const r of downloadResults) {
    if (r.status !== 'fulfilled' || !r.value.content) {
      sourcesFailed++;
      continue;
    }
    sourcesDownloaded++;
    const { input, content } = r.value;
    const sourceName = input.name || 'source';

    try {
      const entries = parseLiveContent(content, sourceName, input.speedMs);
      if (entries.length === 0) continue;

      // 按 group 分组（源内去重）+ 频道名规范化（HD/高清/繁简 归一）
      interface Agg { rawName: string; urls: Map<string, ChannelEntry>; }
      const groupMap = new Map<string, Map<string, Agg>>();
      for (const e of entries) {
        const grp = e.group || '其他';
        if (!groupMap.has(grp)) groupMap.set(grp, new Map());
        const channels = groupMap.get(grp)!;
        const normName = normalizeChannelName(e.name) || e.name;
        let agg = channels.get(normName);
        if (!agg) {
          agg = { rawName: e.name, urls: new Map() };
          channels.set(normName, agg);
        }
        if (!agg.urls.has(e.url)) agg.urls.set(e.url, e);
      }

      // 用「源名」前缀拼接 group 名
      for (const [grp, channels] of groupMap) {
        const prefixedGroup = `「${sourceName}」${grp}`;
        const chs: TVBoxLiveChannel[] = [];
        for (const [, agg] of channels) {
          // 同一份 txt 里也要按测速排序，否则默认（按源分开）模式下测速等于白跑
          const sorted = Array.from(agg.urls.values()).sort((a, b) => compareBySpeed(a, b, channelSpeedMap));
          const list = diversifyByHost(sorted, CHANNEL_HOST_DIVERSIFY);
          const urlStrs = list.map((e) => joinUrlSource(scrubUrlType(e.url), scrubTypeLiteral(e.source)));
          chs.push({ name: scrubTypeLiteral(agg.rawName), urls: urlStrs });
          totalUrls += urlStrs.length;
        }
        totalChannels += chs.length;
        allGroups.push({ group: prefixedGroup, channels: chs });
      }
    } catch (err) {
      console.warn(`[live-merger] Separated parse failed for ${sourceName}: ${err}`);
    }
  }

  console.log(`[live-merger] Separated done: ${sourcesDownloaded}/${sources.length} sources, ${allGroups.length} groups, ${totalChannels} channels`);

  return { groups: allGroups, totalChannels, totalUrls, sourcesDownloaded, sourcesFailed };
}

/**
 * 从合并后的 groups 提取所有 (url, sourceSpeedMs) 对供 channel-probe 测速
 * URL 是 `$源名` 剥离后的裸 URL
 */
export function extractAllUrls(groups: TVBoxLiveGroup[]): string[] {
  const set = new Set<string>();
  for (const g of groups) {
    for (const ch of g.channels) {
      for (const u of ch.urls) {
        const b = bareUrl(u);
        if (b) set.add(b);
      }
    }
  }
  return Array.from(set);
}

/**
 * 轻量级实时解析：给定一组 m3u/txt URL，下载并解析为 TVBoxLiveGroup[]
 * 用于 /live-config 端点在 FongMi 格式下实时转换
 */
export async function fetchAndParseLiveUrls(
  urls: Array<{ name: string; url: string; header?: Record<string, string> }>,
  timeoutMs = 8000,
): Promise<TVBoxLiveGroup[]> {
  if (urls.length === 0) return [];

  const results = await Promise.allSettled(
    urls.map(async (input) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const resp = await fetch(input.url, {
          signal: controller.signal,
          headers: { 'User-Agent': TVBOX_UA, ...(input.header || {}) },
        });
        clearTimeout(timer);
        if (!resp.ok) return null;
        const text = await resp.text();
        if (!text || text.length < 20) return null;
        return { content: text, name: input.name };
      } catch {
        clearTimeout(timer);
        return null;
      }
    }),
  );

  const allEntries: Array<{ group: string; name: string; url: string }> = [];
  for (const r of results) {
    if (r.status !== 'fulfilled' || !r.value) continue;
    const entries = parseLiveContent(r.value.content, r.value.name);
    allEntries.push(...entries);
  }

  // 按 group + name 合并 urls
  const groupMap = new Map<string, Map<string, string[]>>();
  for (const e of allEntries) {
    const grp = e.group || '其他';
    if (!groupMap.has(grp)) groupMap.set(grp, new Map());
    const channels = groupMap.get(grp)!;
    if (!channels.has(e.name)) channels.set(e.name, []);
    const urls = channels.get(e.name)!;
    if (!urls.includes(e.url)) urls.push(e.url);
  }

  const groups: TVBoxLiveGroup[] = [];
  for (const [group, channels] of groupMap) {
    const chs: TVBoxLiveChannel[] = [];
    for (const [name, urls] of channels) {
      chs.push({ name, urls });
    }
    groups.push({ group, channels: chs });
  }
  // 分离模式同样要做跨频道裁决（源名分组不影响同一地址被标到多个台）
  resolveCrossChannelConflicts(groups);
  return groups;
}
