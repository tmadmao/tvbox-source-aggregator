# 自动化流程与健康度管理 —— 全量代码审计

> 审计对象：`src/`（23,162 行）中与「定时调度 / 自动维护 / 健康度计分 / 台账 / 质量保障」相关的全部实现。
> 审计时间：2026-11-11。代码基线：`d3faffb`（2.2.0）。工作区干净（`git status --short` 无输出）。
> 基线复跑：`tsc --noEmit` 0 报错；`npm test` 62/62 通过（377ms）。
>
> **状态：本文所列 P0/P1/P2 与死代码项已全部修复，见 §10「修复记录」**（含逐条对照、未修项与升级须知）。

## 0. 结论摘要

共确认 **P0 四条 / P1 九条 / P2 十四条 / P3 若干**（第二轮追加 §9）。下表前五条不是「风格问题」，是**功能性失效或安全失效**，均已用运行时或仿真手段复现：

| 级别 | 问题 | 位置 | 后果 |
|---|---|---|---|
| **P0-1** | 顶层 `import { SQLiteStorage }` 使 SQLite→JSON 降级链在**模块加载期**就崩 | `src/node-entry.ts:13` | `better-sqlite3` 缺失时进程直接退出，`createStorage()` 的 try/catch 永远没机会执行 |
| **P0-2** | 域名台账「只有计数非 0 才落盘」+ `applyHostOutcomes` 命中已有行不计任何数 | `src/core/channel-probe.ts:690-697`、`src/core/host-health.ts:161-172` | `probedAt` 永不刷新 → 「7 天/30 天抽 3 条」退化为**每轮重复抽样** |
| **P0-3** | `regression-guard` 早退 → **守夜永久死锁**：`totalBefore` 每轮从同一份旧 map 重算，只要一次批量失效，此后每小时都早退 | `src/core/quality-guard.ts:264-267` + `:372-382` | 守夜「在跑、不做事、不告警」，报表冻结在事故前版本（详见 §2.1 P1-3b） |
| **P1-3** | 守夜 `regression-guard` 早退丢弃整轮探测结论 | `src/core/quality-guard.ts:372-382` | 探测成本已付，`saveSpeedMap` / 台账同步 / 告警计数 / 报表**全部跳过** |
| **P1-4** | 独立测速 cron 与手动触发**未包 `withProbeNet`** | `src/node-entry.ts:273`、`src/routes/channel-probe-admin.ts:113` | 上万次短连接污染全局连接池——这正是 `probe-net.ts` 头注释记录的那次「卡 14 分钟」 |
| **P1-5** | 聚合 45 分钟超时不取消底层任务，`refreshRunning=false` 后可与仍在跑的上一轮并发 | `src/node-entry.ts:155-173` | 两轮同时 `saveSpeedMap` 全量覆盖 → 丢失更新 |
| **P1-6** | `/img-proxy`、`/reader-proxy` 无任何鉴权且转发任意 `cookie` | `src/routes.ts:1976`、`2006` | 已实测可读内网（见 §3.2） |
| **P1-7** | 6 条开关 PUT 用内联 `if (config.adminToken)`，未配 token 时**全部放行** | `src/routes.ts:1770/1786/1805/1826/1842/1858` | 默认部署下任何人可关「输出前复核」、关直播、改基址（见 §3.1） |
| **P2-7** | 单日漏跑不告警（`RUN_STALE_MS=26h`，自检固定 06:30） | `src/core/config.ts:94`、`src/core/alerts.ts:209` | 25.5h < 26h → 需连续**两日**漏跑才响 |
| **P2-8** | `consecutiveFails` 被自身超时污染（`live-verify` 把硬超时伪造成真实失败） | `src/core/live-verify.ts:160-163` | 好源可能被自己 12s 的超时推向 dead |
| **P2-9** | `condemnExpired` 回填 `since` 后不落盘 | `src/core/live-deadlist.ts:182-192` | 未知年龄的死源永远回填不上，判死时钟永远不启动 |
| **P0-4** ⚠️ | `/credential/token.json` **无鉴权** + `ACAO: *`，明文输出网盘 Cookie / refresh_token / 账号密码 | `src/routes.ts:877-888` → `credential-injector.ts:205-259` | **已实测**：无 token 即取到 `{"quark_cookie":"..."}`（§9.1）。全项目最高风险 |
| **P1-8** | 凭证注入用 `\|\| ''` 覆盖：未登录平台的原有 token 被**清空** | `credential-injector.ts:44-46` + `:79-89` | **已实测**：`token` 从 `SRC_TOKEN` 变 `""`，源从「部分可用」变「不可用」（§9.2） |
| **P1-9** | 站点指纹含 `ext`，而注入改写 `ext` → 黑名单（注入前）与跳过名单（注入后）**永不相交** | `blacklist.ts:16-22`、`aggregator.ts:274/348/1044` | **已实测**三个哈希互不相等；凭证刷新后跳过名单全失效（§9.3） |

---

## 1. 自动化流程

### 1.1 调度拓扑（`src/node-entry.ts`）

| 任务 | 表达式 | 行号 | 是否走 `withProbeNet` | 是否写 `run_history` |
|---|---|---|---|---|
| 聚合 | 动态 `initialSchedule`（默认 `0 5 * * *`） | 212 / 257 | 内部各步骤各自包 | 是（`aggregate`） |
| 独立测速 | `0 */2 * * *`（`CHANNEL_PROBE_CRON`） | 260 | **否** | 是（`probe`） |
| 守夜 | `20 * * * *`（`LIVE_GUARD_CRON`） | 291 | 是 | 是（`guard`） |
| 数据库备份 | `30 5 * * *` | 240 | — | **否** |
| 漏跑自检 | `30 6 * * *` + 启动后 30s | 322-323 | — | 否 |

**P1-4（独立测速不隔离网络）**：`node-entry.ts:273` 直接 `await runChannelProbe(storage)`，而同一文件 297 行守夜是 `withProbeNet(() => runQualityGuard(storage))`。`channel-probe-admin.ts:113` 的手动 `/trigger` 同样裸跑。`probe-net.ts:1-11` 的注释明确写着「测速一轮会上万次短连接，池子被打散后，同一进程里的其它请求会整批挂住——实测过一次聚合卡在站点验活 14 分钟不动」。**这里等于把已知事故的成因留着。** 讽刺的是聚合内联测速（`aggregator.ts:496`）是包的，唯独独立 cron 这条没包。

**P1-5（超时不取消）**：`node-entry.ts:160-173`：
```ts
await Promise.race([
  runAggregation(storage, config),
  new Promise((_, reject) => setTimeout(() => reject(new Error('Aggregation timed out')), AGGREGATION_TIMEOUT_MS)),
]);
...
} finally {
  refreshRunning = false;   // 底层 runAggregation 仍在跑
```
`Promise.race` 落败不等于底层停止。45 分钟后 `refreshRunning` 归零，下一次 cron（最短间隔 1 小时，`intervalToCron` 支持 `0 */1 * * *`）即可启动新一轮；上一轮仍在写 `KV_MERGED_CONFIG`、`channel_speed_map`。**两轮并发的写是全量覆盖写**（见 §2.3），后写吞前写。

**P2-10（备份无执行记录）**：`RunKind` 声明了 `'backup'`（`run-history.ts:16`），但全仓库无 `beginRun(storage, 'backup', ...)`。备份失败只在 `console.warn`（`node-entry.ts:237`）里，`run_history` 与告警都看不见。NAS 单点、库里有 5 万条台账，**这是唯一备份手段却不可观测**。

**P2-11（无启动补跑）**：`RunTrigger` 定义了 `'startup'`（`run-history.ts:18`），但全仓库无 `runWithGuard('startup')`。容器重启若跨过 05:00，当天就是这么空掉，只能等 06:30 的自检——而单日漏跑又不告警（§1.3）。

### 1.2 CRON 注释与常量不符

`node-entry.ts:259` 注释写「频道测速独立 cron（每 12 小时，默认关闭）」，实际 `CHANNEL_PROBE_CRON = '0 */2 * * *'`（`config.ts:144`，每 2 小时）。`docs/2026-05-04-直播源频道级合并与测速排序.md` 也写「每 12 小时」。**注释与文档停留在旧值。** 实际影响有限（`channel_probe_inline` 默认开时该 cron 会 `skipped`），但排查「为什么半夜有测速请求」时会走错方向。

### 1.3 漏跑判据（`RUN_STALE_MS = 26h`）

