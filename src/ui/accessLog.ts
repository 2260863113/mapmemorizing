/**
 * 管理端「日志记录 / 游玩统计」两个列表的**纯格式化逻辑**：爬虫判定标签的本地化、IP 与地理标签、
 * 完整 UA、可展开的环境详情行、游玩来源与模式名。
 *
 * 为什么单独成模块（而不是塞进 `adminPanel.ts`）：
 *   1. 这些全是「错了也看不出来」的映射 —— 机器标签少映射一条就少显示一个判定理由、IP 与城市
 *      拼接顺序错了看着照样像正常数据。而它们不需要 DOM、不需要 fetch，正是最该单测的那一类；
 *   2. `adminPanel.ts` import 了 echarts 与 ECharts 实例逻辑，放进那里就再也测不动了。
 *
 * 两条口径约定：
 *   · **服务端给机器标签，前端做本地化**（`botReasons` 是 `overseas` / `keyword:xxx` 这类标签）：
 *     判定口径要能对着日志改，界面文案要能对着文案表改，两者混在一起就会互相绊住；
 *     且**未知标签一律原样显示**，不能因为前端表旧了就把判定信息丢掉。
 *   · **数据缺失给占位**（`MISSING`），不显示 `undefined`、也不猜一个默认值。
 */
import type { AccessLogEntry, ClientEnv, PlayLogEntry } from '../api';
import { t, type MessagesKey } from '../i18n';
import { modeSpec, modeTitle } from '../modes/capabilities';
import type { Mode } from '../types';

/** 缺数据时的统一占位（IP / 环境 / 模式都可能缺，避免各处写不同的破折号）。 */
export const MISSING = '—';

// ==================== 爬虫判定标签 ====================

/**
 * 机器标签 → 文案键（与 `functions/_lib/botDetect.ts` 的取值逐字对应）。
 * 只列**服务端会产出的固定标签**；`keyword:<命中词>` 是带参形式，单独处理。
 */
const BOT_REASON_KEYS: Record<string, MessagesKey> = {
  overseas: 'admin.botReasonOverseas',
  headless: 'admin.botReasonHeadless',
  old_browser: 'admin.botReasonOldBrowser',
  automation: 'admin.botReasonAutomation',
};

/**
 * 单个判定标签 → 中文文案。
 * 未知标签原样返回（不返回空串）：宁可显示一个没翻译的机器标签，也不能让管理员看不到判定理由。
 */
export function botReasonLabel(reason: string | null | undefined): string {
  const raw = (reason ?? '').trim();
  if (!raw) return '';
  if (raw.startsWith('keyword:')) {
    const keyword = raw.slice('keyword:'.length).trim();
    // 关键词为空的脏标签退化成原样显示，不要渲染成「关键词 」
    return keyword ? t('admin.botReasonKeyword', { keyword }) : raw;
  }
  const key = BOT_REASON_KEYS[raw];
  return key ? t(key) : raw;
}

/** 全部判定标签 → 文案数组（空标签被丢弃）。 */
export function botReasonLabels(reasons: readonly string[] | null | undefined): string[] {
  return (reasons ?? []).map((r) => botReasonLabel(r)).filter((s) => s !== '');
}

/**
 * 这一行是否要打「爬虫」徽标。
 *
 * `bot` 是服务端的结论，`botReasons` 是结论的依据：两者任一有内容就展示 ——
 * 只信 `bot` 会让「服务端标了理由却忘了置位」的记录静默丢掉判定信息。
 */
export function isBotEntry(entry: Pick<AccessLogEntry, 'bot' | 'botReasons'> | null | undefined): boolean {
  if (!entry) return false;
  return entry.bot === true || botReasonLabels(entry.botReasons).length > 0;
}

// ==================== 用户 ====================

