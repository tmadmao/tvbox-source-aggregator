// 重点频道编排：央视 / 卫视 / 南京地方台
//
// 为什么单独一个模块：
//   live-order 管的是「用户在后台拖动出来的顺序」，是一次性的快照；
//   这里管的是「按台本身的重要性排出来的顺序」，是每次聚合都重新算的规则。
//   两条轨道分开，新源冒出来的频道名也能自动落到该落的位置，不会永远沉底。
//
// 只对三个重点分组生效（央视 / 卫视 / 境内地方）：
//   其它分组（港澳台、体育、专题…）用户明确说不看，不值得花力气排队。

import type { Storage } from '../storage/interface';
import type { ChannelSpeedMap, TVBoxLiveChannel, TVBoxLiveGroup } from './types';
import { KV_LIVE_CHANNEL_OVERRIDES } from './config';
import { parseCctvRank } from './live-order';
import { bareUrl } from './live-url';

/**
 * 重点频道每个台保留的源数上限。
 *
 * 重点频道不吃死源黑名单，源数会从几十条涨到两百多条（CCTV1 实测 212 条）。
 * 电视端每条失败要等 5 秒超时，两百条等于「永远在试源」，必须截断。
 * 8 条足够覆盖单域名抖动，也不会让客户端解析变慢。
 */
const MAX_FOCUS_SOURCES = 8;

// ─── 通用名称清洗 ──────────────────────────────────────

/**
 * 源侧诊断前缀：`[timeout] 南京少儿` / `[net] 江苏·南京十八` / `[失效] 南京影视`
 * 这些是别人抓取时留下的状态标记，不该出现在电视端。
 */
export function cleanLiveName(raw: string): string {
  let s = String(raw || '').trim();
  s = s.replace(/^\[[^\]]{1,10}\]\s*/, '');
  return s.replace(/\s+/g, ' ').trim();
}

/** 比较用 key：去空白、统一括号、统一间隔符、转大写 */
function key(raw: string): string {
  return cleanLiveName(raw)
    .replace(/\s+/g, '')
    .replace(/（/g, '(')
    .replace(/）/g, ')')
    .replace(/[·・•]/g, '·')
    .toUpperCase();
}

// ─── 央视 ──────────────────────────────────────────────

/**
 * 央视主频道按台号 1→17，+ 号变体紧跟本体，4K/8K 单列放在主频道之后。
 * 数字付费频道（风云系列等）永远排在最后。
 */
const CCTV_ORDER = [
  'CCTV1', 'CCTV2', 'CCTV3', 'CCTV4', 'CCTV4美洲', 'CCTV4欧洲',
  'CCTV5', 'CCTV5+', 'CCTV6', 'CCTV7', 'CCTV8', 'CCTV9',
  'CCTV10', 'CCTV11', 'CCTV12', 'CCTV13', 'CCTV14', 'CCTV15',
  'CCTV16', 'CCTV16-4K', 'CCTV17',
  'CCTV4K', 'CCTV8K',
  'CCTV+', 'CCTV+1', 'CCTV+2', 'CCTV-NEWS', 'CCTV★移动传媒',
  'CGTN', 'CGTN纪录', 'CGTN法语', 'CGTN西班牙语', 'CGTN阿拉伯语', 'CGTN俄语',
  'CGTN Radio', 'CGTN Global Biz',
  '央视文体精品', '兵器科技', '第一剧场', '电视指南', '发现之旅',
  '风云剧场', '风云音乐', '风云足球', '高尔夫网球', '怀旧剧场',
  '老故事', '女性时尚', '世界地理', '卫生健康', '文化精品',
  '央视高网', '央视台球', '中学生',
];

/**
 * 同一个台的不同写法 → 正式名。
 * 只收「确定是同一路信号」的，拿不准的宁可留在末尾让人工判断。
 */
const CCTV_ALIAS: Record<string, string> = {
  'CCTV-5+体育': 'CCTV5+',
  'CCTV5+体育': 'CCTV5+',
  'CCTV5+体育赛事': 'CCTV5+',
  'CCTV5＋': 'CCTV5+',
  'CCTV-4 AMERICA': 'CCTV4美洲',
  'CCTV4AMERICA': 'CCTV4美洲',
  'CCTV4美洲版': 'CCTV4美洲',
  'CCTV4欧洲版': 'CCTV4欧洲',
  'CCTV央视文体精品': '央视文体精品',
  'CCTV放映室': '央视放映室',
  'CGTN西语': 'CGTN西班牙语',
  'CGTN阿语': 'CGTN阿拉伯语',
};

