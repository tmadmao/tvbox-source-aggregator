// 配置常量

// 默认阈值
export const DEFAULT_SPEED_TIMEOUT_MS = 5000; // 配置 URL 超时（fetch 耗时筛选）
export const DEFAULT_SITE_TIMEOUT_MS = 3000;  // 站点 API 超时
export const DEFAULT_FETCH_TIMEOUT_MS = 5000; // fetch 配置 JSON 超时

// KV keys
export const KV_MERGED_CONFIG = 'merged_config';
export const KV_MERGED_CONFIG_FULL = 'merged_config_full'; // 黑名单过滤前的完整配置（供配置编辑器使用）
export const KV_SOURCE_URLS = 'source_urls';
export const KV_LAST_UPDATE = 'last_update';
export const KV_MANUAL_SOURCES = 'manual_sources';
export const KV_MACCMS_SOURCES = 'maccms_sources';
export const KV_LIVE_SOURCES = 'live_sources';
export const KV_LIVE_SCRAPED = 'live_scraped';

// 直播源代理缓存 TTL（秒）
export const LIVE_PROXY_TTL = 7200; // 2 小时

/**
 * GitHub raw 镜像前缀（按顺序尝试，先成功的胜出）。
 *
 * 为什么需要：很多直播源订阅挂在 raw.githubusercontent.com 上，而 NAS / 家宽
 * 直连该域名的 443 端口是被阻断的（DNS 能解析出 185.199.x.x，TCP 直接不通，
 * curl 返回 000）。实测 NAS 上 10 条 GitHub 源全部下载失败 —— 配置里明明有，
 * 结果一条都没生效，聚合日志里也只是一行 "sourcesFailed"。
 *
 * 镜像只做「原样代理」，内容与原始地址一致；空数组表示不启用镜像回退。
 */
export const LIVE_MIRROR_PREFIXES = [
  'https://gh-proxy.com/',
  'https://ghproxy.net/',
];

/** 只对这些 host 的地址尝试镜像回退（避免给正常源平白多试一轮） */
export const LIVE_MIRROR_HOSTS = ['raw.githubusercontent.com', 'gist.githubusercontent.com'];

/**
 * 直播源列表文件（m3u/txt）的下载超时。
 *
 * 不能复用 FETCH_TIMEOUT_MS（5 秒）：那个值是为「配置 JSON」定的，通常几十 KB；
 * 直播源列表动辄 200KB~1.3MB（实测 suxuang/myIPTV 268KB 冷启动要 18.6 秒，
 * cs3306 的合集 845KB 要 10 秒）。5 秒会把这类大文件整体判死。
 */
export const LIVE_SOURCE_TIMEOUT_MS = 20000;

// 图片代理缓存 TTL（秒）
export const IMG_PROXY_TTL = 604800; // 7 天

// 黑名单
export const KV_BLACKLIST = 'blacklist';

// JSON 导入：内联配置前缀
export const KV_INLINE_PREFIX = 'inline_config_';

// 名称定制配置
export const KV_NAME_TRANSFORM = 'name_transform';

// 源健康状态
export const KV_SOURCE_HEALTH = 'source_health';

// 站点测速开关（默认启用）
export const KV_SPEED_TEST_ENABLED = 'speed_test_enabled';

// TVBox 客户端 UA（源服务器按此 UA 返回 JSON 而非 HTML）
export const TVBOX_UA = 'okhttp/3.12.0';
// 浏览器 UA 回退（部分源只接受浏览器 UA）
export const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/94.0.4606.54 Safari/537.36';

// 定时任务间隔（分钟）
export const KV_CRON_INTERVAL = 'cron_interval';
export const DEFAULT_CRON_INTERVAL = 1440; // 默认每天一次

// 边缘函数代理
export const KV_EDGE_PROXIES = 'edge_proxies';