/**
 * 日志用户名单元格里的文字。
 *
 * 口径（2026-09 二次确认 + 2026-10 需求 3）：未登录的访问**当且仅当存在爬虫判定理由**时显示
 * 「爬虫」，否则显示「游客」；两者都拼上**4 位游客编号**（如「游客1234」），用于区分不同游客。
 *
 * 为什么不是「未登录即爬虫」：那是更早一版的粗口径，会把真人游客一起标成爬虫 —— 管理端看到的
 * 「爬虫数」于是等于「未登录数」，判定标签也就失去了意义。现在标签与判定严格同源：
 * 有依据才是爬虫（`isBotEntry`：结论 `bot` 或依据 `botReasons` 任一成立）。
 */
export function logUserName(
  entry: (Pick<AccessLogEntry, 'username' | 'bot' | 'botReasons'> & { visitor?: string | null }) | null | undefined,
): string {
  const name = (entry?.username ?? '').trim();
  if (name) return name;
  return visitorLabel(isBotEntry(entry), entry?.visitor);
}

/**
 * 该行的用户名单元格是否落在「爬虫」上（= 未登录 **且** 有判定依据）。
 *
 * 渲染层需要它而不是去比较文案：落在「爬虫」时单元格要换成 `.log-bot` 徽标，并且
 * 标签行里**不再重复**画一遍同样的徽标（同一行出现两个「爬虫」只会让人以为有两条记录）。
 */
export function showsBotLabel(
  entry: Pick<AccessLogEntry, 'username' | 'bot' | 'botReasons'> | null | undefined,
): boolean {
  return isAnonymous(entry?.username) && isBotEntry(entry);
}

/** 是否匿名（匿名行才需要在「爬虫」与「游客」之间二选一）。 */
export function isAnonymous(username: string | null | undefined): boolean {
  return (username ?? '').trim() === '';
}

/**
 * 未登录访客的展示名：词根（爬虫 / 游客）+ **4 位游客编号**（2026-10 需求 3）。
 *
 * 编号来自 `src/visitorId.ts`（同一个浏览器长期不变）；缺编号时只给词根 ——
 * 不猜一个号：假号会把两个不同的人显示成同一个人，比没有号更误导。
 * 「爬虫还是游客」由**判定结果**决定（见 `isBotEntry`），与编号是两件正交的事。
 */
export function visitorLabel(bot: boolean, id: string | null | undefined): string {
  const word = t(bot ? 'admin.botLabel' : 'admin.guest');
  const num = (id ?? '').trim();
  return num ? `${word}${num}` : word;
}

// ==================== IP / 地理 / UA ====================

/**
 * IP + 地理标签：`1.2.3.4 · 美国 · 加州 · 洛杉矶`；IP 缺失时用占位，地理全部缺失时只剩 IP。
 * 为什么要连地理一起显示：境外 IP 是爬虫判定的一部分，管理员需要一眼看到"这条为什么被判定"。
 */
export function formatIpCell(entry: Pick<AccessLogEntry, 'ip' | 'country' | 'region' | 'city'> | null | undefined): string {
  const ip = (entry?.ip ?? '').trim() || MISSING;
  const geo = [entry?.country, entry?.region, entry?.city]
    .map((s) => (s ?? '').trim())
    .filter((s) => s !== '');
  // Cloudflare 的 region / city 偶尔同名（直辖市、城邦），去重后不至于显示成「上海 · 上海」
  const parts = [ip, ...Array.from(new Set(geo))];
  return parts.join(' · ');
}

/** 完整 UA（**不截断**：需求就是显示完整的浏览器环境）；空 UA 给占位文案。 */
export function formatUa(ua: string | null | undefined): string {
  return (ua ?? '').trim() || t('admin.noUa');
}

// ==================== 浏览器环境详情 ====================

/** 环境详情的一行：标签文案键 + 已拼好的值（值本身是原始读数，不需要再本地化）。 */
export interface EnvRow {
  key: MessagesKey;
  value: string;
}

/** 字符串读数：非空才要。 */
function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 环境快照 → 可展开详情里的若干行。
 *
 * 三处**故意合并**（避免为了一格数字新增文案键）：
 *   · `screen` 与 `dpr` 合成一行（`1920x1080 @2x`）—— 分辨率脱离像素比没有意义；
 *   · `language` 与 `languages` 合成一行（`zh-CN (zh-CN,zh,en)`）—— 首选语言与列表本就是一件事；
 *   · `webdriver` / `cookie` 用布尔原值（`true` / `false`）显示。
 * `webdriver` 只在为 `true` 时出一行：它是自动化客户端的标准标记，给正常用户每行都渲染
 * "WebDriver false" 只会淹没真正可疑的记录。
 */