// ─── 卫视 ──────────────────────────────────────────────

/**
 * 卫视顺序：本地台（江苏）打头，其余按「常看程度 + 地域」排，
 * 少数民族/专业卫视（延边、康巴、安多、兵团、农林）沉到最后。
 */
const SAT_ORDER = [
  '江苏卫视', '湖南卫视', '浙江卫视', '东方卫视', '北京卫视',
  '安徽卫视', '山东卫视', '广东卫视', '深圳卫视', '湖北卫视',
  '四川卫视', '天津卫视', '重庆卫视', '河南卫视', '河北卫视',
  '江西卫视', '东南卫视', '黑龙江卫视', '辽宁卫视', '吉林卫视',
  '山西卫视', '陕西卫视', '云南卫视', '贵州卫视', '广西卫视',
  '甘肃卫视', '青海卫视', '宁夏卫视', '新疆卫视', '内蒙古卫视',
  '内蒙古蒙语卫视', '西藏卫视', '海南卫视',
  '大湾区卫视', '大湾区卫视(国际版)', '南方卫视', '厦门卫视', '海峡卫视',
  '三沙卫视', '延边卫视', '康巴卫视', '安多卫视', '兵团卫视',
  '山东教育卫视', '农林卫视',
];

const SAT_ALIAS: Record<string, string> = {
  '中国农林卫视': '农林卫视',
  '陕西农林卫视': '农林卫视',
  '福建海峡卫视': '海峡卫视',
  '福建东南卫视': '东南卫视',
  '大湾区卫视国际版': '大湾区卫视(国际版)',
  '东方卫视高清': '东方卫视',
};

// ─── 境内地方 ──────────────────────────────────────────

/**
 * 南京地方台置顶顺序。
 * 用户在南京，这几个台是「打开电视就要看到」的，其余 300 多个县级台不必排队。
 */
const NANJING_ORDER = [
  '南京新闻综合', '南京十八频道', '南京教科', '南京文旅纪录', '南京少儿', '南京影视',
];

const NANJING_ALIAS: Record<string, string> = {
  '江苏·南京新闻': '南京新闻综合',
  '江苏·南京新闻综合': '南京新闻综合',
  '南京新闻': '南京新闻综合',
  '南京新闻综合频道': '南京新闻综合',
  '江苏南京新闻综合': '南京新闻综合',
  '江苏·南京十八': '南京十八频道',
  '江苏·南京十八生活': '南京十八频道',
  '南京十八': '南京十八频道',
  '十八频道': '南京十八频道',
  '南京十八生活': '南京十八频道',
  '江苏·南京教科': '南京教科',
  '南京教科频道': '南京教科',
  '江苏·南京文旅纪录': '南京文旅纪录',
  '南京文旅': '南京文旅纪录',
  '南京纪实': '南京文旅纪录',
};

/** 境内地方里，省级台的地域先后：本地 → 邻居 → 其余 */
const PROVINCE_ORDER = [
  '江苏', '上海', '浙江', '广东', '北京', '天津', '山东', '河南', '安徽',
  '湖北', '湖南', '四川', '重庆', '福建', '江西', '河北', '山西', '陕西',
  '辽宁', '吉林', '黑龙江', '内蒙古', '广西', '云南', '贵州', '甘肃',
  '青海', '宁夏', '新疆', '西藏', '海南',
];

// ─── 排名 ──────────────────────────────────────────────

function buildIndex(list: string[]): Map<string, number> {
  const m = new Map<string, number>();
  list.forEach((n, i) => m.set(key(n), i));
  return m;
}

const CCTV_INDEX = buildIndex(CCTV_ORDER);
const SAT_INDEX = buildIndex(SAT_ORDER);
const NANJING_INDEX = buildIndex(NANJING_ORDER);
const PROVINCE_INDEX = buildIndex(PROVINCE_ORDER);

const CCTV_ALIAS_KEY = new Map(Object.entries(CCTV_ALIAS).map(([k, v]) => [key(k), v]));
const SAT_ALIAS_KEY = new Map(Object.entries(SAT_ALIAS).map(([k, v]) => [key(k), v]));
const NANJING_ALIAS_KEY = new Map(Object.entries(NANJING_ALIAS).map(([k, v]) => [key(k), v]));

