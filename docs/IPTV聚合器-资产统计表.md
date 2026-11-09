# IPTV 聚合器 · 资产统计表

> 两个仓库都是**资产库**：本仓库是主干，朋友的分支是零件来源。
> 每条资产写清：来源、形态、规模、决定、落地位置。新增或删除模块必须同步这张表。

---

## 一、主干资产（本仓库 `tmadmao/tvbox-source-aggregator`）

自 `upstream/main` 起算 14 个提交。按职责分三组，全部**只服务直播/发布链路**，不碰点播核心。

### 1.1 直播数据层

| 模块 | 行数 | 职责 | 引入提交 |
|---|---|---|---|
| `core/live-url.ts` | 121 | `url$源名` 拆分/拼装、排序比较器、域名去相关 | e53a223 |
| `core/live-merger.ts` | 669 | 下载、解析、频道归并、分组、拼装输出 | 改造 |
| `core/live-groups.ts` | 150 | 分组归并规则（关键词 → 标准组） | 314cb05 |
| `core/live-order.ts` | 247 | 分组内顺序、央视智能排序、移出规则 | f11905f |
| `core/live-filters.ts` | 65 | 购物/推广频道过滤 | d7ab31a |
| `core/live-deadlist.ts` | 54 | 死源黑名单（含自愈） | ab9986d |

### 1.2 测速与健康

| 模块 | 行数 | 职责 | 引入提交 |
|---|---|---|---|
| `core/channel-probe.ts` | 655 | 多采样、预算调度、L2 分片复验、失败累计 | ab9986d + 本次 |

### 1.3 发布与运维

| 模块 | 行数 | 职责 | 引入提交 |
|---|---|---|---|
| `core/ftp-sync.ts` | 199 | FTP 覆盖上传、路径兼容、连接诊断 | d7ab31a / 4f2d33b |
| `core/site-skip.ts` | 54 | 「保留链接」模式的跳过名单 | 8299b29 |
| `routes/channel-order-admin.ts` | 222 | 频道排序 / 分组归并 / 购物过滤 / 配置源 lives 开关 | 7eac2ad 起 |
| `routes/channel-probe-admin.ts` | 155 | 测速启停、清理死源、回滚、清缓存 | ab9986d 起 |

---

## 二、外部资产（朋友分支 `upstream/fix/parser-and-source-cache`）

基线 `f9f7932`，领先 `upstream/main` 14 个提交、28 个文件、+3907 行。逐项决定如下。

| 资产 | 规模 | 形态 | 决定 | 理由 / 落地位置 |
|---|---|---|---|---|
| `core/channel-health.ts` | 173 行 | 纯逻辑 | **取** | 失败原因分级（永久 / 长期 / 短期）+ 阈值判定；P2 的地基，搬进 `core/` 后接我们自己的 speed map |
| `core/source-cache.ts` | 104 行 | 纯逻辑 + KV | **取** | 单源 last-good：某个源偶发超时不再让它名下站点整批消失；独立无 UI |
| `core/live-url-blacklist.ts` | 185 行 | 逻辑 + 路由 | **缓取** | 正则黑名单与我们「按测速结果批量拉黑」互补；先只取匹配函数，不加 UI |
| `core/live-group-rules.ts` | 559 行 | 规则引擎 | **不搬** | 「写正则让源适配规则」与「频道是实体」是两条路；硬合会互相打架 |
| `core/live-group-defaults.ts` | 385 行 | 规则数据 | **不搬** | 同上；只可借鉴省份识别这类纯函数 |
| `core/live-group-builder-ui.ts` | 932 行 | 独立 UI | **不搬** | 第二套后台（自有路由 + 快照），违背「一套 UI 框架」 |
| `core/live-url-blacklist-ui.ts` | 275 行 | 独立 UI | **不搬** | 同上 |
| `core/live-mirrors.ts` | 80 行 | 逻辑 | **暂不搬** | GitHub 镜像归组，当前源无此需求 |
| `core/zip-source.ts` | 199 行 | 逻辑 + 依赖 | **暂不搬** | Release ZIP 源，当前源无此需求 |
| `core/decoder.ts` / `fetcher.ts` 改动 | 136 行 | 逻辑 | **评估中** | 宽松 JSON、AES 尾部空白容错；等遇到具体坏源再取，不预防性搬 |
| `scripts/test-live-url-blacklist.mjs` | 78 行 | 测试脚本 | **取** | 唯一带测试的模块，值得作为我们补测试的样板 |

