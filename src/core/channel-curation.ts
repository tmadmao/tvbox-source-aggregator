// 重点频道编排：央视 / 卫视 / 南京地方台
//
// 为什么单独一个模块：
//   live-order 管的是「用户在后台拖动出来的顺序」，是一次性的快照；
//   这里管的是「按台本身的重要性排出来的顺序」，是每次聚合都重新算的规则。
//   两条轨道分开，新源冒出来的频道名也能自动落到该落的位置，不会永远沉底。
//
// 只对三个重点分组生效（央视 / 卫视 / 境内地方）：
//   其它分组（港澳台、体育、专题…）用户明确说不看，不值得花力气排队。
//
// 编排规则本身外置到 KV（`live_curation_rules`），后台可改、重启不丢。
// 代码里的 DEFAULT_CURATION_RULES 只是缺省值与校验兜底。

import type { Storage } from '../storage/interface';
import type { ChannelSpeedMap, ChannelSpeedEntry, TVBoxLiveChannel, TVBoxLiveGroup } from './types';
import { KV_LIVE_CHANNEL_OVERRIDES, KV_LIVE_CURATION_RULES } from './config';
import { parseCctvRank } from './live-order';
import { bareUrl, compareBySpeed } from './live-url';
import {
  arrangeSources,
  DEFAULT_TIER_QUOTA,
  TIER_ORDER,
  QUALITY_MAX_SOURCES,
  type ChannelTier,
  type TierQuotaMap,
} from './channel-tier';

// ─── 规则（可外置） ────────────────────────────────────

export interface CurationRules {
  /** 央视台序 */
  cctvOrder: string[];
  /** 卫视台序 */
  satOrder: string[];
  /** 重点地方台（南京）置顶序 */
  nanjingOrder: string[];
  /** 境内地方里省级台的地域先后 */
  provinceOrder: string[];
  /** 重点频道每台最多保留几条源 */
  focusSources: number;
  /** 各档「保底可播源数」 */
  quotas: TierQuotaMap;
  /** 删除付费频道（默认开） */
  excludePaid: boolean;
  /** 删除海外频道（默认开：整组 + 关键词） */
  excludeOverseas: boolean;
  /** 付费频道名单（一行一个，按名称精确匹配） */
  paidChannels: string[];
  /** 海外分组名（整个分组删除） */
  overseasGroups: string[];
  /** 海外关键词（名称包含即删除，如 美洲 / 欧洲 / CGTN） */
  overseasKeywords: string[];
  /** 无用画质频道关键词（默认 4K/8K：带宽高、源少，用户明确说没必要） */
  nicheKeywords: string[];
  /** 例外保留（优先级最高，如 CCTV5+） */
  keepChannels: string[];
}

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

/**
 * 南京地方台置顶顺序。
 * 用户在南京，这几个台是「打开电视就要看到」的，其余 300 多个县级台不必排队。
 */
const NANJING_ORDER = [
  '南京新闻综合', '南京十八频道', '南京教科', '南京文旅纪录', '南京少儿', '南京影视',
];

/** 境内地方里，省级台的地域先后：本地 → 邻居 → 其余 */
const PROVINCE_ORDER = [
  '江苏', '上海', '浙江', '广东', '北京', '天津', '山东', '河南', '安徽',
  '湖北', '湖南', '四川', '重庆', '福建', '江西', '河北', '山西', '陕西',
  '辽宁', '吉林', '黑龙江', '内蒙古', '广西', '云南', '贵州', '甘肃',
  '青海', '宁夏', '新疆', '西藏', '海南',
];

/**
 * 付费频道 + 4K/8K：都是实际没人看的台，还占着央视组的位置。
 * 用户 2026-11-11 明确要求删除；CCTV5+ 不在名单里（免费的体育赛事频道）。
 */