export function clientEnvRows(env: ClientEnv | null | undefined): EnvRow[] {
  if (!env) return [];
  const rows: EnvRow[] = [];
  const push = (key: MessagesKey, value: string) => {
    if (value) rows.push({ key, value });
  };

  push('admin.envPlatform', str(env.platform));

  const language = str(env.language);
  const languages = str(env.languages);
  push('admin.envLang', languages && languages !== language ? `${language} (${languages})` : language || languages);
  push('admin.envTz', str(env.timezone));

  const screen = str(env.screen);
  const dpr = typeof env.dpr === 'number' && Number.isFinite(env.dpr) ? `@${env.dpr}x` : '';
  push('admin.envScreen', [screen, dpr].filter(Boolean).join(' '));
  push('admin.envViewport', str(env.viewport));

  if (typeof env.cores === 'number' && Number.isFinite(env.cores)) push('admin.envCores', String(env.cores));
  if (typeof env.memory === 'number' && Number.isFinite(env.memory)) push('admin.envMemory', `${env.memory} GB`);
  if (typeof env.touch === 'number' && Number.isFinite(env.touch)) push('admin.envTouch', String(env.touch));
  push('admin.envVendor', str(env.vendor));

  if (env.webdriver === true) push('admin.envWebdriver', String(env.webdriver));
  if (typeof env.cookie === 'boolean') push('admin.envCookie', String(env.cookie));
  return rows;
}

// ==================== 游玩统计 ====================

/**
 * 游玩来源 → 文案（`start` 点开始按钮、`tab` 按 Tab 快速重置并立即开始）。
 * 未知来源原样显示：前后端版本不一致时，宁可显示机器值也不显示空白。
 */
export function playSourceLabel(source: PlayLogEntry['source'] | string | null | undefined): string {
  const raw = (source ?? '').trim();
  if (raw === 'start') return t('admin.playSourceStart');
  if (raw === 'tab') return t('admin.playSourceTab');
  return raw || MISSING;
}

/**
 * 游玩条目的用户名（2026-10 需求 5：**不再写「未登录」**）。
 *
 * 未登录显示「游客1234」/「爬虫1234」，与日志列表同一套口径（`visitorLabel`）——
 * 用户明确要求两处都用编号区分人；登录用户当然还是显示用户名。
 */
export function playUserName(
  entry: Pick<PlayLogEntry, 'username' | 'bot'> & { visitor?: string | null } | null | undefined,
): string {
  const name = (entry?.username ?? '').trim();
  if (name) return name;
  return visitorLabel(entry?.bot === true, entry?.visitor);
}

/**
 * 游玩条目的**出题范围**（2026-10 需求 5）。
 *
 * 优先用服务端记下的展示名（如「世界」「省级全国」「广东省」），老行没有展示名时退化成原始标识
 * （哨兵/adcode，至少还能看出是哪个范围），两者都缺才给占位。
 */
export function playScopeLabel(
  entry: Pick<PlayLogEntry, 'scopeLabel' | 'scopeProvince'> | null | undefined,
): string {
  const label = (entry?.scopeLabel ?? '').trim();
  if (label) return label;
  const raw = (entry?.scopeProvince ?? '').trim();
  return raw || MISSING;
}

/**
 * 模式 id → 模式名。
 * **复用 `modes/capabilities.ts` 的 `modeTitle()`**：模式名的唯一来源在那里（模式 tab、设置浮层、
 * 排行榜标题都读它），这里再写一份映射迟早与它漂移。未知模式原样显示（服务端白名单可能比前端表新）。
 */
export function playModeLabel(mode: string | null | undefined): string {
  const raw = (mode ?? '').trim();
  if (!raw) return MISSING;
  return modeSpec(raw as Mode) ? modeTitle(raw as Mode) : raw;
}