/** 央视正式名（识别不出返回空串） */
function cctvName(name: string): string {
  const k = key(name);
  const alias = CCTV_ALIAS_KEY.get(k);
  if (alias) return alias;
  if (CCTV_INDEX.has(k)) return CCTV_ORDER[CCTV_INDEX.get(k)!];
  return '';
}

function satName(name: string): string {
  const k = key(name);
  const alias = SAT_ALIAS_KEY.get(k);
  if (alias) return alias;
  if (SAT_INDEX.has(k)) return SAT_ORDER[SAT_INDEX.get(k)!];
  return '';
}

function nanjingName(name: string): string {
  const k = key(name);
  const alias = NANJING_ALIAS_KEY.get(k);
  if (alias) return alias;
  if (NANJING_INDEX.has(k)) return NANJING_ORDER[NANJING_INDEX.get(k)!];
  return '';
}

/** 名称里带的省份（`江苏·南京` / `浙江新闻` / `广东珠江` 都能认） */
function provinceOf(name: string): string {
  const s = cleanLiveName(name);
  for (const p of PROVINCE_ORDER) {
    if (s.startsWith(p)) return p;
  }
  return '';
}

/** 分组内的目标排名；-1 表示不参与编排（保持原有相对位置） */
function rankIn(group: string, name: string): number {
  if (group === '央视') {
    const n = cctvName(name);
    return n ? CCTV_INDEX.get(key(n))! : -1;
  }
  if (group === '卫视') {
    const n = satName(name);
    return n ? SAT_INDEX.get(key(n))! : -1;
  }
  if (group === '境内地方') {
    const nj = nanjingName(name);
    if (nj) return NANJING_INDEX.get(key(nj))!;           // 0..5
    const p = provinceOf(name);
    if (p) {
      const pi = PROVINCE_INDEX.get(key(p));
      return 100 + (pi == null ? 90 : pi * 2);             // 100 起，按省份先后
    }
    return -1;
  }
  return -1;
}

// ─── 规范化 + 合并同名 ─────────────────────────────────

/**
 * 重点分组内：先把「同一个台的多种写法」改成正式名，
 * 再把改名后撞车的频道合并（URL 去重后接在一起）。
 * 不做这一步的话，央视会同时冒出来 CCTV-4 America / CCTV4美洲 / CCTV4欧洲 三行。
 */
function canonicalize(group: string, channels: TVBoxLiveChannel[]): TVBoxLiveChannel[] {
  const merged = new Map<string, { name: string; urls: string[] }>();

  // 同一个 URL 被多个源收录时只留一条（`$源名` 不同但地址相同）
  const dedupe = (list: string[]): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const u of list) {
      const b = bareUrl(u);
      if (!b || seen.has(b)) continue;
      seen.add(b);
      out.push(u);
    }
    return out;
  };

  for (const ch of channels) {
    const canonical =
      group === '央视' ? cctvName(ch.name) :
        group === '卫视' ? satName(ch.name) :
          group === '境内地方' ? nanjingName(ch.name) : '';

    const display = canonical || cleanLiveName(ch.name);
    const dedupeKey = key(display);
    const urls = dedupe(ch.urls || []);
    const hit = merged.get(dedupeKey);
    if (!hit) {
      merged.set(dedupeKey, { name: display, urls });
      continue;
    }
    const seen = new Set(hit.urls.map(bareUrl));
    for (const u of urls) {
      const b = bareUrl(u);
      if (!b || seen.has(b)) continue;
      seen.add(b);
      hit.urls.push(u);
    }
  }

  // 合并完再统一封顶：重点频道不吃黑名单，源会堆到两百多条，
  // 电视端每条失败要等 5 秒超时，必须截断。
  return [...merged.values()].map((v) => ({
    name: v.name,
    urls: v.urls.slice(0, MAX_FOCUS_SOURCES),
  }));
}

// ─── 置顶 / 禁用（overrides） ──────────────────────────

export interface ChannelOverride {
  pinned?: boolean;
  disabled?: boolean;
}

export type OverrideMap = Record<string, ChannelOverride>;

export async function loadOverrides(storage: Storage): Promise<OverrideMap> {
  const raw = await storage.get(KV_LIVE_CHANNEL_OVERRIDES);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed as OverrideMap : {};
  } catch {
    return {};
  }
}