const PAID_CHANNELS = [
  '央视文体精品', '央视放映室', 'CCTV放映室', '兵器科技', '第一剧场', '电视指南',
  '发现之旅', '风云剧场', '风云音乐', '风云足球', '高尔夫网球', '怀旧剧场',
  '老故事', '女性时尚', '世界地理', '卫生健康', '文化精品', '央视高网',
  '央视台球', '中学生', 'CCTV★移动传媒', 'CCTV+', 'CCTV+1', 'CCTV+2',
  // 4K/8K 用户明确说没必要：带宽要求高、可用源少，留着只会占缺口
  'CCTV4K', 'CCTV8K', 'CCTV16-4K',
];

/** 海外分组：整组删除（含港澳台、日韩、国际新闻） */
const OVERSEAS_GROUPS = ['港澳台', '台湾', '韩国', '日本', '国际新闻', '其他海外'];

/** 海外关键词：央视海外版、CGTN、英文新闻 */
const OVERSEAS_KEYWORDS = ['CGTN', 'CCTV-NEWS', '美洲', '欧洲', '港澳版'];

/** 无用画质频道：4K/8K 一律不要（含 Love Nature 4K / 4K超清 这类） */
const NICHE_KEYWORDS = ['4K', '8K'];

/** 例外保留：唯一被点名的「可看」频道 */
const KEEP_CHANNELS = ['CCTV5+'];

export const DEFAULT_CURATION_RULES: CurationRules = {
  cctvOrder: CCTV_ORDER,
  satOrder: SAT_ORDER,
  nanjingOrder: NANJING_ORDER,
  provinceOrder: PROVINCE_ORDER,
  /**
   * 重点频道每台最多保留几条源。
   *
   * 8 → 20：用户 2026-11-11 晚要求「每个频道最大可用源数量从 8 提到 20」，
   * 目的是提高可用性 —— 电视端按顺序试源，前几条挂了还能往下走。
   * 上限常量 QUALITY_MAX_SOURCES 在 channel-tier 里，两者要一起动。
   */
  focusSources: 20,
  quotas: { ...DEFAULT_TIER_QUOTA },
  excludePaid: true,
  excludeOverseas: true,
  paidChannels: PAID_CHANNELS,
  overseasGroups: OVERSEAS_GROUPS,
  overseasKeywords: OVERSEAS_KEYWORDS,
  nicheKeywords: NICHE_KEYWORDS,
  keepChannels: KEEP_CHANNELS,
};