`config.ts:94` + `alerts.ts:209`（`if (!summary.stale) return { sent:false, skipped:'fresh' }`）。
以「每日 05:00 聚合、06:30 自检」建模：

| 天 | 自检时刻 | 距上次成功 | `stale` |
|---|---|---|---|
| D1 | 06:30 | 1.5h | false |
| D2（D1 未跑） | 06:30 | 25.5h | **false** |
| D3（仍未跑） | 06:30 | 49.5h | true |

**单日漏跑静默**。`RUN_STALE_MS` 只比「一天多一点」，而这个自检每天只开一次枪——两个周期量级不匹配。若要「跑没跑」当天可知，要么把自检改成每 6 小时一次（判据不变），要么把判据压到 ~1.5 个聚合周期。

### 1.4 执行记录的无锁读改写

`run-history.ts:85-103`（`beginRun`）、`105+`（`finishRun`）都是「读全表 → push/patch → 写全表」。聚合、测速、守夜三个 cron 可以同时进入 → **互相覆盖**。`run-history.test.ts` 只测了纯函数（`pruneRuns`/`closeStaleRunning`），没有并发用例。

### 1.5 `channel_probe_segment` 开关是死的

`channel-probe.ts:229-233`：
```ts
let segmentCheckEnabled = true;
export function setSegmentCheckEnabled(v: boolean): void { segmentCheckEnabled = v; }
```
`grep -rn "setSegmentCheckEnabled" src/ test/` → **只有定义处，零调用者**。而 `channel_probe_segment` 这个 KV 被 `aggregator.ts:416`、`quality-guard.ts:207` 读成了 `requireSegment`（只影响 `gradeOf` 的评分），**从未传导到 `probeUrlOnce` 内部的 L2 分片复验**（`channel-probe.ts:273`）。也就是说：管理页上关掉这个开关，测速仍然照做分片请求，只是评分时放宽——**语义与界面承诺不符**。

### 1.6 CF 形态的能力缺口

`cf-entry.ts:44-65` 只有 `scheduled` → `runAggregation`。对照 Node 形态，CF 侧**没有**：测速 cron、守夜、备份、漏跑自检、告警、`run_history`。且 `probe-net.ts` 的 `Agent` 在 Workers 运行时不适用（`cf-entry` 不 import 它，靠 `undici` 内联进 bundle 的 WebSocket 分支不触发——但 `undici` 未在 `package.json` 显式声明，只经 `wrangler→miniflare` 传递引入，见 §5.3）。

---

## 2. 健康度管理

### 2.1 唯一写入点是对的，但「写完不一定存」

`source-health.ts:29-60` `recordProbe` 是全链路唯一写入点（测速 / 守夜 / 输出前复核 / 质量保障四路共用），设计正确。问题出在**落盘**环节。

#### P1-3：守夜 `regression-guard` 早退（`quality-guard.ts:372-382`）
```ts
const totalAfter  = tasks.reduce((n, t) => n + t.afterVerified, 0);
if (totalAfter < totalBefore) {
  return { state:'noop', ..., probed, repaired:0, changed:0,
           published:false, note:'regression-guard' };
}
```
该 `return` 跳过了后续全部副作用：
- `quality-guard.ts:403` `if (probed > 0) await saveSpeedMap(storage, map)` —— **整轮探测结论全部丢弃**
- `:408` `removeRecoveredUrls`（复活源出档）
- `:411` `touchProbed`（仍死源重计时）
- `:441` `KV_LIVE_GUARD_STATE`（连续缺口计数）
- `:475` `KV_LIVE_GUARD_REPORT`（报表）

后果连锁：本轮已 `probeOne` 过的 URL，其 `consecutiveFails` 内存里 +1 但没落盘 → 下一轮从旧值重来 → **一个真死的源可能永远攒不到 `CHANNEL_DEAD_FAILS=2`**。同时 `lastOkAt` 也不更新，`gradeOf` 的 `stale` 判定继续用旧时间戳。

这个早退的出发点（「只升不降，变差就保持原样」）本身合理，但**应当只跳过「发布」，不应跳过「记账」**。

##### P1-3b：该早退会形成**永久死锁**（比「丢一轮」严重，需上调优先级）

`totalBefore` 是**每轮重新计算**的（`quality-guard.ts:264-267`，`collect()` 里 `beforeVerified: before.verified`），而它的输入是**落盘的 `map`**。于是：

```
第 N 轮：probe 后 totalAfter 变差 → 早退 → map 不落盘
第 N+1 轮：loadSpeedMap 读到的还是第 N 轮之前的旧 map
         → totalBefore 与上一轮完全相同
         → 重新 probe，结论再次变差 → 再次早退
         → 永远卡在同一个值上
```

**只要某个时刻整体 `verified` 总和因「源批量失效」而下降，守夜就再也无法前进**——它每小时付一次完整探测成本，每小时都早退，`KV_LIVE_GUARD_STATE` 永不更新，告警永不触发（`:431-441` 只在正常路径写），`KV_LIVE_GUARD_REPORT` 永远停在事故前那一版。运维视角看就是「守夜还在跑、但什么都不做、也不报警」。

这不是理论推演：`docs/2026-11-09` 记录的「1859 个域名名下 12352 条源一条都播不出来」这类批量失效，正是触发条件。**触发一次即永久。**

修法：早退分支只 `return` 「发布」，`saveSpeedMap` / `removeRecoveredUrls` / `touchProbed` / 状态计数必须无条件执行。

---

#### P1-3c：早退点会把「本轮新增地址」计入下一轮基线，导致 `addedUrls` 重复累加

`quality-guard.ts:369-372`：补源逻辑里 `task.urls` 已被**永久追加** `newOnes`（`:369`），但若随后走到 `:374` 早退，`task.urls` 的扩展没有回滚——而 `task` 是每次 `collect()` 新建的，所以下一轮不会重复。**但 `task.added` 与 `addedUrls` 已计入本轮结果，却被早退丢弃**，这部分新地址既没进输出、也没进报表，属于静默丢失（与 P1-3 同源，量级较小）。

#### P0-2：域名台账永不刷新 `probedAt`
两处叠加：

1. `channel-probe.ts:690-697`
```ts
const applied = applyHostOutcomes(hostMap, outcomes, Date.now());
if (applied.revived || applied.marked || applied.condemned) {
  await saveHostRows(storage, [...hostMap.values()]);
}
```
2. `host-health.ts:161-172`
```ts
if (o.ok > 0) { if (cur) { rows.delete(o.host); revived++; } continue; }
if (cur) {
  cur.state = (now - (cur.since || now) >= HOST_DEAD_AFTER_MS) ? 2 : 1;
  cur.probedAt = now;             // ← 改了
  if (cur.state === 2) condemned++;  // 只有跨过 30 天才 +1
} else { rows.set(...); marked++; }
```
**已存在的行全失败时**：`revived=0`、`marked=0`、`condemned` 只在跨过 30 天那一刻为 1。于是 `if (applied.revived || ...)` 全 false → **`probedAt` 的修改留在内存里，随函数返回蒸发**。

实测（真实 `loadHostRows`/`saveHostRows` 往返 + 与 `channel-probe` 一致的结算逻辑）：
```
第2轮 applied = { revived: 0, marked: 0, condemned: 0 }
第2轮后落盘 probedAt = 1794404915631   (应 ≈ 1795096115631)
下一轮配额 = 3                          (应为 0)
```
`hostSampleQuota`（`host-health.ts:110-116`）据此返回 `3`，**「7 天可疑 / 30 天判死，每轮只抽 3 条」这个省流设计彻底失效，退化为每轮全量重抽 3 条**。而这条设计在 `channel-probe.ts:568-572` 的注释里被描述为「把一两万条死链每周全测一遍压到两千个域名各抽 3 条」——**这是整个测速预算的地基，现在是虚的。**

同型缺陷还有一处：
#### P2-9：`live-deadlist.ts:182-192` 未知年龄回填丢失
```ts
if (!since) { r.since = now; continue; }   // 改了
...
if (promoted > 0) await saveRows(storage, rows);  // 只在 promoted>0 时存
```
未知年龄的死源，若本轮无其它条目被判死，`since` 回填同样蒸发 → **判死时钟永远不启动**，这些源永远留在「待观察」里白测。

