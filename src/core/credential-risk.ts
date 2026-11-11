// 源风险分级引擎

import type { TVBoxSite, CloudPlatform } from './types';

export type RiskLevel = 'safe' | 'low' | 'high' | 'unaudited';

export interface SourceRiskAssessment {
  siteKey: string;
  api: string;
  riskLevel: RiskLevel;
  reason: string;
  neededPlatforms: CloudPlatform[];
  thirdPartyDomains: string[];
}

// cookie 相关的 ext 字段名（各 Spider 约定）
const COOKIE_FIELD_NAMES = new Set([
  'cookie', 'cookies', 'token', 'refresh_token', 'open_token',
  'quark_cookie', 'uccookie', 'tyitoken', 'dutoken', 'p123token', 'tuctoken',
  'bili_cookie', 'ali_token',
]);

// 官方网盘域名（B类源直连这些域名视为安全）
const OFFICIAL_DOMAINS = new Set([
  'www.alipan.com', 'api.alipan.com', 'open.alipan.com', 'aliyundrive.com',
  'api.bilibili.com', 'passport.bilibili.com',
  'drive.quark.cn', 'uop.quark.cn',
  'drive-pc.quark.cn', 'pc-api.uc.cn',
  'webapi.115.com', 'proapi.115.com', 'qrcodeapi.115.com',
  'cloud.189.cn', 'api.cloud.189.cn',
  'pan.baidu.com', 'openapi.baidu.com',
  'www.123pan.com', 'open-api.123pan.com',
]);

// 平台检测：从 ext 字段名推断需要哪些网盘平台
const FIELD_TO_PLATFORM: Record<string, CloudPlatform> = {
  'cookie': 'quark',         // 默认 cookie 字段通常是夸克（最常见）
  'quark_cookie': 'quark',
  'uccookie': 'uc',
  'bili_cookie': 'bilibili',
  'ali_token': 'aliyun',
  'refresh_token': 'aliyun',
  'open_token': 'aliyun',
  'token': 'aliyun',
  'tyitoken': 'tianyi',
  'dutoken': 'baidu',
  'p123token': 'pan123',
  'tuctoken': 'thunder',
};

// 从 api class 推断需要的平台
const API_TO_PLATFORMS: Record<string, CloudPlatform[]> = {
  'csp_Bili': ['bilibili'],
  'csp_BiliR': ['bilibili'],
  'csp_Wobg': ['aliyun', 'quark', 'uc', 'pan115', 'thunder', 'pikpak'],
  'csp_Wogg': ['aliyun', 'quark', 'uc', 'pan115', 'thunder', 'pikpak'],
  'csp_Mogg': ['quark', 'aliyun', 'uc', 'tianyi', 'baidu', 'pan123', 'thunder'],
  'csp_Pan115': ['pan115'],
};

/**
 * 分析单个源的风险等级（零网络请求）
 */
export function assessSourceRisk(site: TVBoxSite): SourceRiskAssessment {
  const result: SourceRiskAssessment = {
    siteKey: site.key,
    api: site.api,
    riskLevel: 'safe',
    reason: '',
    neededPlatforms: [],
    thirdPartyDomains: [],
  };

  const ext = site.ext;
  if (!ext) {
    result.reason = 'A类: 无 ext 字段';
    return result;
  }

  // 检测 ext 中是否有 cookie/token 相关字段
  const { hasCookieFields, cookieFieldNames, thirdPartyDomains, isTokenJsonExt, proxyMode } = analyzeExt(ext, site.api);

  result.thirdPartyDomains = thirdPartyDomains;

  // 从 api class 推断需要的平台
  const apiPlatforms = API_TO_PLATFORMS[site.api];
  if (apiPlatforms) {
    result.neededPlatforms = [...apiPlatforms];
  } else {
    // 从 ext 字段名推断
    const platforms = new Set<CloudPlatform>();
    for (const field of cookieFieldNames) {
      const p = FIELD_TO_PLATFORM[field];
      if (p) platforms.add(p);
    }
    result.neededPlatforms = [...platforms];
  }

  // A类: ext 无 cookie 相关字段 → safe
  if (!hasCookieFields && !isTokenJsonExt) {
    result.reason = 'A类: ext 无 cookie 相关字段';
    return result;
  }

  // token.json 派 → 检查 proxy 字段
  if (isTokenJsonExt) {
    if (proxyMode === 'noproxy' || proxyMode === 'db') {
      result.riskLevel = 'low';
      result.reason = `D类: token.json + ${proxyMode}（不走代理）`;
    } else if (proxyMode === 'proxy') {
      result.riskLevel = 'high';
      result.reason = `D类: token.json + proxy（流量经第三方 ${thirdPartyDomains.join(', ')}）`;
    } else {
      result.riskLevel = 'unaudited';
      result.reason = `D类: token.json + proxy=${proxyMode || 'null'}（未审计）`;
    }
    return result;
  }

  // B类: ext 有 cookie 字段 + 无第三方域名 → safe
  if (hasCookieFields && thirdPartyDomains.length === 0) {
    result.riskLevel = 'safe';
    result.reason = 'B类: 有 cookie 字段，直连官方';
    return result;
  }

  // C类: ext 有 cookie + 有 site URL → low（网站 session）
  if (hasCookieFields && thirdPartyDomains.length > 0) {
    result.riskLevel = 'low';
    result.reason = `C类: 有 cookie + site URL（${thirdPartyDomains.join(', ')}）`;
    return result;
  }

  return result;
}

