// 调度告警
//
// 「失败能主动提醒」不能只靠人打开后台看。这里支持两种最常用的低成本通道：
//   · 通用 Webhook：POST 一段 JSON（可对接企业微信机器人、飞书机器人、自建服务）
//   · Telegram Bot：sendMessage
// 没配通道时只做「后台标红」，不静默失败。
//
// 告警本身绝不能拖垮聚合：所有发送都吞异常 + 8 秒超时，并做去重（同一类 6 小时内只发一次）。

import type { Storage } from '../storage/interface';
import { KV_ALERT_CONFIG, KV_ALERT_LAST, RUN_STALE_MS } from './config';
import type { RunRecord, RunSummary } from './run-history';

export interface AlertConfig {
  enabled: boolean;
  webhookUrl: string;
  telegramToken: string;
  telegramChatId: string;
  /** 成功也报（默认关，只在失败/漏跑时提醒） */
  onSuccess: boolean;
}

export const DEFAULT_ALERT_CONFIG: AlertConfig = {
  enabled: false,
  webhookUrl: '',
  telegramToken: '',
  telegramChatId: '',
  onSuccess: false,
};

export function normalizeAlertConfig(input: unknown): AlertConfig {
  if (!input || typeof input !== 'object') return { ...DEFAULT_ALERT_CONFIG };
  const o = input as Partial<AlertConfig>;
  return {
    enabled: !!o.enabled,
    webhookUrl: String(o.webhookUrl || '').trim(),
    telegramToken: String(o.telegramToken || '').trim(),
    telegramChatId: String(o.telegramChatId || '').trim(),
    onSuccess: !!o.onSuccess,
  };
}

export async function loadAlertConfig(storage: Storage): Promise<AlertConfig> {
  const raw = await storage.get(KV_ALERT_CONFIG);
  if (!raw) return { ...DEFAULT_ALERT_CONFIG };
  try {
    return normalizeAlertConfig(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_ALERT_CONFIG };
  }
}

export async function saveAlertConfig(storage: Storage, cfg: AlertConfig): Promise<AlertConfig> {
  const clean = normalizeAlertConfig(cfg);
  await storage.put(KV_ALERT_CONFIG, JSON.stringify(clean));
  return clean;
}

export interface AlertPayload {
  /** 去重键：同一键 6 小时内只发一次 */
  key: string;
  level: 'warn' | 'error' | 'info';
  title: string;
  text: string;
}

const DEDUPE_MS = 6 * 3600 * 1000;

async function shouldSkip(storage: Storage, key: string, now = Date.now()): Promise<boolean> {
  const raw = await storage.get(KV_ALERT_LAST);
  if (!raw) return false;
  try {
    const map = JSON.parse(raw) as Record<string, number>;
    const last = Number(map[key]) || 0;
    return last > 0 && now - last < DEDUPE_MS;
  } catch {
    return false;
  }
}

async function markSent(storage: Storage, key: string, now = Date.now()): Promise<void> {
  let map: Record<string, number> = {};
  try {
    const raw = await storage.get(KV_ALERT_LAST);
    if (raw) map = JSON.parse(raw) as Record<string, number>;
  } catch { /* ignore */ }
  map[key] = now;
  // 只留最近 7 天，避免无限增长
  for (const [k, t] of Object.entries(map)) {
    if (now - (Number(t) || 0) > 7 * 24 * 3600 * 1000) delete map[k];
  }
  await storage.put(KV_ALERT_LAST, JSON.stringify(map));
}

async function postJson(url: string, body: unknown): Promise<{ ok: boolean; detail: string }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    return { ok: resp.ok, detail: `HTTP ${resp.status}` };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, detail: msg };
  } finally {
    clearTimeout(timer);
  }
}

export interface AlertDelivery {
  sent: boolean;
  skipped?: string;
  webhook?: string;
  telegram?: string;
}

