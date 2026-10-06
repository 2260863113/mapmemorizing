/**
 * 上报环境的**服务端**侧处理：① 把客户端自报的浏览器环境收窄成白名单形状；② 从请求侧取 IP 与地理信息。
 *
 * 为什么需要（与 `src/clientEnv.ts` 成对）：`src/` 与 `functions/` 是两套 tsconfig，跨目录 import 会把
 * 前端代码打进 Worker，所以「采集」（前端）与「校验」（这里）各写一半、由两侧注释互指 —— 字段名逐字对应。
 *
 * 为什么服务端还要再洗一遍：采集只是**尽力而为**，请求体是任何客户端都能改的。一条 100KB 的
 * `language` 会原样进 D1 并在管理端渲染；管理端要的是"这台设备长什么样"，不是客户端想让我们存什么。
 * 故这里只认白名单字段、逐字段截断/夹取，整体超限就整条丢弃 —— 存"半条环境"比不存更容易让人误读。
 *
 * 三条约定：
 *   1. **绝不抛错**：这是访问上报的旁路，脏数据只该导致"这条环境没记下"，不该 500（连抛错的 getter 也不行）；
 *   2. **白名单**：未知键一律丢弃，键名与 `src/clientEnv.ts` 的 `ClientEnv` 逐字对应；
 *   3. **上限**：字符串按字段截断、数值夹取、整体 JSON > `MAX_ENV_JSON_LEN` 直接拒绝（见下）。
 */

/**
 * 浏览器环境快照（与 `src/clientEnv.ts` 的 `ClientEnv` 逐字对应，改动必须两侧同步）。
 * 全字段可选：客户端读不到的项就不报，管理端把缺失显示为「未知」。
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

/**
 * 整条环境快照的 JSON 体积上限（字符）。取 2000 是按**最坏合法载荷**定的：各字段都恰好顶到下面
 * 的单字段上限、再加 JSON 语法开销，也只有 700 字符左右；给 3 倍余量是留字段扩展空间。
 * 超过它的请求体不再是"浏览器环境"，而是有人往里塞垃圾。
 */
export const MAX_ENV_JSON_LEN = 2000;

/** 字符串字段的单字段上限（与 `src/clientEnv.ts` 采集时的 `readString` 上限一致，多出来的直接截断）。 */
const STRING_CAPS: Readonly<Record<string, number>> = {
  platform: 40,
  language: 40,
  languages: 120,
  timezone: 60,
  screen: 20,
  viewport: 20,
  vendor: 60,
};

/** 计数字段的夹取上限（与 `src/clientEnv.ts` 的 `readNumber` 上限一致）。 */
const COUNT_CAPS: Readonly<Record<string, number>> = {
  cores: 1024,
  memory: 1024,
  touch: 1024,
};

/** 设备像素比上限（8K 屏 + 浏览器缩放也不会超过它）。 */
const DPR_MAX = 100;