### 2.2 自伤式失败注入（`live-verify.ts:160-163`）
```ts
if (!r) {
  r = { speedMs:0, kind:'fail', timedOut:true, note:'hard-timeout' } as ...;
}
applyResult(bare, r);
```
`raceTimeout(probeUrlOnce(bare), PROBE_HARD_TIMEOUT_MS=12000)`（`live-verify.ts:33/155`）落败时，**伪造一次真实失败并 `recordProbe`**。而 `probeUrlOnce` 自身的 `headersTimeout/bodyTimeout` 是 `CHANNEL_PROBE_TIMEOUT_MS=5000`（`config.ts:147`），`fetchPrefix` 内部有超时；能撑到 12s 的只能是**外层调度/连接池退化**——典型的待机压力问题，不是源的问题。用它去 +1 `consecutiveFails`，等于**把自己的拥塞记到被探测的源头上**。

对照 `quality-guard.ts:271` 与 `source-guarantee.ts:283` 的同一判断都是 `if (!r) return false; // 硬超时：不写结论`。**三处对同一事件三种处理**，只有 `live-verify` 会写。而 `live-verify` 恰好是「输出前复核」——决定最终 8 条头部源的最后一关。

### 2.3 `saveSpeedMap` 是全量覆盖写
`channel-probe.ts:94-96`：`await storage.put(KV_CHANNEL_SPEED_MAP, JSON.stringify(map))`，`map` 由 `loadSpeedMap` 全量读出后重建。同文件 `:659-660` 每 300 条落一次盘。守夜 `:403` 也这么写。两条链路并发 → 后写吞前写。这不是理论问题：P1-5 允许两轮聚合并发，P1-4 允许测速与聚合同时跑。

### 2.4 分级质量保障链路的口径不一致

| 环节 | 硬超时后的处理 | 行号 |
|---|---|---|
| `live-verify`（输出前复核） | **伪造失败并 `recordProbe`** | 160-163 |
| `quality-guard`（守夜） | 不写结论 | 271-273 |
| `source-guarantee`（分级保障） | 不写结论 | 283 |

同一事件三种口径，其中唯一会污染健康数据的那一路在最关键的位置。

**`source-guarantee.ts:300` 的回退也值得记录**：
```ts
ch.urls = after.urls.length > 0 ? after.urls : task.poolUrls;
```
全死台保留原池 → 客户端会拿到一批**已知不可播**的地址。设计意图是「让缺口报表能区分『无源』与『有源全死』」，但代价是把死链推给终端。注释未在输出路径上标注这层豁免，`aggregator.ts:601` 的黑名单过滤只看 `deadSet`/`isHostCondemned`，不看这条回退。

### 2.5 评分三套阈值并存

| 阈值 | 值 | 用途 | 位置 |
|---|---|---|---|
| `SPEED_FLOOR_MS` | 3000 | `scoreOf` 速度分归零点 | `source-health.ts:76` |
| `QUALITY_FAST_MS` | 2500 | `gradeOf` 判 grade 0 | `channel-tier.ts:56` |
| `QUALITY_SLOW_MS` | 4500 | `gradeOf` 判 grade 2 | `channel-tier.ts:58` |

同一个「快/慢」概念在排序分与分级里用了两套边界。**3000ms 的源在 `scoreOf` 里速度分为 0，在 `gradeOf` 里却算 grade 1 可用**。排序与分级对「多快算快」没共识，导致守夜挑「头部源」与最终输出挑「前排源」的标准不同。

### 2.6 死分支与低效

- `channel-tier.ts:116-118` `if (entry.kind === 'tcp' && !segmentVerified)` **不可达**：`probeUrlOnce` 只在 `:304` 产出 `tcp`，而那里固定 `stage:'segment'`（`channel-probe.ts:304`）。所以 `segmentVerified` 恒为 true，该分支是装饰。
- `channel-tier.ts:217-225` 第二轮用 `head.includes(it)` 补配额 —— O(n²)，`quota` 很小（≤6）所以无实害，但同文件 `:227` 已经建了 `headSet`，写法不一致。
- `channel-probe.ts:568` `const sampledHosts = new Set<string>()` 只 `add` 不读（`:588`）—— 大概是给日志/统计留的，从未接出去。
- `channel-probe.ts:109` `pruneExpired` 导出零调用者。注释 `:98` 还写着「清理 7 天前的测速缓存」，但实际清理由 `CHANNEL_SPEED_TTL_MS` 的过期判定在别处做。`saveSpeedMap` 从不裁剪 → **`channel_speed_map` 只增不减**（历史 URL 全留）。
- `source-health.ts:19-23` `pushHistory` 注释写「左移一位」，实现是右侧追加后 `slice(-12)`。行为正确，注释错。

### 2.7 `recordProbe` 的双份失败状态
`source-health.ts:46-47`：
```ts
consecutiveFails: ok ? 0 : (prev?.consecutiveFails ?? prev?.fails ?? 0) + 1,
fails:            ok ? 0 : (prev?.fails ?? 0) + 1,
```
两个字段同步维护，读的地方混用 `??` 兜底（`tierOf`、`gradeOf`、`channel-probe.ts` 的 `deadCount` 都写 `entry.consecutiveFails ?? entry.fails ?? 0`）。**同一语义两份真值**，一旦某条路径只更新其中一个就会分叉。`okCount`/`failCount` 又是第三份（累计版）。三份状态做 `availabilityOf` 的兜底链（`:63-72`），优先级是「累计计数 → history 位图」，没有 `consecutiveFails` —— 但 `tierOf` 又只看 `consecutiveFails`。**同一个「可用率」在打分和分桶里用了不同来源。**

---

## 3. 安全与鉴权

### 3.1 鉴权策略不统一（8 个 `/admin` GET 无鉴权）
脚本枚举 `src/routes.ts` + `src/routes/*.ts` 共 **150 个路由**，其中 `/admin` GET 缺 `verifyAdmin` 的 8 条：

| 行号 | 路由 | 对应 PUT 是否鉴权 |
|---|---|---|
| 295 | `/admin`（页面） | — |
| 1355 | `/admin/config-editor`（页面） | — |
| **1765** | `/admin/live-head-verify` | 是（手写 Bearer） |
| **1781** | `/admin/live-disabled` | 是 |
| **1800** | `/admin/live-merge-mode` | 是 |
| **1821** | `/admin/smart-base-url` | 是 |
| **1837** | `/admin/site-probe-depth` | 是 |
| **1853** | `/admin/site-auto-clean` | 是 |
| **1869** | `/admin/site-keep-link` | 是 |

实测：`GET /admin/live-head-verify` 无 token → `200 {"enabled":true}`；同开关 `PUT` 无 token → `401`。
**结论：只泄露开关值，未泄露密钥。** 但同一个开关「读开写锁」是明确的设计失误——界面上必须能看见（`routes.ts:1762-1764` 注释），可看见的前提不该是公开可读。

更严重的是**这 6 条 PUT 没走 `verifyAdmin`**，而是各自内联了一份手写判断（`:1770`、`1786`、`:1805`、`:1826`、`:1842`、`:1858`）：
```ts
if (config.adminToken) {
  const auth = c.req.raw.headers.get('Authorization');
  if (auth !== `Bearer ${config.adminToken}`) return c.json({ error:'Unauthorized' }, 401);
}
```
而 `verifyAdmin`（`:2039-2043`）在 `adminToken` 为空时是**直接 `return false`（全拒）**。两者语义相反：

| adminToken | `verifyAdmin` | 这 6 条内联 PUT |
|---|---|---|
| 已设置 | 校验 Bearer | 校验 Bearer |
| **未设置** | **全拒** | **全部放行** |

→ **未配 token 的部署（默认部署，见 §3.5）下，`live-head-verify`/`live-disabled`/`live-merge-mode`/`smart-base-url`/`site-probe-depth`/`site-auto-clean` 这 6 个开关是完全开放的写接口**，任何人可关闭「输出前复核」、关闭「直播功能」、改基址。而同一文件里 `site-keep-link`（`:1875`）用的却是 `verifyAdmin`——**相邻两条路由两种策略**，说明这是逐条手写的意外，而非统一设计。

### 3.2 无鉴权代理 → SSRF（已实测）
`routes.ts:1976` `/img-proxy`、`routes.ts:2006` `/reader-proxy`，两者都没有任何 token 校验，且 `:2010` 把请求方传入的 `cookie` 原样塞进转发头。

