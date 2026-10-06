/**
 * 爬虫 / 自动化客户端判定（**纯函数**：不碰 DB、不碰请求对象，可单测）。
 *
 * 为什么在服务端而不在前端：UA 与 IP 只有服务端拿得到（前端自报的 env 恰好是**可伪造**的那部分），
 * 而且"这条日志是不是爬虫"必须是**入库那一刻**的判定 —— 判定口径（关键词表、版本阈值）以后可以改，
 * 但历史日志不该跟着翻案，否则管理端每天的报表都在变。
 *
 * 判定全部基于**关键词与版本号**（需求口径：关键词匹配），不做行为分析/频率分析：
 *   · 关键词命中        → `keyword:<命中词>`（可多条）；
 *   · 无头浏览器特征    → `headless`（headlesschrome / headless / phantomjs）；
 *   · 自动化特征        → `automation`（puppeteer / playwright / selenium，或 `navigator.webdriver === true`）；
 *   · 浏览器版本过旧    → `old_browser`（低于阈值；App 内置外壳豁免，见 EMBEDDED_SHELLS）；
 *   · 境外 IP           → `overseas`（**只标注不判爬虫**：境外也有人）
 *
 * `bot` 与 `reasons` 的分工：`bot` 是"是否要打爬虫标"，`reasons` 是给前端本地化用的机器标签。
 * 故 `overseas` 单独出现时 `bot` 仍为 false，但标签照给 —— 管理端可以据此显示「境外」而不是「爬虫」。
 */

import type { ClientEnv } from './clientEnv';

/** 判定结果。 */
export interface BotVerdict {
  /** 是否疑似爬虫/自动化客户端（管理端据此决定是否打「爬虫」标）。 */
  bot: boolean;
  /** 机器标签（前端映射文案）：`overseas` / `headless` / `old_browser` / `automation` / `keyword:<词>`。 */
  reasons: string[];
  /** 是否境外 IP（= country 存在且不是 CN）。 */
  overseas: boolean;
}

/** 判定输入：三个信号都允许缺失（本地 dev 没有 cf、爬虫可能不发 UA）。 */
export interface ClientSignals {
  ua?: string | null;
  country?: string | null;
  env?: ClientEnv | null;
}

/**
 * 关键词表（比较前统一小写）。
 *
 * 选词依据是**生产库真实出现过的 UA**（HeadlessChrome / meta-externalagent / bingbot / Applebot /
 * 360Spider / WindowsPowerShell）+ 常见爬虫与 HTTP 客户端自报名。宁可覆盖宽一点：
 * 误判的代价是日志里多一个标签，漏判的代价是管理端看不出来。
 */
export const BOT_KEYWORDS: readonly string[] = [
  // 无头浏览器与自动化框架
  'headlesschrome',
  'headless',
  'phantomjs',
  'puppeteer',
  'playwright',
  'selenium',
  // 通用爬虫词与搜索引擎/PIM 爬虫
  'bot',
  'spider',
  'crawler',
  'crawl',
  'slurp',
  'applebot',
  'bingbot',
  'googlebot',
  'baiduspider',
  'yandex',
  'sogou',
  'bytespider',
  'facebookexternalhit',
  'meta-externalagent',
  'semrush',
  'ahrefs',
  'mj12bot',
  'dotbot',
  'petalbot',
  'gptbot',
  'claudebot',
  'ccbot',
  // 脚本/命令行 HTTP 客户端（真人浏览器不会这么报）
  'python-requests',
  'curl/',
  'wget',
  'go-http-client',
  'java/',
  'okhttp',
  'axios/',
  'node-fetch',
  'scrapy',
  'winhttp',
  'powershell',
  'libwww',
];

/** 归入 `headless` 标签的关键词。 */
const HEADLESS_KEYWORDS: readonly string[] = ['headlesschrome', 'headless', 'phantomjs'];

/** 归入 `automation` 标签的关键词（`navigator.webdriver` 也归这一档）。 */
const AUTOMATION_KEYWORDS: readonly string[] = ['puppeteer', 'playwright', 'selenium'];

/**
 * 内置浏览器外壳：**豁免版本过旧判定**。
 *
 * 它们的内嵌 Chromium 一定落后于系统浏览器（微信 XWEB 至今 Chrome/107、百度 App 里 Chrome/97），
 * 而这是外壳厂商的打包节奏，不是用户"不肯升级"。拿主版本低于 100 去判它们，等于把一大批真人标成爬虫。
 * 判据是 UA 里出现外壳 token —— 出现了就说明这是 App 内浏览，本身也不可能是关键词命中的爬虫。
 */