/**
 * 同一个台的不同写法 → 正式名。
 * 只收「确定是同一路信号」的，拿不准的宁可留在末尾让人工判断。
 * 这部分是「中文写法归一」，不随编排顺序变化，因此留在代码里。
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

const SAT_ALIAS: Record<string, string> = {
  '中国农林卫视': '农林卫视',
  '陕西农林卫视': '农林卫视',
  '福建海峡卫视': '海峡卫视',
  '福建东南卫视': '东南卫视',
  '大湾区卫视国际版': '大湾区卫视(国际版)',
  '东方卫视高清': '东方卫视',
};

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

// ─── 规则编译 ──────────────────────────────────────────

interface CompiledRules {
  rules: CurationRules;
  cctvIndex: Map<string, number>;
  satIndex: Map<string, number>;
  nanjingIndex: Map<string, number>;
  provinceIndex: Map<string, number>;
  cctvAlias: Map<string, string>;
  satAlias: Map<string, string>;
  nanjingAlias: Map<string, string>;
}

function buildIndex(list: string[]): Map<string, number> {
  const m = new Map<string, number>();
  list.forEach((n, i) => m.set(key(n), i));
  return m;
}

function compileRules(rules: CurationRules): CompiledRules {
  return {
    rules,
    cctvIndex: buildIndex(rules.cctvOrder),
    satIndex: buildIndex(rules.satOrder),
    nanjingIndex: buildIndex(rules.nanjingOrder),
    provinceIndex: buildIndex(rules.provinceOrder),
    cctvAlias: new Map(Object.entries(CCTV_ALIAS).map(([k, v]) => [key(k), v])),
    satAlias: new Map(Object.entries(SAT_ALIAS).map(([k, v]) => [key(k), v])),
    nanjingAlias: new Map(Object.entries(NANJING_ALIAS).map(([k, v]) => [key(k), v])),
  };
}

const DEFAULT_COMPILED = compileRules(cloneRules(DEFAULT_CURATION_RULES));

function cloneRules(r: CurationRules): CurationRules {
  return {
    cctvOrder: [...r.cctvOrder],
    satOrder: [...r.satOrder],
    nanjingOrder: [...r.nanjingOrder],
    provinceOrder: [...r.provinceOrder],
    focusSources: r.focusSources,
    quotas: { ...r.quotas },
    excludePaid: r.excludePaid,
    excludeOverseas: r.excludeOverseas,
    paidChannels: [...r.paidChannels],
    overseasGroups: [...r.overseasGroups],
    overseasKeywords: [...r.overseasKeywords],
    nicheKeywords: [...r.nicheKeywords],
    keepChannels: [...r.keepChannels],
  };
}

/** 把外部输入（可能缺字段、类型不对）收敛成合法规则 */
export function normalizeRules(input: unknown): CurationRules {
  const base = cloneRules(DEFAULT_CURATION_RULES);
  if (!input || typeof input !== 'object') return base;
  const o = input as Partial<CurationRules>;

  const pick = (v: unknown, fallback: string[]): string[] => {
    if (!Array.isArray(v)) return fallback;
    const list = v
      .map((x) => String(x || '').trim())
      .filter(Boolean)
      .filter((x, i, arr) => arr.indexOf(x) === i);
    return list.length > 0 ? list : fallback;
  };

  // 排除名单允许「清空」：用户可能就是想把所有台都放回来
  const pickList = (v: unknown, fallback: string[]): string[] => {
    if (!Array.isArray(v)) return [...fallback];
    return v
      .map((x) => String(x || '').trim())
      .filter(Boolean)
      .filter((x, i, arr) => arr.indexOf(x) === i);
  };

  base.cctvOrder = pick(o.cctvOrder, base.cctvOrder);
  base.satOrder = pick(o.satOrder, base.satOrder);
  base.nanjingOrder = pick(o.nanjingOrder, base.nanjingOrder);
  base.provinceOrder = pick(o.provinceOrder, base.provinceOrder);

  base.excludePaid = o.excludePaid !== false;
  base.excludeOverseas = o.excludeOverseas !== false;
  base.paidChannels = pickList(o.paidChannels, base.paidChannels);
  base.overseasGroups = pickList(o.overseasGroups, base.overseasGroups);
  base.overseasKeywords = pickList(o.overseasKeywords, base.overseasKeywords);
  base.nicheKeywords = pickList(o.nicheKeywords, base.nicheKeywords);
  base.keepChannels = pickList(o.keepChannels, base.keepChannels);

  const fs = Number(o.focusSources);
  base.focusSources = Number.isFinite(fs)
    ? Math.max(1, Math.min(QUALITY_MAX_SOURCES, Math.floor(fs)))
    : base.focusSources;

  const q = (o.quotas && typeof o.quotas === 'object' ? o.quotas : {}) as Partial<TierQuotaMap>;
  for (const t of TIER_ORDER) {
    const n = Number(q[t]);
    base.quotas[t] = Number.isFinite(n) ? Math.max(0, Math.min(QUALITY_MAX_SOURCES, Math.floor(n))) : base.quotas[t];
  }
  // 配额不能超过输出上限，否则永远不可能达标
  for (const t of TIER_ORDER) base.quotas[t] = Math.min(base.quotas[t], base.focusSources);

  return base;
}

export async function loadCurationRules(storage: Storage): Promise<CurationRules> {
  const raw = await storage.get(KV_LIVE_CURATION_RULES);
  if (!raw) return cloneRules(DEFAULT_CURATION_RULES);
  try {
    return normalizeRules(JSON.parse(raw));
  } catch {
    return cloneRules(DEFAULT_CURATION_RULES);
  }
}