实测（本地 `PORT=15888 ADMIN_TOKEN=t0k node dist/server.js`）：
```
GET /img-proxy?url=http://127.0.0.1:15888/version      → 200, size=38
GET /reader-proxy?url=http://127.0.0.1:15888/version   → {"version":"2.2.0","commit":"940a462"}
```
即**任意公网请求者可借本服务访问其所在内网**。两个 handler 里没有任何 scheme/host 白名单、没有 127/10/172.16/192.168 拦截。

### 3.3 token 比较非恒定时间、无失败次数限制
`routes.ts:2039-2043`、以及另外 7 个 `src/routes/*.ts` 里**各自复制了一份**同名 `verifyAdmin`（`builder.ts:15`、`channel-order-admin.ts:28`、`channel-probe-admin.ts:20`、`channels-admin.ts:21`、`curation-admin.ts:19`、`health-admin.ts:12`、`scheduler-admin.ts:16`）。
- 全部用 `===` 比较（非 `timingSafeEqual`）
- 无速率限制、无失败计数。admin 页面自身公开（`/admin`），token 可无限次猜。

### 3.4 `/live-config` 在 FongMi 格式下每次都实时下载
`routes.ts:151` 起：FongMi 格式（`type/url/api` 指针）时，每次请求都遍历 `lives` 逐个 `fetch` 远端列表并解析成 txt。这是**公网无鉴权 GET** → 任何人可高频打这个接口，把上游站点的请求量放大成自己的出站流量。`/live.txt`（`:146`）直接 302 到这个接口，等于两个入口。

### 3.5 其他
- `/refresh`（`:1745`）在未配 `refreshToken`/`adminToken` 时**放行**（`if (config.refreshToken || config.adminToken)`）。默认部署即「任何人可触发聚合」。这是刻意设计（注释无），但审计要标出来。
- `/status-data`（`:249`）、`/source-status`（`:288`）公开，泄露源数量、站点数、group 数。属低危。
- `admin.ts` 后台模板里 `onclick="fn('${esc(url)}')"` 形态：`&#39;` 会被 HTML 解析回 `'` 再进入 JS 上下文，**理论可注入**。未构造 PoC，标为待确证。

---

## 4. 死代码与文档口径偏差

### 4.1 零调用者的导出
| 符号 | 位置 | 说明 |
|---|---|---|
| `setSegmentCheckEnabled` | `channel-probe.ts:231` | 见 §1.5，功能因此失效 |
| `pruneExpired` | `channel-probe.ts:109` | 见 §2.6，导致 speed_map 只增不减 |
| `isGuardRunning` | `quality-guard.ts:80` | 无人调用 |
| `formatRunLine` | `alerts.ts:224` | 无人调用 |
| `RunKind='backup'` | `run-history.ts:16` | 从未使用（§1.1 P2-10） |
| `RunTrigger='startup'` | `run-history.ts:18` | 从未使用（§1.1 P2-11） |
| `KV_CHANNEL_PROBE_INLINE` | `config.ts:71` | 常量存在，但 `channel-probe-admin.ts:71/77/112`、`node-entry.ts:267` 全用字符串字面量 `'channel_probe_inline'` |
| `sampledHosts` | `channel-probe.ts:568` | 只写不读 |

`aggregator.ts` 那一大串 `KV_*` import（`:27`）里 `KV_CHANNEL_PROBE_INLINE` 是唯一被用到的；`channel-probe-admin.ts` 与 `node-entry.ts` 反而不 import 它。**同一个 key 三种写法并存**（常量 / 字面量）→ 改 key 名时会漏改。

### 4.2 文档/注释与实际不符
| 文档说法 | 实际 |
|---|---|
| `node-entry.ts:259`「测速独立 cron 每 12 小时」 | `0 */2 * * *`（每 2 小时） |
| `docs/2026-05-04-…测速排序.md`「每 12 小时」 | 同上 |
| `channel-probe.ts:98`「清理 7 天前的测速缓存」 | `pruneExpired` 无调用者 |
| `docs/开发计划 §1`「测速并入聚合」 | 成立（`aggregator.ts:493`），但独立 cron 未隔离网络（P1-4） |
| `docs/开发计划 §1`「守夜连续 3 轮告警」 | 成立（`GUARD_ALERT_AFTER=3`，`quality-guard.ts:448`），但 `regression-guard` 早退会**卡住**连续计数（`state` 只在正常路径写，`:431-441`）——某台连续两轮缺口后第三轮回归守卫早退，计数不 +1，告警被无限期推迟 |
| `source-health.ts:19`「左移一位」 | 右侧追加 + `slice(-12)` |
| `scripts/build-apk.js` 断言「JSON 降级链完好」 | 见 §5.1，实际运行时仍崩 |

### 4.3 构建与依赖
- `scripts/build.js`：`external:['better-sqlite3']`、`format:'cjs'`、`undici` 被**内联**（bundle 内 197 处引用，含完整 `Dispatcher` 实现）。
- `package.json` 未显式声明 `undici`，仅经 `wrangler→miniflare` 传递引入（`5.29.0`）。**生产依赖靠 devDependency 的传递链**——`wrangler` 升级或剪枝即断。
- `scripts/build-apk.js` 断言 `require("better-sqlite3")` 必须保留在产物里，以此宣称「JSON 降级链完好」；但见 §5.1，该断言通过而运行时仍抛错。

---

## 5. 已实测确认（可复现）

### 5.1 P0-1：SQLite→JSON 降级链在加载期即崩
`node-entry.ts:13` 顶层 `import { SQLiteStorage } from './storage/sqlite'`，而 `storage/sqlite.ts:4` 是 `import Database from 'better-sqlite3'`。esbuild 打包成 CJS 后，`init_sqlite()` 被提到 bundle 里 `// src/node-entry.ts` 注释**之前**执行。

实测（屏蔽 `better-sqlite3` 后 `require('./dist/server.js')`）：
```
Error: Cannot find module 'better-sqlite3'
    at init_sqlite (dist/server.js:...)
进程直接退出
```
`createStorage()`（`node-entry.ts:40-60`）的 `try { require('./storage/sqlite') } catch` **永远没机会执行**——因为模块在 `main()` 之前就死了。

补充：`:222` 还有一处 `storage instanceof SQLiteStorage`，同样引用顶层 binding。把这两处改成动态 `require` + 类型别名（`import type`）即可修好，`build-apk.js` 的断言才有意义。

### 5.2 P0-2：域名台账 `probedAt` 不落盘（见 §2.1，附完整输出）
```
第1轮：域名入账 marked=1, probedAt=T0, 落盘成功
第2轮：同域名抽样 3 条全失败
  applied = { revived: 0, marked: 0, condemned: 0 }   ← 三项皆 0
  probedAt 未更新（仍在 T0），saveHostRows 未调用
  hostSampleQuota(row, now) = 3                        ← 应为 0
```

### 5.3 连接池争用：`withProbeNet` 单例跨任务互相打断
`probe-net.ts:47-55` `startProbeNet` 若已有 dispatcher 会 `close()` 旧的；`closeProbeNet:59-77` 在 3s 后 `destroy()` 强制回收。
实验（`_pc5.mjs`，服务端接住连接但永不回包）：
```
B 已执行 closeProbeNet（含 3s 兜底 destroy）于 0.7s
A(守夜中的一条探测) 在 21.1s 结束 -> 失败: Headers Timeout Error   (A 的 bodyTimeout=20s)
```
即**任务 B 收尾时的 `destroy()` 会打断任务 A 在途的探测**。`withProbeNet` 是模块级单例，而聚合内会**嵌套/顺序**调用 4 次（`aggregator.ts:366` 站点验活、`:496` 内联测速、`:623` 质量保障、`:667` 头部复核）——每次 `finally` 都会 `close` + `destroy`。若某次调用与守夜重叠（`node-entry` 无互斥，只有 `refreshRunning` 挡守夜，不挡测速），就会出现 A 被 B 打断。

正常响应场景（`_pc4/_pc6`）未复现中断——说明**只在「僵死连接」下触发**，符合 `probe-net.ts:44-52` 注释记录的那次事故形态。

### 5.4 数据面（去偏校验）
`dev/strict-result.json` 419 条，ok 332：
- 可播源吞吐中位 **5281 KB/s**，p10 965，p25 1909
- 低于阈值 `CHANNEL_PROBE_SEGMENT_MIN_BYTES` 的仅 **0.3%** → 200KB/s 下限几乎不误杀
- 失败集中在 `timeout`（22）+「第1段 timeout」（21）+「第2段 timeout」（5）+「第1段仅 5x~124KB」（28）
  ```
  [ '第N段仅 NKB' 28, '第N段 timeout' 26, 'timeout' 22,
    '第N段吞吐 NKB/s' 6, '第N段 HTTP N' 2, '子列表 timeout' 1, 'fetch failed' 1 ]
  ```