**净取用**：`channel-health` + `source-cache` + `live-url-blacklist` 的匹配函数 + 一个测试脚本，
合计约 400 行；其余 3400 行不进入主干。

---

## 三、移植铁律

1. 只搬**无 UI 的纯逻辑模块**，界面一律我们写 —— 保证只有一套框架。
2. 每个移植文件头注明来源：`ported from JoeyFFF/tvbox-source-aggregator@<commit>`。
3. 一个模块一个 commit，搬完用真实数据跑对比，不达标不合并。
4. 搬进来的代码要能被我们自己的配置体系驱动，不为兼容对方 KV 键而新增分支。

---

## 四、运维资产

| 项 | 位置 | 说明 |
|---|---|---|
| 部署脚本 | `dev/nas-update.sh` | 编译 → 打包 → scp → 重启，约 15 秒 |
| NAS 目录 | `/volume2/docker/tvbox-aggregator/` | `data/`（数据库）、`dist/`（挂载）、`src/`（可重建镜像） |
| 并行验证实例 | `/volume2/docker/tvbox-friend/` | 朋友分支的移植验证，端口 5679，已停用，保留作参考 |
| 测试夹具 | `dev/fixture-server.mjs` | 模拟配置源/m3u/ts 流，不依赖第三方源 |
| 真实数据样本 | `dev/data/live-config.txt` | 3683 频道 / 17515 源，回归用 |

> `dev/` 已在 `.gitignore` 中（其中 `askpass.sh` 含 NAS 明文密码）。

---

## 五、针对「固化 + 健康」的资产比对（2026-11-09）

做设计核对时逐项确认过：哪些能直接用，哪些必须新写。结论是**字段定义直接采用他的，机制自己实现**。

| 需求 | 现有资产 | 结论 |
|---|---|---|
| 健康字段 `lastOkAt / consecutiveFails / firstFailAt / lastFailReason` | 朋友 `types.ts` + `channel-health.ts` 已在用 | **直接采用**；我方 `fails` 迁移为 `consecutiveFails`，读取兼容旧值 |
| 失败原因三分（永久/长期/短期）及其集合 | 他的 `PERMANENT_FAIL_REASONS` / `LONG_TERM_OBSERVE_REASONS` | **采用**，阈值常量一并取（MIN_FAILS=3、LONG_TERM=7d、RETRY=24h） |
| 分级重测 | 他的 `shouldProbeEntry()` | **采用 + 改一处**：永久失败从「永不重测」改为 7 天回测（否则域名复活永不发现） |
| 分片复验 | 我方 `verifyPlayable()` / `firstUri()` | 已有，直接复用 |
| 并发池 | 双方都是扁平的 `runWithConcurrency` | **需改**：加 host 计数表与排队；无现成实现 |
| 频道的稳定 id / 别名 | 无。他的 `LiveGroupSnapshot` 只有 `channels: string[]`（名字列表） | **需新建** |
| 每轮历史序列 | 无。双方都只存最后一条结论 | **需新建**（12 轮位图 + 计数） |
| 排序 / 域名去相关 | 我方 `live-url.ts` / `live-rank.ts` | 已有 |
| 频道排序 UI（分类 + 拖动 + 智能排序） | 我方 `channelOrderSection` | 已有，迁到「频道」页后扩展源管理 |
| 源健康面板 | 无，但 admin 现有 `.section` / 表格组件可复用 | 新建面板，样式复用 |
| 源缓存的 last-good | 他的 `source-cache.ts` | 尚未取用；与固化无直接关系，P2 后评估 |

**净新增代码预估**：registry + id 规则 ≈ 200 行；健康字段与位图 ≈ 120 行；
host 限流 ≈ 60 行；复核首位 ≈ 80 行；两个面板 ≈ 400 行。合计约 860 行，
均可落在现有 `core/live-*` 与 `core/channel-probe.ts` 的边界内，不引入新框架。
