/**
 * 浏览器环境快照（访问 / 游玩上报用）。
 *
 * 为什么单独成模块：`/api/visit` 与 `/api/play` 都要把「这台设备到底长什么样」带给服务端，
 * 而服务端只能拿到 User-Agent 这一个请求头 —— UA 可以被任意伪造，也不含屏幕/时区/核心数等
 * 只有浏览器运行时才知道的事实。管理端「日志记录」要求**显示完整的浏览器环境**并据此判定
 * 爬虫，所以这里把 `navigator` / `screen` / `Intl` 的可用读数收成一个扁平对象。
 *
 * 三条约定：
 *   1. **永不抛错**：任何一项读不到就省略它 —— 采集失败不该让上报（甚至页面）出错；
 *   2. **不采集隐私**：只取设备能力与区域设置，不取 URL、不取 referrer、不做指纹哈希；
 *   3. **字段即契约**：键名与 `functions/_lib/clientEnv.ts` 的 `sanitizeClientEnv()` 白名单
 *      逐字对应（`src/` 与 `functions/` 是两套 tsconfig，不能跨目录 import，故各写一半、
 *      由两侧测试与注释互指）。
 */
export interface ClientEnv {
  /** `navigator.platform`（如 Win32 / MacIntel）。 */
  platform?: string;
  /** 首选语言（`navigator.language`）。 */
  language?: string;
  /** 语言列表（逗号连接）。 */
  languages?: string;
  /** IANA 时区（如 Asia/Shanghai）。 */
  timezone?: string;
  /** 屏幕分辨率 `宽x高`。 */
  screen?: string;
  /** 视口尺寸 `宽x高`。 */
  viewport?: string;
  /** 设备像素比。 */
  dpr?: number;
  /** 逻辑核心数。 */
  cores?: number;
  /** 设备内存（GB，仅 Chromium 系提供）。 */
  memory?: number;
  /** 触控点数。 */
  touch?: number;
  /** `navigator.webdriver`：自动化/无头浏览器的标准标记。 */
  webdriver?: boolean;
  /** `navigator.vendor`。 */
  vendor?: string;
  /** 是否启用 Cookie。 */
  cookie?: boolean;
}

/** 安全读一个字符串读数：读不到、空、非字符串一律 undefined。 */
function readString(read: () => unknown, max = 120): string | undefined {
  try {
    const v = read();
    if (typeof v !== 'string') return undefined;
    const s = v.trim();
    return s ? s.slice(0, max) : undefined;
  } catch {
    return undefined;
  }
}

/** 安全读一个数字读数：非有限数一律 undefined。 */
function readNumber(read: () => unknown, max = 1e9): number | undefined {
  try {
    const v = read();
    return typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= max ? v : undefined;
  } catch {
    return undefined;
  }
}

/** 安全读一个布尔读数。 */
function readBool(read: () => unknown): boolean | undefined {
  try {
    const v = read();
    return typeof v === 'boolean' ? v : undefined;
  } catch {
    return undefined;
  }
}

/** 采集当前浏览器环境快照。**永不抛错**；读不到的字段直接省略。 */
export function collectClientEnv(): ClientEnv {
  const nav = typeof navigator === 'undefined' ? undefined : navigator;
  const scr = typeof screen === 'undefined' ? undefined : screen;
  const win = typeof window === 'undefined' ? undefined : window;
  const env: ClientEnv = {
    platform: nav ? readString(() => nav.platform, 40) : undefined,
    language: nav ? readString(() => nav.language, 40) : undefined,
    languages: nav ? readString(() => (nav.languages ?? []).join(','), 120) : undefined,
    timezone: readString(() => Intl.DateTimeFormat().resolvedOptions().timeZone, 60),
    screen: scr ? readString(() => `${scr.width}x${scr.height}`, 20) : undefined,
    viewport: win ? readString(() => `${win.innerWidth}x${win.innerHeight}`, 20) : undefined,
    dpr: win ? readNumber(() => win.devicePixelRatio, 100) : undefined,
    cores: nav ? readNumber(() => nav.hardwareConcurrency, 1024) : undefined,
    memory: nav ? readNumber(() => (nav as Navigator & { deviceMemory?: number }).deviceMemory, 1024) : undefined,
    touch: nav ? readNumber(() => nav.maxTouchPoints, 1024) : undefined,
    webdriver: nav ? readBool(() => (nav as Navigator & { webdriver?: boolean }).webdriver) : undefined,
    vendor: nav ? readString(() => nav.vendor, 60) : undefined,
    cookie: nav ? readBool(() => nav.cookieEnabled) : undefined,
  };
  // 去掉 undefined 的键，保证上报体紧凑、也让后端白名单过滤前的形状稳定
  for (const key of Object.keys(env) as (keyof ClientEnv)[]) {
    if (env[key] === undefined) delete env[key];
  }
  return env;
}
