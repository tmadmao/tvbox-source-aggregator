// 后台鉴权（唯一实现）
//
// 背景：`src/routes.ts` 与 7 个 `src/routes/*.ts` 里各复制了一份同名 verifyAdmin，
// 另有一批路由干脆没调用，改用内联的 `if (config.adminToken) { ... }`。
// 三种写法语义相反 —— 未配 token 时 verifyAdmin 全拒，内联判断全放行 ——
// 于是默认部署下「输出前复核 / 直播开关 / 基址」这些写接口是敞开的。
//
// 这里收口成一份：未配 token 一律拒绝（与文档「ADMIN_TOKEN 必填」一致），
// 比较改成恒定时，并对**单个来源**的连续失败做限速（防止无限猜）。

import type { AppConfig } from './types';

/** 恒定时比较：长度不同也跑完整个循环，只暴露长度这一位信息 */
export function constantTimeEqual(a: string, b: string): boolean {
  const sa = String(a ?? '');
  const sb = String(b ?? '');
  const len = Math.max(sa.length, sb.length);
  let diff = sa.length ^ sb.length;
  for (let i = 0; i < len; i++) {
    diff |= (sa.charCodeAt(i) || 0) ^ (sb.charCodeAt(i) || 0);
  }
  return diff === 0;
}

export function isAdminConfigured(config: AppConfig): boolean {
  return !!config.adminToken;
}

// ─── 失败限速（按来源，进程内）───────────────────────────
//
// 只惩罚来源，不做全局闸门：否则攻击者只要持续打错 token 就能把管理员一起锁在门外。
const FAIL_WINDOW_MS = 60 * 1000;
const FAIL_LIMIT = 30;
const MAX_TRACKED = 512;

interface FailBucket { count: number; start: number }
const failBuckets = new Map<string, FailBucket>();

function clientTag(request: Request): string {
  return request.headers.get('cf-connecting-ip')
    || (request.headers.get('x-forwarded-for') || '').split(',')[0].trim()
    || 'local';
}

function bucketOf(tag: string, now: number): FailBucket {
  const cur = failBuckets.get(tag);
  if (!cur || now - cur.start > FAIL_WINDOW_MS) {
    const fresh: FailBucket = { count: 0, start: now };
    failBuckets.set(tag, fresh);
    // 简单上限：超了就把最早的清掉，避免被伪造来源头撑爆内存
    if (failBuckets.size > MAX_TRACKED) {
      const oldest = failBuckets.keys().next().value;
      if (oldest !== undefined) failBuckets.delete(oldest);
    }
    return fresh;
  }
  return cur;
}

/**
 * 校验管理 token。
 *
 * 未配置 ADMIN_TOKEN 时返回 false（全拒）—— 这是本项目所有 `verifyAdmin`
 * 原本就有的语义，也是 README 里「ADMIN_TOKEN 必填」的含义。
 * 需要匿名可读的对外接口（配置、live.txt、token.json）不要用它。
 */
export function verifyAdmin(request: Request, config: AppConfig): boolean {
  const token = config.adminToken;
  if (!token) return false;

  const now = Date.now();
  const tag = clientTag(request);
  const bucket = bucketOf(tag, now);
  if (bucket.count >= FAIL_LIMIT) return false;

  const auth = request.headers.get('Authorization') || '';
  if (constantTimeEqual(auth, `Bearer ${token}`)) return true;

  bucket.count++;
  console.warn(`[auth] admin token rejected (${tag}, ${bucket.count}/${FAIL_LIMIT} per minute)`);
  return false;
}