/**
 * 批量分析所有源
 */
export function assessAllSources(sites: TVBoxSite[]): SourceRiskAssessment[] {
  return sites.map(assessSourceRisk);
}

// ─── ext 字段解析 ────────────────────────────────────────

interface ExtAnalysis {
  hasCookieFields: boolean;
  cookieFieldNames: string[];
  thirdPartyDomains: string[];
  isTokenJsonExt: boolean;
  proxyMode: string | null;
}

function analyzeExt(
  ext: string | Record<string, unknown>,
  api: string,
  depth = 0,
): ExtAnalysis {
  const result: ExtAnalysis = {
    hasCookieFields: false,
    cookieFieldNames: [],
    thirdPartyDomains: [],
    isTokenJsonExt: false,
    proxyMode: null,
  };

  if (typeof ext === 'string') {
    return analyzeStringExt(ext, api);
  }

  // ext 是 JSON 对象：cookie 字段可能嵌在子对象里（{a:{cookie:"x"}}），
  // 只看第一层会漏判，导致本该 injection-denied 的源被判成 B 类 safe。
  const collect = (obj: Record<string, unknown>, level: number): void => {
    for (const [key, value] of Object.entries(obj)) {
      if (COOKIE_FIELD_NAMES.has(key.toLowerCase())) {
        result.hasCookieFields = true;
        result.cookieFieldNames.push(key);
      }
      if (typeof value === 'string') {
        for (const d of extractDomains(value)) {
          if (!OFFICIAL_DOMAINS.has(d)) result.thirdPartyDomains.push(d);
        }
      } else if (value && typeof value === 'object' && level < 2) {
        collect(value as Record<string, unknown>, level + 1);
      }
    }
  };
  collect(ext, depth);
  result.thirdPartyDomains = [...new Set(result.thirdPartyDomains)];

  return result;
}

function analyzeStringExt(ext: string, api: string): ExtAnalysis {
  const result: ExtAnalysis = {
    hasCookieFields: false,
    cookieFieldNames: [],
    thirdPartyDomains: [],
    isTokenJsonExt: false,
    proxyMode: null,
  };

  // 检查是否是 token.json $$$ 分隔格式
  // 格式: token.json_url$$$site_url$$$proxy$$$num$$$config
  if (ext.includes('token.json') || ext.includes('token_json')) {
    result.isTokenJsonExt = true;

    const segments = ext.split('$$$');
    // proxy 在第 3 段 (index 2)
    if (segments.length >= 3) {
      result.proxyMode = segments[2]?.trim() || null;
    }

    // site_url 在第 2 段 (index 1)
    if (segments.length >= 2) {
      const siteUrl = segments[1]?.trim();
      if (siteUrl) {
        const domains = extractDomains(siteUrl);
        result.thirdPartyDomains = domains;
      }
    }

    // token.json 派默认需要多个网盘
    result.hasCookieFields = true;
    return result;
  }

  // 尝试 JSON.parse
  try {
    const obj = JSON.parse(ext);
    if (typeof obj === 'object' && obj !== null) {
      return analyzeExt(obj, api);
    }
  } catch {
    // 非 JSON，按纯字符串处理
  }

  // 检查字符串中是否包含 cookie 相关关键词
  const lower = ext.toLowerCase();
  for (const field of COOKIE_FIELD_NAMES) {
    if (lower.includes(field)) {
      result.hasCookieFields = true;
      result.cookieFieldNames.push(field);
    }
  }

  // 提取 URL 中的域名
  const domains = extractDomains(ext);
  for (const d of domains) {
    if (!OFFICIAL_DOMAINS.has(d)) {
      result.thirdPartyDomains.push(d);
    }
  }

  return result;
}

/** 像文件扩展名的「伪 TLD」：token.json / a.m3u8 这类不该被当成域名 */
const FILE_LIKE_TLDS = new Set([
  'json', 'jsonp', 'txt', 'm3u', 'm3u8', 'html', 'htm', 'xml', 'php', 'asp', 'aspx',
  'jsp', 'ts', 'mp4', 'flv', 'mkv', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg',
  'css', 'js', 'md', 'db', 'yaml', 'yml', 'ini', 'csv', 'zip', 'apk',
]);

/**
 * 从一段文本里提取域名。
 *
 * 旧实现只认 `https?://host`，于是两类真实存在的写法被漏掉：
 *   · 协议相对地址 `//evil.com/x`
 *   · token.json 的 `$$$` 分隔格式里裸写的域名（`...$$$api.example.com$$$...`）
 * 漏掉的结果是 thirdPartyDomains 为空 → 被判成 B 类 safe，凭证注入的风险分级
 * 形同虚设（fail-open）。这里改成「抓所有像域名的 token」，再排掉文件名与内网地址。
 */
function extractDomains(text: string): string[] {
  const re = /(?:(?:https?|rtmp|rtsp):)?(?:\/\/)?((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,24})(?::\d{1,5})?/gi;
  const domains: string[] = [];
  let match;
  while ((match = re.exec(text)) !== null) {
    const host = match[1].toLowerCase();
    const tld = host.split('.').pop() || '';
    if (FILE_LIKE_TLDS.has(tld)) continue;      // token.json 之类
    if (!host.includes('.')) continue;
    if (host === 'localhost' || host.endsWith('.local')) continue;
    if (host.startsWith('127.') || host.startsWith('192.168.') || host.startsWith('10.')) continue;
    domains.push(host);
  }
  return [...new Set(domains)];
}
