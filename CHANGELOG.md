# Changelog

## 未发布（基于 v2.2.0）

### Security

- **P0-4** `/credential/token.json` 不再匿名可读：改为 `/credential/<32hex>/token.json`（路径密钥，聚合时自动注入源的 ext），老路径需管理 token；去掉 `Access-Control-Allow-Origin: *`
- **P1-6** `/img-proxy`、`/reader-proxy` 加 SSRF 守卫（拒回环/私网/链路本地/非 http(s)，重定向逐跳校验）
- **P1-7** 后台鉴权收口为 `core/admin-auth.ts` 一份实现：6 条内联 PUT 与 8 条公开 GET 统一走 `verifyAdmin`；恒定时比较 + 按来源失败限速
- **P1-8** 凭证注入不再用 `''` 覆盖未登录平台的 token/cookie（逐字段跳过），避免「配了凭证反而更差」
- **P1-9** 站点指纹改在凭证注入前统一计算并全链路复用（跳过名单不再因凭证刷新整片失效）

### Fixes

- **P0-1** `node-entry` 顶层 `SQLiteStorage` import 改为能力探测：`better-sqlite3` 缺失时 JSON 降级链真正生效
- **P0-2** 域名台账「已有域名再次抽样全失败」也会落盘（`applyHostOutcomes` 增加 `touched`），7/30 天复验周期恢复
- **P0-3/P1-3** 守夜 `regression-guard` 早退前先记账（saveSpeedMap / 复活出档 / 重计时 / 报表），修复「批量失效一次 → 守夜永久卡死」
- **P1-4** 独立测速 cron 与手动触发包 `withProbeNet`（不再污染全局连接池）
- **P1-5** 聚合超时不再放行并发：底层未结束前禁止新轮次（2× 超时兜底放行 + 告警）
- **P2-7** 漏跑判据 26h→25h，自检改为每 6 小时一次（当天漏跑当天可知）
- **P2-8** 输出前复核硬超时不再伪造失败写健康数据（与守夜/分级保障口径对齐）
- **P2-9** `condemnExpired` 的 `since` 回填会落盘（判死时钟能启动）
- **P2-10** 数据库备份进执行记录与告警
- **P2-11** 启动补跑：重启跨过聚合时刻时自动补一轮（`RunTrigger='startup'` 落地）
- **P2-12** 凭证加密的 base64 改分块，避免 13 万字节级明文触发 `RangeError`
- **P2-13** 风险分级能识别协议相对地址与 `$$$` 里的裸域名，并支持一层嵌套对象
- 执行记录读改写加进程内串行锁（三个 cron 并发不再互相覆盖）
- `channel_probe_segment` 开关真正作用到探测路径（不再只是放宽评分）
- `saveSpeedMap` 支持合并写：守夜/复核不再与全量测速互相吞写；落盘裁掉 7 天前的条目
- 「快/慢」阈值统一到 `config.ts`（排序分与分级不再各用一套边界）
- 统一 `channel_probe_inline` / `channel_probe_segment` / `site_keep_link` 的 KV 常量写法
- 后台模板 `onclick="fn('...')"` 改为 `data-*` 传参（消除 JS 上下文注入）
- `undici` 补进 `dependencies`（生产依赖不再依赖 wrangler 传递引入）
- 清理死代码：`isGuardRunning`、`formatRunLine`、`sampledHosts`、`fingerprintSet` 冗余实现

## v2.1.1 (2026-06-10)

### Fixes

- Builder 白屏 + Admin 导航入口 + MacCMS 占位符未替换



## v2.1.0 (2026-06-10)

### Features

- 配置构建器（Builder）+ 版本号管理机制
- live merge mode switch — separated (per-source) vs merged (dedup)
- 新增 Android APK 形态——废旧手机当聚合服务器
- 黑名单变更实时生效（patchMergedConfig）
- 结构化日志 + 正则黑名单 + 智能Base URL + 站点验活 + 本地字体
- 聚合日志 + 分组排序 + 相似去重 + 6主题 + 背景自定义 + JSON 下载端点
- MacCMS 本地模式边缘函数代理回退（/api/:key）
- MacCMS 本地模式 API 代理（/api/:key 路由扩展）
- 直播源频道级合并（方案 D+）+ Native 格式 type 泄漏/CF 子请求修复
- 配置编辑器屏蔽优化（局部更新+批量操作）+ Docker IP 检测
- 网盘扫码登录与 Cookie 统一管理
- MacCMS 萌芽采集自动抓取 + 记忆规则配置 + 聚合超时调整
- 边缘函数代理——本地 Docker 支持 CF/Vercel 代理回退 + 图片 CDN
- 自动抓取 juwanhezi.com 源列表（私有功能）
- JAR 仓库管理体系——DEX 解析 + 精确类匹配 + 图片伪装解码
- TVBox 配置新增 pic 字段支持图片代理前缀
- UA 升级为 TVBox 标准浏览器 UA + 站点测速开关
- 源接口健康监控——累积追踪失败状态，Dashboard/Admin 分级展示
- 全局主题切换（暗色/亮色），三页面统一支持
- 定时任务可配置间隔 + 站点测速增强
- 配置解码器支持图片伪装和加密格式
- JSON 直接导入 + 源名称定制
- 多仓递归展开 + 黑名单修复 + i18n + 多项优化
- 直播源聚合 + JAR代理 + 去重优化 + 可视化配置编辑器
- 补充 CF 边缘代理支持
- MacCMS 源集成 — 验证过滤 + Admin 管理界面

### Fixes

- expose regexBlocked status in /admin/config-data for frontend display
- reapply JAR proxy in patchMergedConfig + live-config realtime parsing
- 配置编辑器 tab 页签多语言支持
- Admin UI 中文化 + 正则黑名单迁移到配置编辑器 + 语法错误修复
- /live-config 端点改为返回 txt 格式（TVBox 直播配置地址兼容）
- MacCMS 聚合验证跳过（有 edge proxy 时信任运行时兜底）
- dashboard 移除刷新按钮 + 复制 clipboard fallback + Node.js 本地 JAR 代理
- 双 UA 回退——okhttp 优先，解析失败自动换浏览器 UA 重试
- DEX 解析器改用 Central Directory 定位——修复 Data Descriptor 模式的 ZIP
- 启用 CF 边缘代理——填入 WORKER_BASE_URL + 清理过时 env 配置
- 亮色主题对比度修复——补全遗漏 #fff 替换 + 加深强调色
- 站点去重统一用 key+api，消除 JAR 差异导致的冗余条目
- correct Docker Hub image name to rio22/tvbox-aggregator
- use --ignore-scripts in Dockerfile for multi-arch ARM compatibility
- 修复聚合后相对路径补全遗漏



## v2.0.0 (2026-04-20)

- Initial release: TVBox 聚合器完整功能