const EMBEDDED_SHELLS: readonly string[] = [
  'baiduboxapp',
  'micromessenger',
  'xweb',
  'bingsapphire',
  'ucbrowser',
  'qqbrowser',
  'baidubrowser',
  'qq/',
  'alipayclient',
  'dingtalk',
  'weibo',
  'heytapbrowser',
  'quark',
];

/**
 * 裸 `bot` 子串的已知误伤：CUBOT 手机的内置浏览器 UA 形如 `(Linux; Android 13; CUBOT X20 Pro)`，
 * 是真人。整词排除掉它，而不是把裸 `bot` 退化成"词首匹配" —— 后者会漏掉 FooBot / AhrefsBot
 * 这一类最常见的爬虫命名（它们本来就靠自己的关键词命中，这里是兜底）。
 */
const BENIGN_BOT_PARTS: readonly string[] = ['cubot'];

/**
 * 版本过旧判定：**按浏览器家族取第一个能解析出版本的规则**，命中即返回。
 *
 * 顺序即优先级（Edg/OPR 的 UA 里也含 `Chrome/`，先匹配外壳版本才不会拿内嵌 Chromium 的主版本
 * 去比错家族）。阈值取 `min`：Chrome/Edg/OPR/Firefox < 100、Safari < 14 —— 都对应 2021-2022 年
 * 之前的版本，站点（ES2020 打包 + 现代 CSS）在这些浏览器上本来也跑不顺。
 */
const BROWSER_RULES: ReadonlyArray<{ pattern: RegExp; min: number }> = [
  { pattern: /edg(?:e|ios|a)?\/(\d+)/, min: 100 },
  { pattern: /opr\/(\d+)/, min: 100 },
  { pattern: /(?:chrome|crios)\/(\d+)/, min: 100 },
  { pattern: /(?:firefox|fxios)\/(\d+)/, min: 100 },
  // Safari 的版本只在 `Version/x.y` 里（`Safari/605.1.15` 是 WebKit 版本，不能拿来比）
  { pattern: /version\/(\d+)[\d.]*\s+(?:mobile\/\w+\s+)?safari\//, min: 14 },
];

/** 单个关键词是否命中（小写 UA 上比较）。 */
function hitKeyword(ua: string, keyword: string): boolean {
  if (!ua.includes(keyword)) return false;
  return !(keyword === 'bot' && BENIGN_BOT_PARTS.some((part) => ua.includes(part)));
}

/** UA 是否属于已知的内置浏览器外壳。 */
function isEmbeddedShell(ua: string): boolean {
  return EMBEDDED_SHELLS.some((shell) => ua.includes(shell));
}

/** 浏览器主版本是否过旧。解析不出家族/版本时返回 false —— 宁可漏判，也不误杀。 */
function isOldBrowser(ua: string): boolean {
  for (const rule of BROWSER_RULES) {
    const matched = rule.pattern.exec(ua);
    if (!matched) continue;
    const major = Number(matched[1]);
    return Number.isFinite(major) && major < rule.min;
  }
  return false;
}

/**
 * 判定一个客户端。
 *
 * `ua` 大小写不敏感（关键词都是小写；先整体小写，避免每处都写 `/i`）。
 * `country` 只在**存在且非 CN** 时算境外：本地 dev 与 D1 里没有 cf 的地理信息时都是 null，
 * 那不是"境外"，只是"不知道"。
 */
export function classifyClient(signals: ClientSignals): BotVerdict {
  const ua = typeof signals.ua === 'string' ? signals.ua.toLowerCase() : '';
  const country = typeof signals.country === 'string' ? signals.country.trim().toUpperCase() : '';

  const overseas = country !== '' && country !== 'CN';
  const reasons: string[] = [];
  if (overseas) reasons.push('overseas');

  const hits = BOT_KEYWORDS.filter((keyword) => hitKeyword(ua, keyword));
  for (const keyword of hits) reasons.push(`keyword:${keyword}`);

  if (hits.some((keyword) => HEADLESS_KEYWORDS.includes(keyword))) reasons.push('headless');

  const webdriver = signals.env?.webdriver === true;
  const automation = webdriver || hits.some((keyword) => AUTOMATION_KEYWORDS.includes(keyword));
  if (automation) reasons.push('automation');

  const oldBrowser = !isEmbeddedShell(ua) && isOldBrowser(ua);
  if (oldBrowser) reasons.push('old_browser');

  // 爬虫标只看「爬虫/自动化/浏览器异常」三类信号；overseas 单独出现时不算爬虫（见文件头）
  return { bot: hits.length > 0 || automation || oldBrowser, reasons, overseas };
}