export async function saveOverrides(storage: Storage, map: OverrideMap): Promise<void> {
  await storage.put(KV_LIVE_CHANNEL_OVERRIDES, JSON.stringify(map || {}));
}

// ─── 主入口 ────────────────────────────────────────────

export interface CurateResult {
  groups: TVBoxLiveGroup[];
  renamed: number;     // 被改成正式名的频道数
  mergedDupes: number; // 被合并掉的重复行
  disabled: number;
  movedOut: string[];  // 从央视挪到「其他」的伪频道（CCTV9576 这类乱命名）
  rescued: number;     // 从错误分组里捞回重点分组的频道数
}

/** 判断「挂着 CCTV 名头但其实不是央视」：CCTV9576 / CCTV杀人案件(韩国恐怖片) */
function looksFakeCctv(name: string): boolean {
  if (cctvName(name)) return false;         // 已在编排表里，确定是央视
  if (parseCctvRank(name)) return false;    // 编号/品牌对得上，只是没进编排表 → 留在组内沉底
  return true;
}

/**
 * 归位：源侧经常把台标错分组（「海峡卫视」被标进其他、「南京教科」被标进其他）。
 * 只对「名字能确定认亲」的频道动手，认不出的原样不动。
 */
function rescueTarget(name: string): string {
  if (nanjingName(name)) return '境内地方';
  if (satName(name)) return '卫视';
  if (cctvName(name)) return '央视';
  return '';
}

function sortOnly(group: string, chans: TVBoxLiveChannel[]): TVBoxLiveChannel[] {
  return chans
    .map((ch, i) => ({ ch, i, r: rankIn(group, ch.name) }))
    .sort((a, b) => {
      const ra = a.r < 0 ? Number.MAX_SAFE_INTEGER : a.r;
      const rb = b.r < 0 ? Number.MAX_SAFE_INTEGER : b.r;
      if (ra !== rb) return ra - rb;
      return a.i - b.i;   // 同档保持源里的原有相对次序（稳定）
    })
    .map((x) => x.ch);
}

export function curateGroups(
  groups: TVBoxLiveGroup[],
  overrides: OverrideMap = {},
  speedMap?: ChannelSpeedMap,
): CurateResult {
  let renamed = 0;
  let mergedDupes = 0;
  let disabled = 0;
  let rescued = 0;
  const movedOut: TVBoxLiveChannel[] = [];

  // 1) 先按名字归位（必须在排序前，否则捞回来的频道会掉到组尾）
  const buckets = new Map<string, TVBoxLiveChannel[]>();
  const order: string[] = [];
  for (const g of groups) {
    buckets.set(g.group, [...(g.channels || [])]);
    order.push(g.group);
  }
  for (const g of groups) {
    const keep: TVBoxLiveChannel[] = [];
    for (const ch of buckets.get(g.group) || []) {
      const target = rescueTarget(ch.name);
      if (target && target !== g.group) {
        if (!buckets.has(target)) { buckets.set(target, []); order.push(target); }
        buckets.get(target)!.push(ch);
        rescued++;
      } else {
        keep.push(ch);
      }
    }
    buckets.set(g.group, keep);
  }

  // 2) 重点分组：改正式名 → 合并同名 → 排序；其它分组只做名称清洗
  const out: TVBoxLiveGroup[] = [];
  for (const group of order) {
    let chans = buckets.get(group) || [];
    if (chans.length === 0) continue;

    if (group === '央视' || group === '卫视' || group === '境内地方') {
      const before = chans.length;
      chans = canonicalize(group, chans);
      mergedDupes += Math.max(0, before - chans.length);
      if (before !== chans.length) renamed++;
      chans = sortOnly(group, chans);
    } else {
      chans = chans.map((ch) => ({ ...ch, name: cleanLiveName(ch.name) }));
    }

    // 央视组清创：挂着 CCTV 名头的私人转播源不该占着「央视」分组的前排
    if (group === '央视') {
      const keep: TVBoxLiveChannel[] = [];
      for (const ch of chans) {
        if (looksFakeCctv(ch.name)) movedOut.push(ch);
        else keep.push(ch);
      }
      chans = keep;
    }

    // 3) 置顶 / 禁用（所有分组都支持）
    const pinned: TVBoxLiveChannel[] = [];
    const rest: TVBoxLiveChannel[] = [];
    for (const ch of chans) {
      const ov = overrides[key(ch.name)];
      if (ov?.disabled) { disabled++; continue; }
      if (ov?.pinned) pinned.push(ch);
      else rest.push(ch);
    }
    chans = [...pinned, ...rest];

    // 全死的台沉到组尾：编排管的是「打开电视先看到哪个台」，
    // 一个源都放不出来的台占着第 6 位只会让人以为整套源坏了。
    // 不删除：源修好后下一轮它会自动回到编排位置；人工置顶的照旧留在最前。
    if (speedMap && (group === '央视' || group === '卫视' || group === '境内地方')) {
      const head = chans.slice(0, pinned.length);
      const alive: TVBoxLiveChannel[] = [];
      const dead: TVBoxLiveChannel[] = [];
      for (const ch of chans.slice(pinned.length)) {
        const playable = (ch.urls || []).some((u) => {
          const entry = speedMap[bareUrl(u)];
          return !entry || entry.kind !== 'fail';
        });
        (playable ? alive : dead).push(ch);
      }
      if (dead.length > 0) chans = [...head, ...alive, ...dead];
    }

    if (chans.length > 0) out.push({ group, channels: chans });
  }

  // 伪央视统一并入「其他」组的末尾（不删，留个痕迹，源修好改名后还会回来）
  if (movedOut.length > 0) {
    const alive = movedOut.filter((ch) => {
      const ov = overrides[key(ch.name)];
      if (ov?.disabled) { disabled++; return false; }
      return true;
    });
    if (alive.length > 0) {
      const fallback = out.find((g) => g.group === '其他');
      if (fallback) fallback.channels = [...fallback.channels, ...alive];
      else out.push({ group: '其他', channels: alive });
    }
  }

  return { groups: out, renamed, mergedDupes, disabled, movedOut: movedOut.map((c) => c.name), rescued };
}