// 网盘凭证
export const KV_CLOUD_CREDENTIALS = 'cloud_credentials';
export const KV_CREDENTIAL_POLICY = 'credential_policy';
export const KV_CREDENTIAL_ENCRYPTION_KEY = 'credential_encryption_key';
/**
 * 自托管 token.json 的路径密钥（32 位十六进制）。
 *
 * 为什么需要：TVBox/FongMi 客户端只能裸 GET 这个地址（带不了 Bearer），
 * 所以不能用 token 鉴权；但路径公开 + 明文吐网盘 Cookie 等于凭证外泄。
 * 折中：用不可猜的路径段代替凭证，聚合注入时自动写进源的 ext。
 */
export const KV_CREDENTIAL_TOKEN_SECRET = 'credential_token_secret';

// 搜索配额
export const KV_SEARCH_QUOTA = 'search_quota';
export const KV_SEARCH_QUOTA_REPORT = 'search_quota_report';

// ═══ 直播频道级测速（方案 D+）══════════════════════════
export const KV_CHANNEL_SPEED_MAP = 'channel_speed_map';
export const KV_CHANNEL_PROBE_ENABLED = 'channel_probe_enabled';
export const KV_CHANNEL_PROBE_STATUS = 'channel_probe_status';
export const KV_CHANNEL_MERGED_TREE = 'channel_merged_tree'; // 最近一次合并的频道树（供 probe 使用）
export const KV_LIVE_DEAD_URLS = 'live_dead_urls';
export const KV_LIVE_CHANNEL_ORDER = 'live_channel_order'; // 分组内频道自定义顺序
export const KV_LIVE_GROUP_MERGE = 'live_group_merge';     // 直播分组归并规则
export const KV_SITE_KEEP_LINK = 'site_keep_link';         // 不可达剔除时是否保留链接（true=仅跳过探测）
export const KV_SITE_SKIP_LIST = 'site_skip_list';         // 保留模式下被跳过的站点指纹
export const KV_LIVE_SHOPPING_FILTER = 'live_shopping_filter'; // 购物台过滤（开关 + 关键词）
export const KV_CHANNEL_PROBE_INLINE = 'channel_probe_inline'; // 频道测速是否并入聚合流程（默认是）
export const KV_CHANNEL_PROBE_SEGMENT = 'channel_probe_segment'; // L2 分片复验开关（默认开）
export const KV_LIVE_HEAD_VERIFY = 'live_head_verify'; // 输出前复核首位源（默认开）
export const KV_CHANNEL_REGISTRY = 'live_channel_registry'; // 频道目录（固化框架）
export const KV_LIVE_TOP_N = 'live_top_n';                   // 每频道保留源数（一键选优）
export const KV_LIVE_CHANNEL_OVERRIDES = 'live_channel_overrides'; // 频道置顶/禁用（人工覆盖）
export const KV_LIVE_HOST_STATE = 'live_host_state';           // 域名健康台账（可疑/判死）
export const KV_LIVE_HIDE_DEAD = 'live_hide_dead';             // 全死频道是否直接隐藏（默认开）
export const KV_LIVE_USE_CONFIG_LIVES = 'live_use_config_lives'; // 是否采用配置源自带的 lives（默认否）
export const KV_FTP_SYNC = 'ftp_sync';                       // FTP 对外发布配置
export const KV_SITE_FP = 'site_fingerprints';               // 站点指纹（凭证注入前计算，全链路复用）

// 聚合日志
export const KV_AGG_LOGS = 'agg_logs';
export const AGG_LOGS_MAX = 50;
export const KV_SITE_SNAPSHOT = 'site_snapshot';

