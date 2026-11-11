// Node.js 入口

import { serve } from '@hono/node-server';
import * as cron from 'node-cron';
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as dns from 'dns';
import { createApp } from './routes';
import { runAggregation } from './aggregator';
import { runChannelProbe, isProbeEnabled } from './core/channel-probe';
// P0-1：不要在这里 import SQLiteStorage（哪怕 import type 也只为类型服务）。
// SQLite 是「可选能力」，真实 require 只发生在 createStorage() 的 try 里；
// 顶层 import 会让 esbuild 把 init_sqlite() 提到 main() 之前执行，
// better-sqlite3 缺失时进程在加载期就退出，JSON 降级链永远没机会跑。
import {
  DEFAULT_SPEED_TIMEOUT_MS,
  DEFAULT_SITE_TIMEOUT_MS,
  DEFAULT_FETCH_TIMEOUT_MS,
  KV_CRON_INTERVAL,
  DEFAULT_CRON_INTERVAL,
  CHANNEL_PROBE_CRON,
  KV_CHANNEL_PROBE_INLINE,
  MISSED_RUN_CHECK_CRON,
  KV_MERGED_CONFIG,
  KV_LIVE_GUARD_ENABLED,
  LIVE_GUARD_CRON,
  RUN_STALE_MS,
} from './core/config';
import type { Storage } from './storage/interface';
import type { AppConfig } from './core/types';
import { beginRun, finishRun, loadRunHistory, summarizeRuns, type RunStatus, type RunTrigger } from './core/run-history';
import { loadAlertConfig, notifyRunFinished, notifyMissedRun } from './core/alerts';
import { APP_VERSION, APP_COMMIT } from './core/version';
import { runQualityGuard } from './core/quality-guard';
import { withProbeNet } from './core/probe-net';

// 加载 .env（嵌入式/无文件系统环境下容错：nodejs-mobile 无 .env，依赖注入的环境变量）
try {
  dotenv.config();
} catch {
  // 忽略：无 .env 或文件系统受限时，回退到已注入的 process.env
}

// ─── 存储初始化（SQLite → JSON 降级）───────────────────