/** 读一个字段：包一层 try —— 恶意/异常对象可以带抛错的 getter，读它不该把上报打挂。 */
function readField(source: object, key: string): unknown {
  try {
    return (source as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/** 字符串读数：非字符串/空白丢弃；超长**截断**而不是丢弃（字段本身合法，只是客户端多报了）。 */
function cleanString(value: unknown, cap: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text ? text.slice(0, cap) : undefined;
}

/** 整数计数：非有限数、负数、超上限一律丢弃，其余向下取整（核心数没有小数的语义）。 */
function cleanCount(value: unknown, cap: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const n = Math.floor(value);
  return n >= 0 && n <= cap ? n : undefined;
}

/** 设备像素比：0/负数/超上限丢弃，**保留小数**（2.625 这类缩放比是真实读数）。 */
function cleanDpr(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return value > 0 && value <= DPR_MAX ? value : undefined;
}

/** 布尔读数：`false` 是有效值（"未开启 Cookie"也是环境事实），只有类型不符才丢。 */
function readBool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/** 序列化长度；循环引用/BigInt 等 JSON.stringify 会抛的输入按"超限"处理（丢弃，而不是抛出去）。 */
function serializedLength(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * 白名单化客户端环境快照。**永不抛错**；无法使用（非对象 / 空 / 超限）时返回 `null`。
 *
 * 返回 `null` 而不是 `{}`：调用方据此把 `env` 列写 NULL，管理端显示「未上报环境」时不必再区分
 * "空对象"与"没报"这两种同义状态。
 */
export function sanitizeClientEnv(raw: unknown): ClientEnv | null {
  // 数组也是 object，但它不是环境快照（防御 JSON 数组塞进来的情况）
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (serializedLength(raw) > MAX_ENV_JSON_LEN) return null;

  const out: ClientEnv = {
    platform: cleanString(readField(raw, 'platform'), STRING_CAPS.platform),
    language: cleanString(readField(raw, 'language'), STRING_CAPS.language),
    languages: cleanString(readField(raw, 'languages'), STRING_CAPS.languages),
    timezone: cleanString(readField(raw, 'timezone'), STRING_CAPS.timezone),
    screen: cleanString(readField(raw, 'screen'), STRING_CAPS.screen),
    viewport: cleanString(readField(raw, 'viewport'), STRING_CAPS.viewport),
    dpr: cleanDpr(readField(raw, 'dpr')),
    cores: cleanCount(readField(raw, 'cores'), COUNT_CAPS.cores),
    memory: cleanCount(readField(raw, 'memory'), COUNT_CAPS.memory),
    touch: cleanCount(readField(raw, 'touch'), COUNT_CAPS.touch),
    webdriver: readBool(readField(raw, 'webdriver')),
    vendor: cleanString(readField(raw, 'vendor'), STRING_CAPS.vendor),
    cookie: readBool(readField(raw, 'cookie')),
  };
  // 去掉 undefined 的键：与前端采集端一样保持形状紧凑（存进 D1 的就是最终显示的那份）
  for (const key of Object.keys(out) as (keyof ClientEnv)[]) {
    if (out[key] === undefined) delete out[key];
  }
  return Object.keys(out).length ? out : null;
}

/** 点分四段 IPv4（每段 ≤255）。 */
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isIpv4(text: string): boolean {
  const m = IPV4_RE.exec(text);
  return !!m && m.slice(1).every((part) => Number(part) <= 255);
}

/** 宽松的 IPv6 形状：只允许十六进制与冒号、至少两个冒号组、长度不超 45。 */
function isIpv6(text: string): boolean {
  return text.length <= 45 && text.includes(':') && /^[0-9a-fA-F:.]+$/.test(text);
}

/**
 * 归一化一个 IP 候选：剥掉端口/方括号，并把 **IPv4-mapped IPv6**（`::ffff:1.2.3.4`）折回点分四段。
 *
 * 为什么要把 mapped 形式当 IPv4：双栈客户端在本机走 `::ffff:` 是常态，管理端看到一串
 * `::ffff:114.255.147.61` 既读不懂也没法按 IPv4 排序/比对；折回后它就是同一个地址。
 */
export function normalizeIp(raw: string | null | undefined): { ip: string; v4: boolean } | null {
  let text = (raw ?? '').trim();
  if (!text) return null;
  // `[2001:db8::1]:443` → `2001:db8::1`
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(text);
  if (bracketed) text = bracketed[1];
  // `1.2.3.4:5678` → `1.2.3.4`（只在剩余部分确实是 IPv4 时才剥，避免把裸 IPv6 的末段当端口切掉）
  const withPort = /^([^:]+):(\d+)$/.exec(text);
  if (withPort && isIpv4(withPort[1])) text = withPort[1];
  // `::ffff:1.2.3.4` → `1.2.3.4`
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(text);
  if (mapped) text = mapped[1];

  if (isIpv4(text)) return { ip: text, v4: true };
  if (isIpv6(text)) return { ip: text.toLowerCase(), v4: false };
  return null;
}

/**
 * 取客户端 IP，**优先 IPv4**（2026-10 用户口径：日志里出现 IPv6 时希望看到 IPv4）。
 *
 * 取值顺序（越靠前越可信）：
 *   1. `CF-Connecting-IP` 是 IPv4 → 直接用它（平台注入，客户端无法伪造）；
 *   2. `CF-Pseudo-IPv4` → 用它。这是 Cloudflare 给**纯 IPv6 客户端**合成的 IPv4
 *      （需在 Cloudflare 控制台 Network → Pseudo IPv4 里选「Add header」；未开启时该头不存在）；
 *   3. `CF-Connecting-IP` 是 IPv6 且上面两步都拿不到 IPv4 → 只能记 IPv6（比丢地址强）；
 *   4. 没有 CF 头（本地 `wrangler pages dev`）→ 从 `X-Forwarded-For`（取最左段，多级代理下那才是真实客户端）、
 *      `X-Real-IP` 里按「先 IPv4 后 IPv6」挑一个。
 *
 * ⚠ 为什么第 4 步**不**在 CF 头存在时也参与：`X-Forwarded-For` 是**客户端可以自己带**的头。
 * 若为了"凑一个 IPv4"去读它，任何人加一行 `X-Forwarded-For: 1.2.3.4` 就能把日志里的地址改掉。
 * 所以"优先 IPv4"只在**平台可信来源**之间取舍，绝不为此降级去信任客户端自报的头。
 */
export function clientIp(request: Request): string | null {
  const direct = normalizeIp(request.headers.get('cf-connecting-ip'));
  if (direct?.v4) return direct.ip;

  const pseudo = normalizeIp(request.headers.get('cf-pseudo-ipv4'));
  if (pseudo?.v4) return pseudo.ip;

  if (direct) return direct.ip;

  const forwarded = request.headers.get('x-forwarded-for');
  const candidates: (string | null | undefined)[] = [
    forwarded ? forwarded.split(',')[0] : null,
    request.headers.get('x-real-ip'),
  ];
  const parsed = candidates.map((raw) => normalizeIp(raw)).filter((ip): ip is { ip: string; v4: boolean } => ip !== null);
  return (parsed.find((ip) => ip.v4) ?? parsed[0])?.ip ?? null;
}

/**
 * 游客编号（4 位数字，如 `1234`）。
 *
 * 由前端在 `localStorage` 里生成并长期保持不变（同一个浏览器每次访问都是同一个号），
 * 服务端只做**形状校验**：不是恰好 4 位数字就当没报（`null`）。
 *
 * 为什么不在这里"兜底生成"一个：那样每次请求都会得到不同的号，反而把同一个游客记成几十个人；
 * 拿不到号时管理端退化为显示「游客」/「爬虫」，比一个假号诚实。
 */
export function sanitizeVisitorId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  return /^\d{4}$/.test(text) ? text : null;
}

/** 地理信息：`request.cf` 在生产由 Cloudflare 注入，本地 dev 为 undefined，故全程按未知类型防御。 */
export interface RequestGeo {
  country: string | null;
  region: string | null;
  city: string | null;
}

/** 取请求侧地理信息；缺字段/非字符串一律 null。 */
export function requestGeo(request: Request): RequestGeo {
  const cf = request.cf;
  return {
    country: cfString(cf, 'country'),
    region: cfString(cf, 'region'),
    city: cfString(cf, 'city'),
  };
}

/**
 * 从 `request.cf` 读一个字符串字段。
 *
 * 入参声明为 `unknown`：`cf` 在 workers-types 里是 `IncomingRequestCfProperties | RequestInitCfProperties`
 * 的联合，直接点属性在类型上就不成立；而且本地 dev 下它根本不存在。
 */
function cfString(cf: unknown, key: string): string | null {
  if (!cf || typeof cf !== 'object') return null;
  const value = (cf as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