/** 频道当前是否被置顶/禁用（后台展示用） */
export function overrideOf(map: OverrideMap, name: string): ChannelOverride | undefined {
  return map[key(name)];
}

/** 写入一条 override；pinned/disabled 都为 false 时删除该条 */
export function setOverride(map: OverrideMap, name: string, patch: ChannelOverride): OverrideMap {
  const k = key(name);
  const next: OverrideMap = { ...map };
  const cur = next[k] || {};
  const merged: ChannelOverride = { ...cur, ...patch };
  if (!merged.pinned && !merged.disabled) delete next[k];
  else next[k] = merged;
  return next;
}

// ─── 源保护 ────────────────────────────────────────────

/**
 * 永不进死源黑名单的域名。
 *
 * nklive.nbs.cn 是南京广电的官方直播口（实测清单 25ms、分片 64KB/0.11s），
 * 但测速偶尔会把它判成失败；一旦进黑名单，整个南京地方台就从输出里消失了 ——
 * 比「少一个台」严重得多。所以这里按域名兜底保护，清理死源时会自动跳过并回捞。
 */
export const PROTECTED_HOSTS = ['nklive.nbs.cn'];

export function protectedHostOf(url: string): string {
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
  return PROTECTED_HOSTS.find((h) => host === h || host.endsWith(`.${h}`)) || '';
}

export function isProtectedUrl(url: string): boolean {
  return protectedHostOf(url) !== '';
}

/**
 * 重点频道豁免：央视 / 卫视 / 南京地方台的源不参与死源黑名单过滤。
 *
 * 为什么需要这一层：黑名单是「一次点击就把当时所有失败源写进去」的产物，
 * 历史上有 5 万条，一次聚合能删掉 2700 多个频道（占全量七成）。
 * 重点台源多，通常还剩几条能播；但南京这种只有 1~3 条源的地方台，
 * 一被黑名单命中就整台消失 —— 而这正是用户最不能接受的那部分。
 *
 * 豁免不等于「一定播得出来」：死链仍会被排序到末尾，由 topN 与首位复核兜住。
 */
export function isFocusChannel(name: string): boolean {
  const s = cleanLiveName(name);
  if (!s) return false;
  if (/南京/.test(s)) return true;
  if (satName(s)) return true;
  if (/^CCTV/i.test(s) || /^CGTN/i.test(s) || /^央视/.test(s)) return true;
  return false;
}