/** 真正发送：先看开关与通道，再做去重 */
export async function sendAlert(
  storage: Storage,
  cfg: AlertConfig,
  payload: AlertPayload,
  opts: { ignoreDedupe?: boolean } = {},
): Promise<AlertDelivery> {
  if (!cfg.enabled) return { sent: false, skipped: 'disabled' };
  const hasWebhook = !!cfg.webhookUrl;
  const hasTelegram = !!cfg.telegramToken && !!cfg.telegramChatId;
  if (!hasWebhook && !hasTelegram) return { sent: false, skipped: 'no-channel' };
  if (!opts.ignoreDedupe && await shouldSkip(storage, payload.key)) {
    return { sent: false, skipped: 'deduped' };
  }

  const text = `${payload.title}\n${payload.text}`;
  const out: AlertDelivery = { sent: false };

  if (hasWebhook) {
    const body = {
      source: 'tvbox-aggregator',
      level: payload.level,
      title: payload.title,
      text: payload.text,
      at: new Date().toISOString(),
    };
    const r = await postJson(cfg.webhookUrl, body);
    out.webhook = r.detail;
    out.sent = out.sent || r.ok;
  }

  if (hasTelegram) {
    const r = await postJson(
      `https://api.telegram.org/bot${cfg.telegramToken}/sendMessage`,
      { chat_id: cfg.telegramChatId, text, disable_web_page_preview: true },
    );
    out.telegram = r.detail;
    out.sent = out.sent || r.ok;
  }

  if (out.sent) await markSent(storage, payload.key);
  return out;
}

function fmtDuration(ms?: number): string {
  if (!ms || ms < 0) return '-';
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`;
}

/** 一次聚合结束后调用：失败/超时必报，成功按开关 */
export async function notifyRunFinished(
  storage: Storage,
  cfg: AlertConfig,
  run: RunRecord,
  summary: RunSummary,
): Promise<AlertDelivery> {
  const failed = run.status === 'failed' || run.status === 'timeout';
  if (!failed && !(run.status === 'success' && cfg.onSuccess)) {
    return { sent: false, skipped: 'not-needed' };
  }
  const title = failed
    ? `【IPTV】聚合${run.status === 'timeout' ? '超时' : '失败'}（${run.kind}）`
    : `【IPTV】聚合完成（${run.kind}）`;
  const lines = [
    `状态：${run.status}`,
    `触发：${run.trigger}`,
    `开始：${run.startedAt}`,
    `耗时：${fmtDuration(run.durationMs)}`,
  ];
  if (run.error) lines.push(`原因：${run.error}`);
  if (summary.consecutiveFailures > 1) lines.push(`连续失败：${summary.consecutiveFailures} 次`);
  if (summary.lastSuccess) lines.push(`上次成功：${summary.lastSuccess.startedAt}`);
  if (summary.stale) lines.push(`⚠️ 已超过 ${staleHours()} 小时没有成功聚合`);
  return sendAlert(storage, cfg, {
    key: `run:${run.kind}:${run.status}`,
    level: failed ? 'error' : 'info',
    title,
    text: lines.join('\n'),
  });
}

/** 判据小时数：文案与常量同源，改 RUN_STALE_MS 不用再改文案 */
function staleHours(): number {
  return Math.round(RUN_STALE_MS / 3600000);
}

/** 漏跑检查：每 6 小时一次 + 启动后一次（见 node-entry） */
export async function notifyMissedRun(
  storage: Storage,
  cfg: AlertConfig,
  summary: RunSummary,
): Promise<AlertDelivery> {
  if (!summary.stale) return { sent: false, skipped: 'fresh' };
  const lines = [
    `状态：超过 ${staleHours()} 小时没有成功聚合（判据 RUN_STALE_MS）`,
    summary.lastSuccess ? `上次成功：${summary.lastSuccess.startedAt}` : '上次成功：无记录',
    summary.lastFailure ? `最近失败：${summary.lastFailure.startedAt} ${summary.lastFailure.error || ''}` : '',
    '请检查定时任务、容器状态与源站可达性。',
  ].filter(Boolean);
  return sendAlert(storage, cfg, {
    key: 'missed-run',
    level: 'error',
    title: '【IPTV】定时聚合可能没跑',
    text: lines.join('\n'),
  });
}

