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
export const KV_CHANNEL_PROBE_INLINE = 'channel_probe_inline';
export const KV_LIVE_HEAD_VERIFY = 'live_head_verify'; // 输出前复核首位源（默认开）
export const KV_CHANNEL_REGISTRY = 'live_channel_registry'; // 频道目录（固化框架）
export const KV_LIVE_TOP_N = 'live_top_n';                   // 每频道保留源数（一键选优） // 频道测速是否并入聚合流程
export const KV_LIVE_CHANNEL_OVERRIDES = 'live_channel_overrides'; // 频道置顶/禁用（人工覆盖）
export const KV_LIVE_USE_CONFIG_LIVES = 'live_use_config_lives'; // 是否采用配置源自带的 lives（默认否）
export const KV_FTP_SYNC = 'ftp_sync';                       // FTP 对外发布配置           // 手动「清理死源」后持久化的黑名单（源恢复后自动移出）

// 聚合日志
export const KV_AGG_LOGS = 'agg_logs';
export const AGG_LOGS_MAX = 50;
export const KV_SITE_SNAPSHOT = 'site_snapshot';

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
export const CHANNEL_PROBE_CONCURRENCY = 100;
export const CHANNEL_PROBE_TIMEOUT_MS = 5000;
// 每个 URL 采样次数（取成功样本的中位数，降低单次抖动）
export const CHANNEL_PROBE_SAMPLES = 2;
// 单轮测速预算：超时后剩余 URL 留给下一轮（避免 1.6 万 URL 一次跑不完）
export const CHANNEL_PROBE_BUDGET_MS = 20 * 60 * 1000;

// ─── L2 分片复验 ────────────────────────────────────────
// 播放列表只是一个文本清单，由 CDN 静态返回；真正的分片可能指向另一台已失效的源站。
// 实测：排第一的源里 23% 是「列表 200 但分片 404/超时」，光看 #EXTM3U 判不出来。
export const CHANNEL_PROBE_SEGMENT_TIMEOUT_MS = 4000; // 分片单独计时，不吃整条 5 秒预算
export const CHANNEL_PROBE_SEGMENT_BYTES = 8192;      // 读到 8KB 就认为「确实在出数据」
export const CHANNEL_PROBE_SEGMENT_MIN_BYTES = 8192;  // 低于 8KB 视为无效（多为错误页/空响应）
/** 分片持续吞吐下限（KB/s）：低于这个值意味着能开头、播不动，电视端照样卡 */
export const CHANNEL_PROBE_SEGMENT_MIN_KBPS = 100;
// 缓存过期（6 小时）：过期即重测，保证排序不会基于一周前的数据
export const CHANNEL_SPEED_TTL_MS = 6 * 60 * 60 * 1000; // 成功源的常规回测间隔
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