**口径瓶颈在「持续 64KB 内 5s」而非吞吐门槛**（`CHANNEL_PROBE_SEGMENT_BYTES=65536` / `TIMEOUT_MS=5000`）。5s 读 64KB = 12.8KB/s 的等效门槛，理论上极宽松；失败的大头是 `timeout` 说明**很多源在 5s 内连不上或首包后停流**，而不是「慢」。

---

## 6. 待确证（未做端到端实验，仅代码面成立）

1. **聚合超时后并发写 KV 的实际影响**：需长跑（>45min 聚合 + 1h cron）观察 `KV_MERGED_CONFIG` / `channel_speed_map` 是否出现「后写吞前写」。代码面确定，缺现场数据。
2. **守夜与全量测速同时 `saveSpeedMap` 的丢失更新概率**：可写脚本模拟两个 `loadSpeedMap`→改→`saveSpeedMap` 交错，量化丢多少条。
3. **后台模板 XSS 可利用性**：`onclick="fn('${esc(url)}')"` 的 `&#39;` 解码回 `'` 路径，需构造 PoC 确认是否真能逃逸到 JS 上下文。
4. **CF 形态 `channel_speed_map` 单 key 体量**：1 万条 URL 的 JSON 是否逼近 KV 单 value 25MB 上限；KV 写频限制（1 次/秒/key）在一轮测速的 300 条批量落盘下是否触发。
5. **`source-guarantee` 回退 `poolUrls` 的实际占比**：需在一轮真实聚合里统计「全死台」有多少台，量化死链推给终端的规模。

---

## 7. 修复优先级建议（不改代码，仅排期）

1. **P0-1**：`node-entry.ts:13` 改 `import type` + 动态 `require`，移除 `:222` 的 `instanceof`（用 `storage.backupTo` 能力探测替代）。改动极小，恢复唯一降级路径。
2. **P0-2**：`channel-probe.ts:691` 判定改为「有 `probedAt` 变化即保存」，或让 `applyHostOutcomes` 返回 `touched` 计数。同步修 `live-deadlist.ts:191`。
3. **P1-3**：`quality-guard.ts:374` 早退前先执行 `saveSpeedMap` / `removeRecoveredUrls` / `touchProbed`，仅跳过「发布 + 缺口计数」。
4. **P1-4**：`node-entry.ts:273`、`channel-probe-admin.ts:113` 包 `withProbeNet`。
5. **P1-5**：`runWithGuard` 加「上一轮未真正结束则不启动」的独立标志（用 AbortController 或让 `runAggregation` 自报进度），不能只靠 `refreshRunning`。
6. **P1-6**：`/img-proxy`、`/reader-proxy` 加 token 或 host 白名单；至少拦私网段。
7. **P2-7**：漏跑自检改 6 小时一次，或 `RUN_STALE_MS` 降到 30h→改判据模型。
8. **P2-8**：`live-verify.ts:161` 改为「不写结论」，与另两路对齐。
9. **§3.1**：统一 8 个 `verifyAdmin` 副本为一份共享实现；6 条手写 PUT 改为调用它（注意：改了就变成「未配 token 全拒」，需同步确认默认部署是否依赖「无 token 放行」）。
10. **P1-3b（应前置到第 3 位）**：`regression-guard` 早退分支必须先记账再 return，否则「批量失效一次 → 守夜永久卡死」。
11. **`pruneExpired` 接上**：`saveSpeedMap` 前后裁一次 7 天过期项，阻止 `channel_speed_map` 无限增长（§2.6）。
12. **P0-4**：`/credential/token.json` 加鉴权（§9.1），这是**最严重的一条**，优先于其它所有项。

---

## 8. 已排除项（审计过但**不是**缺陷，防止后续重复翻查）

这一节专门记录「看着像 bug、实际是设计」，避免下一轮审计（或上下文丢失后）重复挖同一处。

| 疑点 | 结论 | 依据 |
|---|---|---|
| 守夜 `collect()` 里 `if (tier === 'other') return`，导致 `DEFAULT_TIER_QUOTA.other = 2` 永不生效 | **设计如此**，不是缺陷 | `source-guarantee.ts:110-114` `shouldGuarantee` 同样 `return false`（other），注释写明「只用于排序，不承诺」。两处口径一致 |
| 守夜不更新域名台账（只动 URL 级死源台账） | **设计如此** | `quality-guard.ts:225-227` 注释：「守夜样本太小，不足以给整个域名下结论」 |
| `arrangeSources` 第二轮用 `head.includes(it)` 补配额（O(n²)） | 无实害 | `quota ≤ 6`、`cap = focusSources = 8`，规模恒定 |
| `channel-tier.ts:116` `kind === 'tcp' && !segmentVerified` 不可达 | 属实但无害 | `probeUrlOnce:304` 产出 `tcp` 时固定 `stage:'segment'`。属防御性冗余 |
| `pushHistory` 注释「左移一位」与实现相反 | 注释错，行为对 | 右侧追加 + `slice(-12)`，与 `availabilityOf` 的 `slice(-6)` 口径兼容 |
| 守夜与聚合并发写 `KV_MERGED_CONFIG` | 已有挡板 | `node-entry.ts:293` `if (refreshRunning) return`，守夜让路。**但测速 cron 不受此挡**（见 P1-4） |
| `source-guarantee` 全死台回退 `poolUrls` | 有意为之 | `:300` 注释承认「供缺口报表区分无源/有源全死」。风险在输出侧，已在 §2.4 记录 |
| FTP 上传无显式超时 | 实际有 | `ftp-sync.ts:76` `new mod.Client(15000)`，basic-ftp 构造参数即 socket 超时 |
| `fetchAndParseLiveUrls` 用全局 `fetch` | 可接受 | 只在守夜补源时调一次（`:352`），量级 8000ms 超时逐个，不构成连接池污染 |

---

## 9. 第二轮：凭据 / 站点测速 / 跳过名单（按要求只审这三个模块）

> 追加于 2026-11-11 22:05。范围：`credential-store.ts`(115)、`credential-risk.ts`(265)、`credential-injector.ts`(259)、`speedtest.ts`(201)、`site-skip.ts`(54)，共 894 行，全部逐行读完。
>
> 结论：**新增 P0 一条、P1 两条、P2 两条**（外加撤销一条误判 §9.4），其中 §9.1 是全项目最严重的问题（已实测）。

### 9.1 P0-4：`/credential/token.json` 无鉴权，明文吐网盘凭证（**已实测**）

`routes.ts:877-888`：
```ts
app.get('/credential/token.json', async (c) => {
  const creds = await loadCredentials(storage);
  if (creds.size === 0) return c.json({}, 200, { 'Access-Control-Allow-Origin': '*' });
  const tokenJson = generateTokenJson(creds);
  return c.json(tokenJson, 200, {
    'Access-Control-Allow-Origin': '*',      // ← 任意站点 JS 可跨域直读
    'Cache-Control': 'no-cache',
  });
});
```
**没有任何 `verifyAdmin`**。而 `loadCredentials` → `generateTokenJson`（`credential-injector.ts:205-259`）会输出：

| 输出字段 | 来源 | 是什么 |
|---|---|---|
| `refresh_token` / `open_token` | `credential.refresh_token` | 阿里云盘**长期令牌** |
| `quark_cookie` / `uc_cookie` / `115_cookie` / `bili_cookie` / `tianyi_cookie` / `baidu_cookie` | `credential.cookie` | 各网盘**完整登录 Cookie** |
| `thunder_username` / `thunder_password` | `credential.username/password` | 迅雷**账号密码明文** |
| `pikpak_username` / `pikpak_password` | 同上 | PikPak **账号密码明文** |
| `123_token` | `credential.token` | 123云盘令牌 |

实测（`DATA_DIR=_auditdata PORT=15891 ADMIN_TOKEN=t0k node dist/server.js`，写入一条夸克凭证后**不带任何 token** 读取）：
```
POST /admin/cloud-credentials/quark  (带 Bearer t0k)  → {"success":true}
GET  /credential/token.json          (无 Authorization) → {"quark_cookie":"SECRET_COOKIE_ABC123"}  HTTP=200
```
再加上 `Access-Control-Allow-Origin: *`：**任何一个网页只要 `fetch('https://你的NAS/credential/token.json')` 就能拿到用户的全部网盘凭证**，无需知道内网地址以外的任何信息，也无需用户点击。