// ═══ 调度执行历史与告警 ═══════════════════════════════
export const KV_RUN_HISTORY = 'run_history';
/** 保留 7 天（按条数再兜一层，避免异常刷屏把 KV 撑爆） */
export const RUN_HISTORY_KEEP_MS = 7 * 24 * 3600 * 1000;
export const RUN_HISTORY_MAX = 400;
export const KV_ALERT_CONFIG = 'alert_config';
export const KV_ALERT_LAST = 'alert_last';
/**
 * 超过这个时间没有成功聚合 → 判定「漏跑」。
 *
 * 25 小时（而不是 26）：默认每天 05:00 聚合、06:30 自检，若当天没跑，
 * 06:30 时距上次成功 25.5 小时 —— 取 26 会差 30 分钟判不出来，要等第二天，
 * 等于「单日漏跑静默」。25 小时让当天的自检就能响。
 */
export const RUN_STALE_MS = 25 * 3600 * 1000;
/** 漏跑自检频率：每 6 小时一次（判据再看 25 小时，最迟漏跑当天的下一个自检点就能发现） */
export const MISSED_RUN_CHECK_CRON = '0 */6 * * *';

// ═══ 分级源质量保障 ═══════════════════════════════════
export const KV_LIVE_CURATION_RULES = 'live_curation_rules';   // 编排规则外置（台序/配额）
export const KV_LIVE_QUALITY_GUARANTEE = 'live_quality_guarantee'; // 质量保障总开关（默认开）
export const KV_LIVE_QUALITY_GAP = 'live_quality_gap';         // 最近一次缺口报表
/** 缺口补测整轮预算：央视→卫视→重点地方台，超时收工不拖垮聚合 */
export const QUALITY_GUARANTEE_BUDGET_MS = 8 * 60 * 1000;

// ═══ 源质量守夜（全自动维护）═══════════════════════════
export const KV_LIVE_GUARD_ENABLED = 'live_guard_enabled';   // 默认开
export const KV_LIVE_GUARD_REPORT = 'live_guard_report';     // 最近一次守夜结果
export const KV_LIVE_GUARD_STATE = 'live_guard_state';       // 连续缺口计数（用于告警）
/** 守夜间隔：每小时一次（只看将过期/有缺口的台，成本很低） */
export const LIVE_GUARD_CRON = '20 * * * *';
/** 头部源复核新鲜度：超过 1 小时就重新验一次（每小时守夜正好全覆盖） */
export const GUARD_STALE_MS = 60 * 60 * 1000;
export const GUARD_BUDGET_MS = 8 * 60 * 1000;
export const GUARD_CONCURRENCY = 6;
/** 连续多少轮仍有缺口才告警（避免一次抖动就叫人） */
export const GUARD_ALERT_AFTER = 3;


// 背景设置
export const KV_BG_SETTINGS = 'bg_settings';

// 分组排序
export const KV_GROUP_ORDER = 'group_order';

// 高级去重配置
export const KV_DEDUP_CONFIG = 'dedup_config';

// 直播禁用开关
export const KV_LIVE_DISABLED = 'live_disabled';
// 直播合并模式：'separated'（按源分类）| 'merged'（全部合并）
export const KV_LIVE_MERGE_MODE = 'live_merge_mode';

// 智能 Base URL
export const BASE_URL_PLACEHOLDER = '{{BASE_URL}}';
export const KV_SMART_BASE_URL_ENABLED = 'smart_base_url_enabled';

// 站点验活
export const KV_SITE_HEALTH_MAP = 'site_health_map';
export const KV_SITE_PROBE_DEPTH = 'site_probe_depth'; // 'shallow' | 'deep'
export const KV_SITE_AUTO_CLEAN = 'site_auto_clean';   // 'true' | 'false'

// Builder 源追踪
export const KV_SOURCE_MAP = 'builder_source_map'; // { sites: Record, parses: Record, lives: Record }