function createStorage(): Storage {
  const dataDir = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'));

  // 尝试 SQLite
  try {
    const { SQLiteStorage } = require('./storage/sqlite');
    const dbPath = path.join(dataDir, 'tvbox.db');
    const storage = new SQLiteStorage(dbPath);
    console.log(`[storage] SQLite initialized: ${dbPath}`);
    return storage;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[storage] SQLite unavailable (${msg}), falling back to JSON file`);
  }

  // 降级到 JSON
  const { JsonFileStorage } = require('./storage/json-file');
  const jsonPath = path.join(dataDir, 'tvbox-data.json');
  console.log(`[storage] JSON file storage: ${jsonPath}`);
  return new JsonFileStorage(jsonPath);
}

// ─── 配置 ────────────────────────────────────────────────

async function buildConfig(port: number): Promise<AppConfig> {
  const docker = isDocker();
  let lanIp = getLocalIp();
  let dockerMissingBaseUrl = false;

  if (docker && !process.env.BASE_URL) {
    try {
      const result = await dns.promises.lookup('host.docker.internal');
      lanIp = result.address;
    } catch {
      // host.docker.internal 不可用（Linux Docker 非 Desktop），保留容器 IP 但标记警告
      dockerMissingBaseUrl = true;
    }
  }

  const baseUrl = process.env.BASE_URL || `http://${lanIp || 'localhost'}:${port}`;
  return {
    adminToken: process.env.ADMIN_TOKEN,
    refreshToken: process.env.REFRESH_TOKEN,
    speedTimeoutMs: parseInt(process.env.SPEED_TIMEOUT_MS || '') || DEFAULT_SPEED_TIMEOUT_MS,
    siteTimeoutMs: parseInt(process.env.SITE_TIMEOUT_MS || '') || DEFAULT_SITE_TIMEOUT_MS,
    fetchTimeoutMs: parseInt(process.env.FETCH_TIMEOUT_MS || '') || DEFAULT_FETCH_TIMEOUT_MS,
    cronSchedule: process.env.CRON_SCHEDULE || '0 5 * * *',
    localBaseUrl: baseUrl.replace(/\/$/, ''),
    dockerMissingBaseUrl,
    // 自动抓取（环境变量驱动）
    scrapeSourceUrl: process.env.SCRAPE_SOURCE_URL,
    scrapeSourceReferer: process.env.SCRAPE_SOURCE_REFERER,
    maccmsApiUrl: process.env.MACCMS_API_URL,
    maccmsAesKey: process.env.MACCMS_AES_KEY,
    maccmsAesIv: process.env.MACCMS_AES_IV,
  };
}

// ─── 启动 ────────────────────────────────────────────────

/** 将间隔分钟数转换为 cron 表达式 */
function intervalToCron(minutes: number): string {
  switch (minutes) {
    case 60:   return '0 */1 * * *';
    case 180:  return '0 */3 * * *';
    case 360:  return '0 */6 * * *';
    case 720:  return '0 */12 * * *';
    case 1440: return '0 5 * * *';
    default:   return '0 5 * * *';
  }
}

/** 间隔分钟数转可读文本 */
function intervalLabel(minutes: number): string {
  if (minutes < 60) return `${minutes}min`;
  if (minutes < 1440) return `${minutes / 60}h`;
  return `${minutes / 1440}d`;
}

/** 能力探测：只有 SQLite 实现支持在线快照，不靠 instanceof（那需要顶层 import 类） */
function canBackup(storage: Storage): storage is Storage & { backupTo(dest: string): Promise<void> } {
  return typeof (storage as { backupTo?: unknown }).backupTo === 'function';
}

async function main() {
  const storage = createStorage();
  const port = parseInt(process.env.PORT || '') || 5678;
  const config = await buildConfig(port);

  // 后台写接口一律要求 ADMIN_TOKEN（与 README 的「必填」一致）。
  // 没配 token 时所有 /admin 请求都会 401，这里必须说出来 —— 否则用户只会看到
  // 「页面能打开但什么都点不动」，很难联想到是环境变量缺失。
  if (!config.adminToken) {
    console.warn('');
    console.warn('  ⚠️  未配置 ADMIN_TOKEN：后台接口将全部返回 401（页面可打开，但操作无效）');
    console.warn('     请在 .env / docker-compose.yml 里设置 ADMIN_TOKEN=<你的管理密码>');
    console.warn('');
  }

  // refreshRunning：对外的「正在跑」状态（后台按钮、守夜让路都用它）
  // aggregationInFlight：底层 runAggregation 是否真的还没结束。
  // 超时不等于底层停止 —— 只清 refreshRunning 会让下一轮 cron 与仍在写 KV 的上一轮并发，
  // 而 saveSpeedMap / KV_MERGED_CONFIG 都是全量覆盖写，后写吞前写。
  let refreshRunning = false;
  let aggregationInFlight = false;
  let aggregationStartedAt = 0;
  /** 每轮一个序号：超时放行后，旧任务收尾不能把新一轮的标志位清掉 */
  let aggregationSeq = 0;
  const AGGREGATION_TIMEOUT_MS = 45 * 60 * 1000; // 聚合整体超时 45 分钟（含内联频道测速）

  /** 聚合完成后从产出里取几个数字写进执行记录，后台一眼能看出「跑了但产出异常」 */
  const readRunStats = async (): Promise<Record<string, number>> => {
    try {
      const raw = await storage.get(KV_MERGED_CONFIG);
      if (!raw) return {};
      const full = JSON.parse(raw) as { lives?: Array<{ channels?: Array<{ urls?: string[] }> }> };
      const lives = Array.isArray(full.lives) ? full.lives : [];
      let channels = 0;
      let urls = 0;
      for (const g of lives) {
        for (const ch of g.channels || []) {
          channels++;
          urls += (ch.urls || []).length;
        }
      }
      return { groups: lives.length, channels, urls };
    } catch {
      return {};
    }
  };

  const runWithGuard = async (trigger: RunTrigger = 'manual') => {
    // 安全阀：超时后我们等底层自己结束，但万一它彻底僵死（既不 resolve 也不 reject），
    // 不能因此永久禁跑。超过 2×超时仍未收尾就强行放行，并大声记一笔。
    const wedged = aggregationInFlight && Date.now() - aggregationStartedAt > AGGREGATION_TIMEOUT_MS * 2;
    if ((refreshRunning || aggregationInFlight) && !wedged) {
      console.log('[aggregation] Already running, skipping');
      const rec = await beginRun(storage, 'aggregate', trigger, '上一轮仍在运行');
      await finishRun(storage, rec.id, { status: 'skipped', error: '上一轮仍在运行' });
      return;
    }
    if (wedged) {
      console.warn('[aggregation] previous run stuck > 90min without settling, forcing a new run (writes may interleave)');
    }
    refreshRunning = true;
    aggregationInFlight = true;
    aggregationStartedAt = Date.now();
    const myRun = ++aggregationSeq;
    const rec = await beginRun(storage, 'aggregate', trigger);
    let status: RunStatus = 'success';
    let error: string | undefined;
    let timedOut = false;
    // 底层任务只创建一次：超时后要能继续跟踪它，而不是把它丢掉
    const task = runAggregation(storage, config);
    try {
      await Promise.race([
        task,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Aggregation timed out')), AGGREGATION_TIMEOUT_MS),
        ),
      ]);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      status = /timed out/i.test(msg) ? 'timeout' : 'failed';
      error = msg;
      timedOut = status === 'timeout';
      console.error(`[aggregation] Error: ${msg}`);
    } finally {
      if (timedOut) {
        // 超时只是「我们不等了」，底层还在写 KV。保持两个标志位，直到它真的结束：
        // 这期间任何 cron / 手动触发都会被开头的检查挡掉，避免两轮并发全量覆盖。
        console.warn('[aggregation] timed out, underlying run still in flight — blocking new runs until it settles');
        void task
          .catch(() => { /* 底层最终结果不影响本轮 timeout 记录 */ })
          .finally(() => {
            if (myRun !== aggregationSeq) return;   // 已经有新一轮接管，别动它的标志位
            aggregationInFlight = false;
            refreshRunning = false;
            console.log('[aggregation] underlying run settled, new runs allowed');
          });
      } else {
        aggregationInFlight = false;
        refreshRunning = false;
      }
      const stats = await readRunStats();
      const finished = await finishRun(storage, rec.id, { status, error, stats });
      if (finished) {
        const summary = summarizeRuns(await loadRunHistory(storage));
        const alertCfg = await loadAlertConfig(storage);
        const delivery = await notifyRunFinished(storage, alertCfg, finished, summary);
        if (delivery.sent) console.log(`[alert] run ${finished.status} notified`);
        else if (delivery.skipped && delivery.skipped !== 'not-needed') {
          console.log(`[alert] run ${finished.status} not sent (${delivery.skipped})`);
        }
      }
    }
  };

  /**
   * 漏跑自检：每 6 小时一次（判据 25 小时，当天漏跑当天能发现）。
   * 启动后先让「启动补跑」做完判定再检查，否则会先报一次「漏跑」再自己补上。
   */
  let startupCatchUpDone = false;
  const checkMissedRun = async () => {
    if (!startupCatchUpDone) return;
    try {
      const summary = summarizeRuns(await loadRunHistory(storage));
      if (!summary.stale) return;
      const cfg = await loadAlertConfig(storage);
      const delivery = await notifyMissedRun(storage, cfg, summary);
      console.warn(
        `[scheduler] 超过 ${Math.round(RUN_STALE_MS / 3600000)} 小时没有成功聚合（上次成功：${summary.lastSuccess?.startedAt || '无'}）` +
        (delivery.sent ? '，已告警' : ''),
      );
    } catch (err) {
      console.warn(`[scheduler] missed-run check failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // 动态 cron 管理
  let currentTask: cron.ScheduledTask | null = null;
  let currentSchedule = '';

  function scheduleCron(cronExpr: string) {
    if (currentTask) {
      currentTask.stop();
    }
    currentSchedule = cronExpr;
    currentTask = cron.schedule(cronExpr, () => {
      console.log(`[cron] Triggered at ${new Date().toISOString()}`);
      runWithGuard('cron');
    });
    console.log(`[cron] Scheduled: ${cronExpr}`);
  }

  // ─── 每日数据库快照 ──────────────────────────────────────
  // 库里有 5 万条源台账 + 全部配置，NAS 单点、没有别的备份手段。
  // 用 SQLite 的在线备份 API（不锁库），保留最近 7 份。
  if (canBackup(storage)) {
    const dataDir = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'));
    const backupDir = path.join(dataDir, 'backup');
    const runBackup = async () => {
      // 这是唯一备份手段（NAS 单点 + 5 万条台账），失败也要进执行记录与告警，
      // 不能只留一行 console.warn
      const rec = await beginRun(storage, 'backup', 'cron', '每日数据库快照');
      let dest = '';
      try {
        if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:T]/g, '').slice(0, 13); // yyyymmddHHmm
        dest = path.join(backupDir, `tvbox-${stamp}.db`);
        await storage.backupTo(dest);
        const files = fs.readdirSync(backupDir).filter((f) => f.startsWith('tvbox-') && f.endsWith('.db')).sort();
        for (const f of files.slice(0, Math.max(0, files.length - 7))) {
          fs.unlinkSync(path.join(backupDir, f));
        }
        const sizeMb = fs.statSync(dest).size / 1048576;
        console.log(`[backup] snapshot written: ${dest} (${sizeMb.toFixed(0)}MB, keep 7)`);
        await finishRun(storage, rec.id, { status: 'success', stats: { sizeMb: Math.round(sizeMb), kept: 7 } });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[backup] failed: ${msg}`);
        const finished = await finishRun(storage, rec.id, { status: 'failed', error: msg });
        if (finished) {
          const cfg = await loadAlertConfig(storage);
          await notifyRunFinished(storage, cfg, finished, summarizeRuns(await loadRunHistory(storage)));
        }
      }
    };
    cron.schedule('30 5 * * *', () => { void runBackup(); });
    console.log('[backup] scheduled: 30 5 * * * (daily snapshot, keep 7)');
  }

  // 读取 KV 中的间隔设置，否则用环境变量/默认值
  const storedInterval = await storage.get(KV_CRON_INTERVAL);
  let initialSchedule: string;
  let intervalMin: number;

  if (storedInterval) {
    intervalMin = parseInt(storedInterval) || DEFAULT_CRON_INTERVAL;
    initialSchedule = intervalToCron(intervalMin);
  } else {
    initialSchedule = config.cronSchedule || '0 5 * * *';
    intervalMin = DEFAULT_CRON_INTERVAL;
  }

  scheduleCron(initialSchedule);

  // 频道测速独立 cron（每 2 小时，见 CHANNEL_PROBE_CRON；测速并入聚合时自动跳过）
  cron.schedule(CHANNEL_PROBE_CRON, async () => {
    const rec = await beginRun(storage, 'probe', 'probe', '独立测速 cron');
    try {
      if (!(await isProbeEnabled(storage))) {
        await finishRun(storage, rec.id, { status: 'skipped', note: '测速开关关闭' });
        return;
      }
      // 测速已并入聚合流程时，这条独立 cron 不再重复跑
      if ((await storage.get(KV_CHANNEL_PROBE_INLINE)) !== 'false') {
        await finishRun(storage, rec.id, { status: 'skipped', note: '测速已并入聚合' });
        return;
      }
      console.log(`[channel-probe-cron] Triggered at ${new Date().toISOString()}`);
      // 必须隔离连接池：一轮上万次短连接，共享全局池会把同进程的其它请求整批挂住
      // （probe-net.ts 头注释记录的那次「聚合卡 14 分钟」就是它）
      const r = await withProbeNet(() => runChannelProbe(storage), { connections: 64 });
      await finishRun(storage, rec.id, {
        status: r.state === 'error' ? 'failed' : 'success',
        error: r.error,
        stats: { probed: r.probed, success: r.success, failed: r.failed, coverage: r.coverage },
      });
      // 测速完成后重建一次，否则新排序要等到下一次聚合才生效
      await runWithGuard('probe');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await finishRun(storage, rec.id, { status: 'failed', error: msg });
      console.error('[channel-probe-cron] Error:', err);
    }
  });
  console.log(`[channel-probe-cron] Scheduled: ${CHANNEL_PROBE_CRON} (runs when enabled)`);

  // 源质量守夜：每小时自动重验重点台头部源、补缺口、发现新地址并重新发布。
  // 这是「全自动维护」的主循环，不需要人点按钮。
  cron.schedule(LIVE_GUARD_CRON, async () => {
    try {
      if (refreshRunning) return;                                  // 聚合优先，守夜让路
      if ((await storage.get(KV_LIVE_GUARD_ENABLED)) === 'false') return;
      const rec = await beginRun(storage, 'guard', 'cron', '源质量守夜');
      try {
        const r = await withProbeNet(() => runQualityGuard(storage));
        await finishRun(storage, rec.id, {
          status: r.state === 'skipped' ? 'skipped' : 'success',
          note: r.state,
          stats: {
            checked: r.checked, probed: r.probed, repaired: r.repaired,
            changed: r.changed, added: r.addedUrls, gaps: r.gaps.length,
            published: r.published ? 1 : 0,
          },
        });
        if (r.state === 'done') {
          console.log(`[guard] repaired=${r.repaired} changed=${r.changed} probed=${r.probed} ${Math.round(r.elapsedMs / 1000)}s`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await finishRun(storage, rec.id, { status: 'failed', error: msg });
        throw err;
      }
    } catch (err) {
      console.error('[guard] Error:', err instanceof Error ? err.message : String(err));
    }
  });
  console.log(`[guard] Scheduled: ${LIVE_GUARD_CRON} (hourly, auto repair)`);

  // 漏跑自检：每 6 小时一次（判据 25 小时 → 当天漏跑当天能发现）
  // 启动那次留给下面的「启动补跑」判定，避免先报漏跑再自己补上
  cron.schedule(MISSED_RUN_CHECK_CRON, () => { void checkMissedRun(); });
  console.log(`[scheduler] Missed-run check: ${MISSED_RUN_CHECK_CRON}`);

  // 启动补跑：容器重启若跨过了当天的聚合时刻，当天就这么空掉了 ——
  // 光靠告警不产出配置，所以这里直接补一轮，补完再做漏跑自检。
  const catchUpDelayMs = 60 * 1000;
  setTimeout(() => {
    void (async () => {
      try {
        const summary = summarizeRuns(await loadRunHistory(storage));
        // 全新部署（没有任何执行记录）不算漏跑，交给正常 cron
        if ((summary.last || summary.lastSuccess) && !refreshRunning && !aggregationInFlight) {
          const lastOkMs = summary.lastSuccess ? Date.parse(summary.lastSuccess.startedAt) : 0;
          // 宽限 15 分钟：刚跑完就重启不该再来一轮
          const dueMs = intervalMin * 60 * 1000 + 15 * 60 * 1000;
          if (!lastOkMs || Date.now() - lastOkMs >= dueMs) {
            console.log(
              `[scheduler] 启动补跑：上次成功 ${summary.lastSuccess?.startedAt || '无记录'}，` +
              `已超过 ${Math.round(dueMs / 60000)} 分钟，立即补一轮聚合`,
            );
            await runWithGuard('startup');
          }
        }
      } catch (err) {
        console.warn(`[scheduler] startup catch-up failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        startupCatchUpDone = true;
        void checkMissedRun();       // 补跑之后仍有缺口（例如补跑失败）才告警
      }
    })();
  }, catchUpDelayMs);

  const app = createApp({
    storage,
    config,
    triggerRefresh: runWithGuard,
    enableChannelProbe: true,
    enableBuilder: true,
    isSyncing: () => refreshRunning,
    onCronIntervalChange: (intervalMinutes: number) => {
      const newCron = intervalToCron(intervalMinutes);
      console.log(`[cron] Interval changed to ${intervalLabel(intervalMinutes)} (${newCron})`);
      scheduleCron(newCron);
    },
  });

  let displayHost = 'localhost';
  try {
    const u = new URL(config.localBaseUrl || '');
    displayHost = u.hostname;
  } catch { /* keep localhost */ }

  serve({ fetch: app.fetch, port }, (info) => {
    console.log('');
    console.log('  TVBox Source Aggregator');
    console.log(`  > Build:   v${APP_VERSION} (${APP_COMMIT})`);
    console.log(`  > Local:   http://localhost:${info.port}/`);
    if (displayHost !== 'localhost') {
      console.log(`  > Network: http://${displayHost}:${info.port}/`);
    }
    console.log(`  > Admin:   http://${displayHost}:${info.port}/admin`);
    console.log(`  > Status:  http://${displayHost}:${info.port}/status`);
    console.log(`  > Cron:    ${currentSchedule} (every ${intervalLabel(intervalMin)})`);
    if (config.dockerMissingBaseUrl) {
      console.log('');
      console.log('  ⚠️  检测到 Docker 环境但未配置 BASE_URL');
      console.log(`     当前地址 ${displayHost} 为容器内部 IP，TVBox 客户端可能无法访问`);
      console.log('     请在 .env 或 docker-compose.yml 中设置：BASE_URL=http://宿主机IP:端口');
    }
    console.log('');
    console.log(`  TVBox 填入地址: http://${displayHost}:${info.port}/`);
    console.log('');
  });
}

function getLocalIp(): string | null {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return null;
}

function isDocker(): boolean {
  try {
    fs.accessSync('/.dockerenv');
    return true;
  } catch {
    try {
      const cgroup = fs.readFileSync('/proc/1/cgroup', 'utf8');
      return /docker|containerd/.test(cgroup);
    } catch {
      return false;
    }
  }
}

main();