这是本项目**风险最高的一条**——前面 P0-1/P0-2/P0-3 是「功能失效」，这条是**凭证直接外泄**。网盘 Cookie 等价于账号控制权（可读可写可删整个网盘）。

> 设计上它必须公开：TVBox 客户端（FongMi 等）要直接拉这个 URL 才能播网盘源，没法带 Bearer。所以**不能简单加 token**。可行方向：
> ① 用 URL 里的不可猜路径段当凭证（`/credential/<32hex>/token.json`，聚合时注入到源的 ext 里）；
> ② 或限定来源 IP / 仅在内网监听；
> ③ 至少去掉 `Access-Control-Allow-Origin: *`，改为白名单 origin。
>
> 顺带：`routes.ts:881` 空凭据时也回 `Access-Control-Allow-Origin: *`，等于对外宣称「这个端点存在且可跨域」。

### 9.2 P1-8：凭证注入会**清空**未登录平台的原值（**已实测**）

`credential-injector.ts:44-46`：
```ts
function getCredValue(creds, platform, field): string {
  return creds.get(platform)?.credential[field] || '';    // 平台不存在 → ''
}
```
配合 `:79-89` 的 `csp_Mogg` 分支：
```ts
if ('token' in obj)     obj.token     = getCredValue(creds, 'aliyun', 'refresh_token');
if ('uccookie' in obj)  obj.uccookie  = getCredValue(creds, 'uc', 'cookie');
if ('tyitoken' in obj)  obj.tyitoken  = getCredValue(creds, 'tianyi', 'cookie');
...
```
**只要字段名存在就无条件覆盖**，不管该平台有没有登录。实测：
```
注入前: {"cookie":"OLD_QUARK","token":"SOURCE_OWN_ALI_TOKEN"}
注入后: {"cookie":"NEW_QUARK","token":""}        ← token 被清空
```
后果：用户只登录夸克，所有 `csp_Mogg` 源里原本由源站自带的 token/cookie 全部变成空字符串 → **该源从「部分可用」变成「完全不可用」**，且比注入前更差。而 `:186` 的入口判断是 `rule.platforms.some(p => credentials.has(p))`——**只要有一个平台登录就执行注入**，不是「逐字段判断」。

真实场景：`csp_Mogg` 的 `platforms` 列了 7 个平台，用户通常只登录 1~2 个 → 其余 5~6 个字段被清空。这解释了为什么「配了凭证反而某些源挂掉」。

修法：`getCredValue` 返回 `string | null`，`null` 时**跳过赋值**而不是写 `''`。

### 9.3 P1-9：跳过名单指纹包含 `ext`，而注入会改写 `ext` → 跳过名单永久失效

链路：

```
Step 5.7 凭证注入（aggregator.ts:317-333）   → merged.sites[i].ext 被改写
Step 6   站点验活前过滤跳过名单（aggregator.ts:348-359）
         const fp = await siteFingerprint(site);   // ← ext 已是被改写后的值
         if (!skipList.has(fp)) kept.push(site);
```

而指纹定义（`blacklist.ts:16-22`）：
```ts
const raw = `${site.api}|${ext}|${site.jar || ''}`;   // ext 参与哈希
```

跳过名单是在**上一轮的自动清理**里写入的（`aggregator.ts:1044` `siteFingerprint(site)`，那时 `ext` 同样是**注入后**的值）——看起来一致。但问题在于**注入不是幂等的**：

- 第 1 轮：`ext` = 源站原值（含源自带 token）→ 注入 → `ext_A` → 指纹 `fp_A` → 记入跳过名单
- 第 2 轮：源站重新拉取，`ext` 回到原值 → 注入 → `ext_A`（若凭证没变）→ `fp_A` ✓ 命中

**只要凭证变了（重新扫码登录、cookie 刷新、token 过期重取），`ext` 就变，指纹全变，整个跳过名单瞬间归零**。表现：用户重新登录网盘后，之前「保留链接但不再探测」的几百个站点**全部恢复探测**，一轮聚合多花十几分钟。

更糟的是**黑名单同样用这个指纹**（`applyBlacklist:118`），而黑名单在 Step 4（`:274`）执行——**在注入之前**，用的是源站原值 `ext`。于是：
- 黑名单指纹基于 **注入前** 的 `ext`
- 跳过名单指纹基于 **注入后** 的 `ext`
- 两者混在同一个概念「站点指纹」下，但**永远不相等**

执行时序（`aggregator.ts`）：
```
Step 4   :274  applyBlacklist(merged, pruned)          → 指纹 = api|ext_原值|jar
Step 5.7 :317  injectCredentials(...) → merged.sites   → ext 被改写
Step 6   :348  loadSkipList → siteFingerprint(site)    → 指纹 = api|ext_注入后|jar
Step 6   :386  updateSiteHealth(...) → :1044 siteFingerprint(site) → 写入跳过名单（注入后）
```

实测三个哈希：
```
黑名单用（Step 4，注入前）      : 44422a3b072e2603
跳过名单用（Step 6，注入后）    : 4be1643966ac6d3a    ← 与上一行不等
凭证刷新后跳过名单指纹          : c77a17274abd7a3b    ← 与第1轮跳过名单也不等
```

后果：自动清理时若 `keepLink=true` 写入跳过名单（注入后指纹），而用户之前手动拉黑的同一站点（注入前指纹）——两条记录指向同一站点却互不识别。且 `pruneBlacklist` 若按指纹比对也会错位。

**更实际的后果**：凭证一刷新（重新扫码、cookie 过期重取），跳过名单里几百条记录全部失配 → 下一轮聚合把「已决定不再探测」的站点**全部重新探测一遍**，多花十几分钟，且用户会以为「保留链接功能失效了」。

修法：`siteFingerprint` 不应包含会变的 `ext`。要么去掉 `ext`（只用 `api|jar`，会误伤同 api 不同配置），要么**在注入前算指纹并缓存**，全链路复用同一个值（推荐后者：在 `merged` 上挂一个 `_fp` 字段，Step 4 算一次，Step 6 与 `updateSiteHealth` 直接读）。

### 9.4 ~~P2-12~~ 已撤销：`speedtest.ts` 的 `resp.text()` 超时保护**没有问题**

（原疑点，核对后撤销，保留记录以免下次重复挖）

`speedtest.ts:14-45`：
```ts
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), timeoutMs);
const resp = await netFetch(url, { signal: controller.signal, ... });
const body = await resp.text();
```
初判「timer 只覆盖到响应头，读 body 无保护」——**错误**。`:44` 的 `finally { clearTimeout(timer) }` 在整个 `try` 结束后才执行，`resp.text()` 在 `try` 内，所以 timer 全程有效；undici 在 `signal` abort 时会中断 body 流，`resp.text()` 抛 `AbortError`，被 `:39` 归为 `timeout`，逻辑正确。**撤销。**

### 9.5 P2-12：`credential-store.ts` 的 `btoa(String.fromCharCode(...arr))` 有展开上限

`credential-store.ts:20`、`:36`：
```ts
const b64 = btoa(String.fromCharCode(...new Uint8Array(exported)));   // :20，32 字节，安全
return btoa(String.fromCharCode(...combined));                        // :36，随明文长度增长
```
实测展开上限：
```
n=65536   OK
n=100000  OK
n=130000  FAIL RangeError: Maximum call stack size exceeded
n=200000  FAIL
```
`:36` 的 `combined` = 12 字节 IV + 密文，密文 ≈ 明文长度。**明文（所有平台凭证的 JSON）超过约 130KB 时，`encrypt()` 直接抛 `RangeError`**。实际凭证量级只有几 KB，**短期不触发**，但：
- 迅雷/PikPak 的 `credential` 里若存了长 token 或额外字段，多个平台累积仍可能逼近；
- 一旦触发，`saveCredential` 抛错 → 用户**无法再保存任何凭证**，且错误信息是 `Maximum call stack size exceeded`，完全看不出根因。

修法：改成分块 `String.fromCharCode.apply(null, chunk)` 或 `Buffer.from(arr).toString('base64')`（Node 侧），CF 侧用循环拼。

### 9.6 P2-13：`credential-risk.ts` 的域名判定有多处失真