// 频道测速 cron：每 2 小时（只重测缓存已过期的 URL，不会全量重刷）
export const CHANNEL_PROBE_CRON = '0 */2 * * *';
// 并发与超时（1.6 万 URL 全量一轮，100 并发 ≈ 10 分钟量级）
export const CHANNEL_PROBE_CONCURRENCY = 64;
export const CHANNEL_PROBE_TIMEOUT_MS = 5000;
// 每个 URL 采样次数（取成功样本的中位数，降低单次抖动）
export const CHANNEL_PROBE_SAMPLES = 2;
// 单轮测速预算：超时后剩余 URL 留给下一轮（避免 1.6 万 URL 一次跑不完）
export const CHANNEL_PROBE_BUDGET_MS = 20 * 60 * 1000;

// ─── L2 分片复验 ────────────────────────────────────────
// 播放列表只是一个文本清单，由 CDN 静态返回；真正的分片可能指向另一台已失效的源站。
// 实测：排第一的源里 23% 是「列表 200 但分片 404/超时」，光看 #EXTM3U 判不出来。
export const CHANNEL_PROBE_SEGMENT_TIMEOUT_MS = 4000; // 分片单独计时，不吃整条 5 秒预算
export const CHANNEL_PROBE_SEGMENT_BYTES = 65536;     // 读满 64KB 才算「持续出数据」
export const CHANNEL_PROBE_SEGMENT_MIN_BYTES = 32768; // 低于 32KB 视为无效（首包后卡死/错误页）
/** 分片持续吞吐下限（KB/s）：低于这个值意味着能开头、播不动，电视端照样卡 */
export const CHANNEL_PROBE_SEGMENT_MIN_KBPS = 200;
// 缓存过期（6 小时）：过期即重测，保证排序不会基于一周前的数据
export const CHANNEL_SPEED_TTL_MS = 6 * 60 * 60 * 1000; // 成功源的常规回测间隔
/**
 * 测速缓存的物理保留期（7 天）。
 *
 * TTL 6 小时只是「该重测了」，条目仍要留着供台账回测周期（待观察 7 天）参考；
 * 超过 7 天的条目对任何判据都没用了，落盘时裁掉 —— 否则 channel_speed_map
 * 只增不减（历史 URL 全留），单 key 体积会一直涨。
 */
export const CHANNEL_SPEED_MAP_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
/** 确认死链的回测间隔：撞一次要等满超时，没必要和好源一样勤 */
export const CHANNEL_DEAD_RECHECK_MS = 24 * 60 * 60 * 1000;
/**
 * 判定规则版本。改动判定逻辑（加 L2 分片复验、改阈值等）就 +1：
 * 缓存条目会带着生成它的版本号，旧条目各自重测一次，之后自动回到增量回测。
 * 规则升级因此不需要人肉清空整张缓存表。
 */
// 4 = 分片读 64KB 并校验吞吐（3 只读 8KB，误判了大量「能开头、播不动」的源）
// 3 = 按内容识别播放列表 + 分片复验（2 是只按 .m3u8 扩展名识别）
export const CHANNEL_PROBE_RULE_VERSION = 4;
// 连续失败多少轮后判定为「死链」（排到该频道末尾，不直接删除）
export const CHANNEL_DEAD_FAILS = 2;
/** 域名去相关：一个频道的前 N 条源尽量来自不同 host（同 host 只出现一次） */
export const CHANNEL_HOST_DIVERSIFY = 3;

/**
 * 「快 / 慢」的唯一阈值来源。
 *
 * 以前排序分（source-health 的 speedScore 归零点 3000ms）和分级（gradeOf 的
 * 2500/4500ms）各有一套边界：3000ms 的源在排序里速度分为 0，在分级里却算「可用」。
 * 守夜挑头部源用排序、最终输出用分级，两边标准不一致。这里收口成一份。
 */
/** 「快」的硬线：客户端 5 秒超时，留一半余量，超过 2.5 秒开播就有风险 */
export const QUALITY_FAST_MS = 2500;
/** 「能看」的硬线：超过 4.5 秒基本必撞客户端超时 */
export const QUALITY_SLOW_MS = 4500;

