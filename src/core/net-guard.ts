// 出站 URL 守卫（SSRF）
//
// 背景：/img-proxy、/reader-proxy 是公网匿名可访问的转发接口，入参就是目标 URL。
// 实测 `GET /reader-proxy?url=http://127.0.0.1:15888/version` 直接读到了内网服务 ——
// 等于把 NAS 所在内网开放给任何能访问这个端口的请求者。
//
// 这里只做「目标合法性」判断，不改转发行为：
//   · 只允许 http/https
//   · 拒绝回环 / 私网 / 链路本地 / CGNAT / 组播 / 保留段（IPv4 + IPv6）
//   · 拒绝 localhost 与常见内网后缀
//   · 重定向逐跳校验（否则 302 到 127.0.0.1 就绕过去了）
//
// 已知局限：不做 DNS 解析，所以「公网域名解析到私网 IP」这类 rebinding 挡不住。
// 需要更强保证时应把监听限制在内网，或在反代上做网络层隔离。

const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa', '.lan'];

function parseIpv4(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1).map((x) => Number(x));
  if (parts.some((p) => p > 255)) return null;
  return parts;
}

function isPrivateIpv4(parts: number[]): boolean {
  const [a, b] = parts;
  if (a === 0) return true;                                  // 0.0.0.0/8
  if (a === 10) return true;                                 // 10/8
  if (a === 127) return true;                                // 回环
  if (a === 169 && b === 254) return true;                   // 链路本地
  if (a === 172 && b >= 16 && b <= 31) return true;          // 172.16/12
  if (a === 192 && b === 168) return true;                   // 192.168/16
  if (a === 192 && b === 0) return true;                     // 192.0.0/24 + 保留
  if (a === 100 && b >= 64 && b <= 127) return true;         // CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true;      // 基准测试段
  if (a >= 224) return true;                                 // 组播 + 保留 + 广播
  return false;
}

function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) return true;

  const v4 = parseIpv4(host);
  if (v4) return isPrivateIpv4(v4);

  // IPv6：回环 / 未指定 / 链路本地 fe80::/10 / 唯一本地 fc00::/7 / IPv4 映射
  if (host.includes(':')) {
    if (host === '::1' || host === '::') return true;
    if (/^f[cd][0-9a-f]{2}:/.test(host)) return true;
    if (/^fe[89ab][0-9a-f]:/.test(host)) return true;
    const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(host);
    if (mapped) {
      const parts = parseIpv4(mapped[1]);
      if (parts && isPrivateIpv4(parts)) return true;
    }
    // 十六进制写法的映射地址（::ffff:7f00:1）一律拒绝，代价可忽略
    if (host.startsWith('::ffff:')) return true;
  }

  return false;
}

export interface UrlCheck {
  ok: boolean;
  url?: URL;
  reason?: string;
}

/** 校验一个待转发的目标地址 */
export function checkPublicUrl(raw: string | null | undefined): UrlCheck {
  if (!raw) return { ok: false, reason: 'missing url' };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'invalid url' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: `blocked scheme ${url.protocol}` };
  }
  if (isBlockedHostname(url.hostname)) {
    return { ok: false, reason: 'blocked host (private or local address)' };
  }
  return { ok: true, url };
}

const MAX_REDIRECTS = 3;

/**
 * 转发用 fetch：逐跳校验重定向目标，避免 302 到内网。
 * 与 checkPublicUrl 配合，handler 里先用它做首跳校验，再调这里。
 */
export async function fetchPublic(raw: string, init: RequestInit = {}): Promise<Response> {
  let current = raw;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const check = checkPublicUrl(current);
    if (!check.ok || !check.url) throw new Error(check.reason || 'blocked url');
    const resp = await fetch(check.url.toString(), { ...init, redirect: 'manual' });
    const location = resp.headers.get('location');
    if (resp.status >= 300 && resp.status < 400 && location) {
      current = new URL(location, check.url).toString();
      continue;
    }
    return resp;
  }
  throw new Error('too many redirects');
}