| 问题 | 位置 | 说明 |
|---|---|---|
| `extractDomains` 只匹配 `https?://`，且用 `[^/\s$]+` 抓 host | `:255` | 协议相对地址 `//evil.com/x`、以及 `token.json` 的 `$$$` 分隔格式里**不带协议的域名**全部漏掉 → `thirdPartyDomains` 为空 → 误判为 B 类 `safe` |
| `analyzeExt` 只扫 `Object.values(ext)` 的**第一层** | `:176` | 嵌套对象 `{a:{cookie:"x"}}` 里的 cookie 检测不到（`:168` 的 key 扫描也只扫第一层） |
| `'token'` 映射到 `aliyun` | `:44` | 但 `csp_Mogg` 里 `token` 实际是阿里云盘 token（`injector:82` 用 `refresh_token`），而 `open_token` 也需要——映射单一 |
| `OFFICIAL_DOMAINS` 硬编码白名单 | `:24-33` | 新增官方域名（如 `api.alipan.com` 的 CDN 子域）会被误判为第三方 → riskLevel 从 `safe` 升到 `low`，导致 `injected` 被策略挡下。**只影响分级宽松度，不影响安全**（fail-safe 方向），可接受 |

其中**第一条是真问题**：SSRF/凭证外泄面被低估。`analyzeStringExt:243-249` 对纯字符串 ext 也走 `extractDomains`，同样漏 `$$$` 后的裸域名。

### 9.7 本轮已排除项（核对后确认**不是**缺陷）

| 疑点 | 结论 | 依据 |
|---|---|---|
| `speedtest.ts:30` `resp.text()` 不受 `AbortController` 超时保护 | **不是缺陷** | `resp.text()` 在 `try` 内、`clearTimeout` 在 `finally`，`signal` 全程有效。实测 undici 会在 abort 时中断 body |
| `speedtest.ts:104-122` `scheduleNext()` 递归导致栈溢出 | **不是缺陷**（已实测） | 完成回调走 `Promise.then`，属 microtask，**每次回到事件循环，栈不累积**。3000 任务实测 `maxDepth = 1` |
| `speedtest.ts:125-131` 预算耗尽时剩余站点标 `timeout` | 设计如此 | 标 `timeout` 而非 `error`，`filterUnreachableSites:164` 只认 `ok` 保留——即预算耗尽的站点**会被过滤掉**。但 `:172` 有 10% 安全阀兜底（`reachableTestable/totalTestable < 0.1` 时全保留），不会因预算不足清空站点 |
| `speedtest.ts` 与 `channel-probe` 是两套独立测速 | 设计如此 | 前者测**站点**（`sites`，CMS 接口），后者测**直播源 URL**（`lives`）。指标含义不同（TTFB vs 吞吐+容器校验），互不干扰 |
| `site-skip.ts` `MAX_ENTRIES=20000` 静默截断 | 可接受 | `:26` `slice(0, MAX_ENTRIES)`，超出部分静默丢弃。20000 远超实际站点数（约 1000），不触发 |
| `site-skip.ts` `fingerprintSet` 零调用者 | 属实，无害 | `grep` 全仓无调用。属预留工具函数 |
| `credential-store.ts` 空凭据时写 `''` 而非删除 key | 可接受 | `:87` `storage.put(KV_CLOUD_CREDENTIALS, '')`，`loadCredentials:53` `if (!raw) return map` —— 空串是 falsy，等价于「无凭据」，行为正确 |
| `credential-store.ts` 加密密钥与密文存在**同一个 storage** | 见下 | 这是真实弱点，但属**架构取舍**，已在下条说明 |

**关于「密钥与密文同库」**：`KV_CREDENTIAL_ENCRYPTION_KEY` 与 `KV_CLOUD_CREDENTIALS` 都进同一个 Storage（`config.ts:52/54`）。AES-GCM 加密对**拿到整个 DB 文件的人**没有防护作用——密钥就在隔壁。它的实际价值只有「防止随手 `SELECT` 看到明文」。这点在 `cloud-login.ts` 的登录态里也没有更强保护。**判为设计取舍，不列为缺陷**，但应记录：**数据库文件一旦泄露（NAS 被拖库、`data/backup/*.db` 被下载），凭证即明文等价**。而备份文件正好在 `data/backup/`，且 `node-entry.ts:240` 每天生成一份。

---

## 附：审计覆盖清单

| 文件 | 行数 | 覆盖 |
|---|---|---|
| `src/node-entry.ts` | 395 | 全量 |
| `src/cf-entry.ts` | ~70 | 全量 |
| `src/core/quality-guard.ts` | 480 | 全量 |
| `src/core/channel-probe.ts` | 755 | 全量 |
| `src/core/host-health.ts` | 193 | 全量 |
| `src/core/live-deadlist.ts` | 227 | 全量 |
| `src/core/source-health.ts` | 151 | 全量 |
| `src/core/channel-tier.ts` | 320 | 全量 |
| `src/core/source-guarantee.ts` | 362 | 全量 |
| `src/core/live-verify.ts` | 188 | 全量 |
| `src/core/probe-net.ts` | 170 | 全量 |
| `src/core/run-history.ts` | 225 | 全量 |
| `src/core/alerts.ts` | 226 | 全量 |
| `src/routes.ts` | 2044 | 路由枚举 + 鉴权面 + 代理 handler |
| `src/routes/*.ts` | 7 文件 | 鉴权面 + 触发路径 |
| `src/storage/*.ts` | 3 实现 | 落盘语义 |
| `src/aggregator.ts` | 1085 | 自动化接入点（Step 6/6.5a/6.6/保障/复核） |
| `scripts/build.js` / `build-apk.js` | — | 打包与断言 |
| `test/*.test.ts` | 7 文件 / 62 用例 | 覆盖面评估 |
| `src/core/ftp-sync.ts` | 199 | 发布环节（守夜 + 聚合两处调用）、超时、重试三连 |
| `src/core/channel-curation.ts` | 898 | 配额归一化（`:300-320`）、`isFocusChannel`（`:887`）、`shouldGuarantee` 边界 |
| `src/core/channel-registry.ts` | 178 | 只读了导出面（`upsertFromGroups` / `findUnmapped`），未逐行 |
| `src/core/live-merger.ts` | 682 | 只读了 `fetchAndParseLiveUrls`（`:626`），其余未审 |
| **`src/core/credential-store.ts`** | **115** | **第二轮，全量** |
| **`src/core/credential-risk.ts`** | **265** | **第二轮，全量** |
| **`src/core/credential-injector.ts`** | **259** | **第二轮，全量** |
| **`src/core/speedtest.ts`** | **201** | **第二轮，全量** |
| **`src/core/site-skip.ts`** | **54** | **第二轮，全量** |
| `src/core/blacklist.ts` | 233 | 只读了指纹与 `applyBlacklist`（`:16-126`），其余未审 |

### 明确**未**纳入本轮审计的模块（与自动化/健康度无关，故略）

共 67 个文件 / 23,162 行，本轮覆盖约 **24 个文件 / 9,800 行**（含第二轮 894 行）。未审的 43 个文件主要是：

- **UI 层**：`core/admin.ts`(3802)、`dashboard.ts`(707)、`shared-styles.ts`(835)、`config-editor.ts`(820)、`builder-ui.ts`(794)、`shared-ui.ts`(218) —— 只由 §3.5 的 XSS 疑点触及
- **凭据/登录**：`cloud-login.ts`(658)、`jar-proxy.ts`(179) —— `credential-*` 三个已审完，这两个是登录流程与 JAR 代理，**未审**
- **站点侧**：`fetcher.ts`(412)、`merger.ts`(264)、`parser.ts`(240)、`dedup.ts`(238)、`source-scraper.ts`(209)、`cleaner.ts`(67) —— `blacklist.ts` 只读了指纹段
- **直播侧（非健康）**：`live-order.ts`(247)、`live-source.ts`(170)、`live-url.ts`(155)、`live-groups.ts`(150)、`live-filters.ts`(65)、`group-order.ts`(80)
- **构建器/导出**：`builder-export.ts`(249)、`builder-store.ts`(146)、`routes/builder.ts`(157)
- **其他**：`decoder.ts`(250)、`maccms.ts`(113)、`search-quota.ts`(93)、`channel-conflicts.ts`(111)、`base-url.ts`(62)、`logger.ts`(74)、`version.ts`(5)