export async function saveCurationRules(storage: Storage, rules: CurationRules): Promise<CurationRules> {
  const clean = normalizeRules(rules);
  await storage.put(KV_LIVE_CURATION_RULES, JSON.stringify(clean));
  return clean;
}

export async function resetCurationRules(storage: Storage): Promise<CurationRules> {
  await storage.put(KV_LIVE_CURATION_RULES, JSON.stringify(DEFAULT_CURATION_RULES));
  return cloneRules(DEFAULT_CURATION_RULES);
}

// ─── 名称识别 ──────────────────────────────────────────

/** 央视正式名（识别不出返回空串） */
function cctvName(name: string, C: CompiledRules = DEFAULT_COMPILED): string {
  const k = key(name);
  const alias = C.cctvAlias.get(k);
  if (alias) return alias;
  if (C.cctvIndex.has(k)) return C.rules.cctvOrder[C.cctvIndex.get(k)!];
  return '';
}

function satName(name: string, C: CompiledRules = DEFAULT_COMPILED): string {
  const k = key(name);
  const alias = C.satAlias.get(k);
  if (alias) return alias;
  if (C.satIndex.has(k)) return C.rules.satOrder[C.satIndex.get(k)!];
  return '';
}

function nanjingName(name: string, C: CompiledRules = DEFAULT_COMPILED): string {
  const k = key(name);
  const alias = C.nanjingAlias.get(k);
  if (alias) return alias;
  if (C.nanjingIndex.has(k)) return C.rules.nanjingOrder[C.nanjingIndex.get(k)!];
  return '';
}

/** 名称里带的省份（`江苏·南京` / `浙江新闻` / `广东珠江` 都能认） */
function provinceOf(name: string, C: CompiledRules = DEFAULT_COMPILED): string {
  const s = cleanLiveName(name);
  for (const p of C.rules.provinceOrder) {
    if (s.startsWith(p)) return p;
  }
  return '';
}

// ─── 频道分档 ──────────────────────────────────────────

export const TIER_RANK = new Map<ChannelTier, number>(TIER_ORDER.map((t, i) => [t, i]));

function tierIn(group: string, name: string, C: CompiledRules): ChannelTier {
  if (group === '央视') return 'cctv';
  if (group === '卫视') return 'satellite';
  if (group === '境内地方') {
    // 地方组里混进来的卫视/央视，按名字纠正
    if (satName(name, C)) return 'satellite';
    if (cctvName(name, C)) return 'cctv';
    return 'local';
  }
  if (cctvName(name, C)) return 'cctv';
  if (satName(name, C)) return 'satellite';
  if (nanjingName(name, C)) return 'local';
  return 'other';
}

/**
 * 频道档位：央视 > 卫视 > 地方台 > 其他。
 *
 * 优先看分组（源侧分组多数可信），再用名字兜底纠正错分组：
 * `海峡卫视` 被标进「其他」也仍按卫视对待。
 */
export function tierOfChannel(
  group: string,
  name: string,
  rules?: CurationRules,
): ChannelTier {
  const C = rules ? compileRules(normalizeRules(rules)) : DEFAULT_COMPILED;
  return tierIn(group, name, C);
}

/**
 * 编排后的正式名：`CCTV-4 AMERICA → CCTV4美洲`、`海峡卫视 → 海峡卫视`。
 * 守夜模块用它在「输出频道」和「完整源池」之间对齐同一个台。
 */
export function canonicalChannelName(name: string, rules?: CurationRules): string {
  const C = rules ? compileRules(normalizeRules(rules)) : DEFAULT_COMPILED;
  return cctvName(name, C) || satName(name, C) || nanjingName(name, C) || cleanLiveName(name);
}

/**
 * 「重点地方台」：南京六台 + 江苏各市县。
 * 用户看地方台的顺序是「自己所在市 → 本省 → 外地」，外地县级台不承诺保源。
 */