**按用户要求（2026-11-11 22:04），上述 43 个文件与主要功能无关，只要未发现 BUG 即完全忽略。** 若后续发现异常再针对性回看。
---

## 10. 修复记录（2026-11-11 22:45）

> 基线与本文一致（`d3faffb`）。修复后：`tsc --noEmit` 0 报错；`npm test` **72/72 通过**（新增 10 条回归用例）；
> `npm run build:node` 通过；并用真实进程复跑了 §5.1、§9.1、§3.1、§3.2 的原始复现命令。

### 10.1 逐条对照

| 编号 | 结论 | 修复方式 | 代码位置 |
|---|---|---|---|
| **P0-1** | 已修 | 去掉顶层 import，改能力探测 `canBackup()`（`backupTo` 存在性） | `node-entry.ts` |
| **P0-2** | 已修 | `applyHostOutcomes` 返回 `touched`；调用方按 `touched>0` 落盘 | `host-health.ts`、`channel-probe.ts` |
| **P0-3 / P1-3 / P1-3b** | 已修 | 早退分支先 `saveSpeedMap(merge)` / `removeRecoveredUrls` / `touchProbed`，再只跳过发布，并写 `KV_LIVE_GUARD_REPORT` | `quality-guard.ts` |
| **P1-3c** | 已修 | `addedUrls` 进入早退结果与报表，不再静默丢弃 | `quality-guard.ts` |
| **P1-4** | 已修 | 独立测速 cron、`/admin/channel-probe/trigger` 均包 `withProbeNet` | `node-entry.ts`、`channel-probe-admin.ts` |
| **P1-5** | 已修 | 新增 `aggregationInFlight` + 轮次序号：超时不放行，底层结束才解锁；2× 超时兜底强制放行并告警 | `node-entry.ts` |
| **P1-6** | 已修 | 新增 `core/net-guard.ts`：拒私网/回环/链路本地/非 http(s)，重定向逐跳校验 | `net-guard.ts`、`routes.ts` |
| **P1-7 / §3.1** | 已修 | 新增 `core/admin-auth.ts` 单一实现（恒定时比较 + 按来源失败限速）；6 条内联 PUT + 8 条公开 GET 全部改调它；7 个副本删除 | `admin-auth.ts`、`routes.ts`、`routes/*.ts` |
| **P1-8** | 已修 | `getCredValue` 返回 `string \| null`，null 时跳过赋值；`csp_Mogg` 改为字段表逐项判断 | `credential-injector.ts` |
| **P1-9** | 已修 | 新增 `computeFingerprints` / `siteFingerprintCached`：Step 5.6（注入前）算一次，Step 6 跳过名单、自动清理、配置编辑器全部复用；同时落 `KV_SITE_FP` 供后台展示 | `blacklist.ts`、`aggregator.ts`、`routes.ts` |
| **P0-4** | 已修 | 新增 `/credential/:secret/token.json`（32hex 路径密钥，注入时写入源 ext）；老路径 `/credential/token.json` 需管理 token；两条都去掉 `ACAO:*` | `routes.ts`、`credential-store.ts`、`credential-injector.ts` |
| **P2-7** | 已修 | `RUN_STALE_MS` 26h→25h，自检 cron 改 `0 */6 * * *`（文案与常量同源） | `config.ts`、`node-entry.ts`、`alerts.ts` |
| **P2-8** | 已修 | 硬超时不再伪造失败写结论，改为跳过该条；新增 `stats.unknown` 区分「结论未知」与「全死」 | `live-verify.ts` |
| **P2-9** | 已修 | `condemnExpired` 增加 `backfilled` 计数，回填 `since` 也落盘 | `live-deadlist.ts` |
| **P2-10** | 已修 | 备份进 `beginRun/finishRun('backup')`，失败发告警 | `node-entry.ts` |
| **P2-11** | 已修 | 启动 60s 后按「距上次成功 > 间隔+15min」补跑一轮（`RunTrigger='startup'`）；无历史不补 | `node-entry.ts` |
| **P2-12 / §9.5** | 已修 | base64 改 8KB 分块拼接 | `credential-store.ts` |
| **P2-13 / §9.6** | 已修 | 域名提取覆盖协议相对地址、`$$$` 裸域名，排掉文件名伪 TLD；`analyzeExt` 支持一层嵌套对象 | `credential-risk.ts` |
| **§1.2** | 已修 | 注释与 `docs/2026-05-04` 的「每 12 小时」全部改为 2 小时 | `node-entry.ts`、`docs/` |
| **§1.4** | 已修 | `beginRun`/`finishRun` 加进程内串行队列 | `run-history.ts` |
| **§1.5** | 已修 | `runChannelProbe` 读 KV 后 `setSegmentCheckEnabled`；`probeUrlOnce` 增第 3 参数 `requireSegment`，守夜/分级保障/输出前复核按次传入 | `channel-probe.ts`、`quality-guard.ts`、`source-guarantee.ts`、`live-verify.ts` |
| **§2.3** | 已修 | `saveSpeedMap(merge)`：部分写入方合并（按 `probedAt` 取新），全量测速仍覆盖 | `channel-probe.ts` |
| **§2.5** | 已修 | `QUALITY_FAST_MS`/`QUALITY_SLOW_MS` 收口到 `config.ts`，`SPEED_FLOOR_MS` 取同一条线 | `config.ts`、`channel-tier.ts`、`source-health.ts` |
| **§2.6** | 已修 | `pruneExpired` 接入 `saveSpeedMap`（7 天物理保留）；`head.includes` 改 `headSet`；`pushHistory` 注释订正；`sampledHosts` 改为真日志计数 | `channel-probe.ts`、`channel-tier.ts`、`source-health.ts` |
| **§2.7** | 已修 | `consecutiveFails`/`fails` 由同一值派生，不会再分叉 | `source-health.ts` |
| **§3.3** | 已修 | 恒定时比较 + 每来源 30 次/分钟限速（只惩罚来源，不全局锁死） | `admin-auth.ts` |
| **§3.4** | 已修 | FongMi 格式 live.txt 加 2 分钟进程内缓存（`X-Proxy-Cache` 标记命中） | `routes.ts` |
| **§3.5 XSS** | 已修 | 4 处 `onclick="fn('${esc(x)}')"` 改 `data-*` + `this.dataset.*` | `admin.ts` |
| **§4.1 死代码** | 已修 | 删 `isGuardRunning`、`formatRunLine`；`sampledHosts` 接出日志；`fingerprintSet` 复用 `computeFingerprints`；`RunKind='backup'`/`RunTrigger='startup'` 均已使用 | 多处 |
| **§4.3** | 已修 | `undici` 进 `dependencies` | `package.json` |
| **§8 已排除项** | 维持 | 未改动（结论不变） | — |

### 10.2 未修（有意保留）

1. **§1.6 CF 形态的能力缺口**（无测速 cron / 守夜 / 备份 / 自检 / 告警）：这不是「写错了」，而是 Workers 侧没有常驻定时器与可写的本地文件系统，KV 写频与单 value 25MB 也撑不住这套逻辑。要给 CF 补齐，等于另做一套「按 Worker Cron 拆分 + 分片存储」的实现，属于功能项而非缺陷修复，故不在本轮范围。
2. **§2.6 `channel-tier.ts:116` 不可达分支**：属防御性冗余（§8 已判定无害），保留。
3. **§3.5 `/status-data`、`/source-status` 公开**：低危且 Dashboard 依赖它匿名可读，未改。
4. **§3.5 `/refresh` 未配 token 时放行**：刻意设计，已补注释说明代价。
5. **§9.7「密钥与密文同库」**：架构取舍，已记录风险（备份文件等同明文），未改。

### 10.3 行为变化（升级须知）

- **后台接口一律需要 `ADMIN_TOKEN`**。未配置时 `/admin/*`（含 8 条原公开 GET）全部 401，启动日志会打印醒目告警。docker-compose 默认 `ADMIN_TOKEN=changeme`，不受影响。
- **`/credential/token.json` 不再匿名可读**。客户端请用聚合注入后的 `/credential/<32hex>/token.json`；手动配置过的旧地址需要改成新地址（或带 `Authorization: Bearer <ADMIN_TOKEN>` 自行取用）。
- **漏跑判据 25h**：连续两天没跑变成「当天 06:30 就会告警」。
- **`channel_speed_map` 会一次性瘦身**：落盘时裁掉 7 天前的条目，历史 URL 不再永久保留。