export function isPriorityLocal(name: string, rules?: CurationRules): boolean {
  const C = rules ? compileRules(normalizeRules(rules)) : DEFAULT_COMPILED;
  if (nanjingName(name, C)) return true;
  const p = provinceOf(name, C);
  return p !== '' && p === C.rules.provinceOrder[0];
}

/** 给测速队列用：URL → 最高档位（0 央视 … 3 其他） */
export function buildUrlTierMap(
  groups: TVBoxLiveGroup[],
  rules?: CurationRules,
): Map<string, ChannelTier> {
  const C = rules ? compileRules(normalizeRules(rules)) : DEFAULT_COMPILED;
  const out = new Map<string, ChannelTier>();
  for (const g of groups) {
    for (const ch of g.channels || []) {
      const tier = tierIn(g.group || '', ch.name, C);
      for (const raw of ch.urls || []) {
        const u = bareUrl(raw);
        if (!u) continue;
        const prev = out.get(u);
        if (!prev || (TIER_RANK.get(tier) ?? 9) < (TIER_RANK.get(prev) ?? 9)) out.set(u, tier);
      }
    }
  }
  return out;
}

// ─── 排名 ──────────────────────────────────────────────

/** 分组内的目标排名；-1 表示不参与编排（保持原有相对位置） */
function rankIn(group: string, name: string, C: CompiledRules): number {
  if (group === '央视') {
    const n = cctvName(name, C);
    return n ? C.cctvIndex.get(key(n))! : -1;
  }
  if (group === '卫视') {
    const n = satName(name, C);
    return n ? C.satIndex.get(key(n))! : -1;
  }
  if (group === '境内地方') {
    const nj = nanjingName(name, C);
    if (nj) return C.nanjingIndex.get(key(nj))!;           // 0..5
    const p = provinceOf(name, C);
    if (p) {
      const pi = C.provinceIndex.get(key(p));
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
 *
 * 合并完按「档位配额 + 严格质量分级」重排：
 *   · 死链不再占位置（每条就是客户端的一次 5 秒超时）
 *   · 前排 quota 条尽量来自不同域名
 *   · 只保留 focusSources 条
 */
function canonicalize(
  group: string,
  channels: TVBoxLiveChannel[],
  speedMap: ChannelSpeedMap | undefined,
  C: CompiledRules,
  requireSegment: boolean,
): TVBoxLiveChannel[] {
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
      group === '央视' ? cctvName(ch.name, C) :
        group === '卫视' ? satName(ch.name, C) :
          group === '境内地方' ? nanjingName(ch.name, C) : '';

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

  const tier = tierOfChannel(group, '', C.rules);
  return [...merged.values()].map((v) => {
    // 合并是按「行」拼接的，各行内部虽然排过序，拼起来第一行可能是全死的那一份
    // （南京十八频道实测：三条死源压在 nklive 活源前面）。所以拼完必须重排一遍。
    const sorted = speedMap
      ? [...v.urls].sort((a, b) => compareBySpeed({ url: bareUrl(a) }, { url: bareUrl(b) }, speedMap))
      : v.urls;
    const arranged = arrangeSources(sorted, speedMap, {
      quota: C.rules.quotas[tier] ?? 0,
      cap: C.rules.focusSources,
      requireSegment,
    });
    // 全死台保留原池子：它们随后会被「隐藏全死频道」移出输出，
    // 但缺口报表需要知道「有几条候选」，不能变成 0。
    return { name: v.name, urls: arranged.urls.length > 0 ? arranged.urls : v.urls };
  });
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

// ─── 排除规则（付费 / 海外） ──────────────────────────

/**
 * 是否删除这个频道。
 *
 * 优先级：例外保留 > 海外分组 > 付费名单 > 海外关键词。
 * 用户 2026-11-11 的原话是「付费台和海外台删掉，唯一可看的是 CCTV5+」，
 * 所以默认删干净，但保留名单里放 CCTV5+；名单都在后台可改。
 */
export function isExcludedChannel(group: string, name: string, rules: CurationRules): boolean {
  const k = key(name);
  // 排查看「源里的写法」和「编排后的正式名」两种：
  // 源里写 CCTV4 AMERICA / CCTV央视文体精品，要到 canonicalize 才会变成
  // CCTV4美洲 / 央视文体精品，只按原名匹配会漏掉。
  const alias = DEFAULT_COMPILED.cctvAlias.get(k)
    || DEFAULT_COMPILED.satAlias.get(k)
    || DEFAULT_COMPILED.nanjingAlias.get(k)
    || '';
  const names = [cleanLiveName(name), alias].filter(Boolean);
  const keys = names.map(key);

  if (rules.keepChannels.some((x) => keys.includes(key(x)))) return false;

  if (rules.excludeOverseas && rules.overseasGroups.some((g) => key(g) === key(group))) return true;

  if (rules.excludePaid) {
    if (rules.paidChannels.some((p) => keys.includes(key(p)))) return true;
    const upper = names.map((n) => n.toUpperCase());
    if (rules.nicheKeywords.some((kw) => kw && upper.some((s) => s.includes(kw.toUpperCase())))) return true;
  }

  if (rules.excludeOverseas) {
    const upper = names.map((n) => n.toUpperCase());
    if (rules.overseasKeywords.some((kw) => kw && upper.some((s) => s.includes(kw.toUpperCase())))) return true;
  }
  return false;
}

export interface ExclusionResult {
  groups: TVBoxLiveGroup[];
  removedChannels: number;
  removedGroups: number;
}

/**
 * 在「合并之后、测速/输出之前」把付费台和海外台整组摘掉。
 *
 * 放在合并后而不是输出前，是为了让下一轮测速不再为这些台浪费请求
 * （测速用的是上一轮落盘的频道树）。
 */
export function applyChannelExclusions(
  groups: TVBoxLiveGroup[],
  rules: CurationRules,
): ExclusionResult {
  let removedChannels = 0;
  let removedGroups = 0;
  const out: TVBoxLiveGroup[] = [];

  for (const g of groups) {
    const inOverseasGroup = rules.excludeOverseas
      && rules.overseasGroups.some((x) => key(x) === key(g.group || ''));

    if (inOverseasGroup) {
      removedGroups++;
      removedChannels += (g.channels || []).length;
      continue;
    }

    const channels: TVBoxLiveChannel[] = [];
    for (const ch of g.channels || []) {
      if (isExcludedChannel(g.group || '', ch.name, rules)) {
        removedChannels++;
        continue;
      }
      channels.push(ch);
    }

    if (channels.length > 0) out.push({ ...g, channels });
    else if ((g.channels || []).length > 0) removedGroups++;
  }

  return { groups: out, removedChannels, removedGroups };
}

// ─── 主入口 ────────────────────────────────────────────

export interface CurateResult {
  groups: TVBoxLiveGroup[];
  renamed: number;     // 被改成正式名的频道数
  mergedDupes: number; // 被合并掉的重复行
  disabled: number;
  movedOut: string[];  // 从央视挪到「其他」的伪频道（CCTV9576 这类乱命名）
  rescued: number;     // 从错误分组里捞回重点分组的频道数
  excluded: number;    // 按规则删除的付费 / 海外频道数
  excludedGroups: number;
}

/** 判断「挂着 CCTV 名头但其实不是央视」：CCTV9576 / CCTV杀人案件(韩国恐怖片) */
function looksFakeCctv(name: string, C: CompiledRules): boolean {
  if (cctvName(name, C)) return false;         // 已在编排表里，确定是央视
  if (parseCctvRank(name)) return false;       // 编号/品牌对得上，只是没进编排表 → 留在组内沉底
  return true;
}

/**
 * 归位：源侧经常把台标错分组（「海峡卫视」被标进其他、「南京教科」被标进其他）。
 * 只对「名字能确定认亲」的频道动手，认不出的原样不动。
 */
function rescueTarget(name: string, C: CompiledRules): string {
  if (nanjingName(name, C)) return '境内地方';
  if (satName(name, C)) return '卫视';
  if (cctvName(name, C)) return '央视';
  return '';
}

function sortOnly(group: string, chans: TVBoxLiveChannel[], C: CompiledRules): TVBoxLiveChannel[] {
  return chans
    .map((ch, i) => ({ ch, i, r: rankIn(group, ch.name, C) }))
    .sort((a, b) => {
      const ra = a.r < 0 ? Number.MAX_SAFE_INTEGER : a.r;
      const rb = b.r < 0 ? Number.MAX_SAFE_INTEGER : b.r;
      if (ra !== rb) return ra - rb;
      return a.i - b.i;   // 同档保持源里的原有相对次序（稳定）
    })
    .map((x) => x.ch);
}

export interface CurateOptions {
  rules?: CurationRules;
  /** 分片复验开启时，只看到清单的 m3u8 不算已验证 */
  requireSegment?: boolean;
}

export function curateGroups(
  groups: TVBoxLiveGroup[],
  overrides: OverrideMap = {},
  speedMap?: ChannelSpeedMap,
  opts: CurateOptions = {},
): CurateResult {
  const C = opts.rules ? compileRules(normalizeRules(opts.rules)) : DEFAULT_COMPILED;
  const requireSegment = opts.requireSegment !== false;

  // 付费台 / 海外台先摘掉（老 KV 树里可能还有，不能只依赖合并阶段过滤）
  const excluded = applyChannelExclusions(groups, C.rules);
  groups = excluded.groups;

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
      const target = rescueTarget(ch.name, C);
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
      chans = canonicalize(group, chans, speedMap, C, requireSegment);
      mergedDupes += Math.max(0, before - chans.length);
      if (before !== chans.length) renamed++;
      chans = sortOnly(group, chans, C);
    } else {
      chans = chans.map((ch) => ({ ...ch, name: cleanLiveName(ch.name) }));
    }

    // 央视组清创：挂着 CCTV 名头的私人转播源不该占着「央视」分组的前排
    if (group === '央视') {
      const keep: TVBoxLiveChannel[] = [];
      for (const ch of chans) {
        if (looksFakeCctv(ch.name, C)) movedOut.push(ch);
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
          return !entry || (entry as ChannelSpeedEntry).kind !== 'fail';
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

  return {
    groups: out,
    renamed,
    mergedDupes,
    disabled,
    movedOut: movedOut.map((c) => c.name),
    rescued,
    excluded: excluded.removedChannels,
    excludedGroups: excluded.removedGroups,
  };
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
 * 重点频道豁免：央视 / 卫视 / 南京地方台/ 江苏地方台的源不参与死源黑名单过滤。
 *
 * 为什么需要这一层：黑名单是「一次点击就把当时所有失败源写进去」的产物，
 * 历史上有 5 万条，一次聚合能删掉 2700 多个频道（占全量七成）。
 * 重点台源多，通常还剩几条能播；但南京这种只有 1~3 条源的地方台，
 * 一被黑名单命中就整台消失 —— 而这正是用户最不能接受的那部分。
 *
 * 豁免不等于「一定播得出来」：死链由源质量分级剔除，缺口由质量保障补测兜。
 */
export function isFocusChannel(name: string, rules?: CurationRules): boolean {
  const s = cleanLiveName(name);
  if (!s) return false;
  const C = rules ? compileRules(normalizeRules(rules)) : DEFAULT_COMPILED;
  if (nanjingName(s, C)) return true;
  if (/南京/.test(s)) return true;
  if (satName(s, C)) return true;
  if (cctvName(s, C)) return true;
  if (/^CCTV/i.test(s) || /^CGTN/i.test(s) || /^央视/.test(s)) return true;
  const p = provinceOf(s, C);
  return p !== '' && p === C.rules.provinceOrder[0];
}
