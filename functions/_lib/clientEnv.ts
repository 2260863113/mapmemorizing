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

/** 去掉首尾空白；空串视为没有该头。 */
function trimOrNull(value: string | null): string | null {
  const text = value?.trim();
  return text ? text.slice(0, 64) : null;
}

/**
 * 取客户端 IP。
 *
 * `CF-Connecting-IP` 由 Cloudflare 平台注入、客户端无法伪造，是唯一直得信的来源；
 * 本地 `wrangler pages dev` 没有该头，退化为 `X-Forwarded-For` 第一段（经过多级代理时最左才是真实客户端）。
 */
export function clientIp(request: Request): string | null {
  const direct = trimOrNull(request.headers.get('cf-connecting-ip'));
  if (direct) return direct;
  const forwarded = request.headers.get('x-forwarded-for');
  return forwarded ? trimOrNull(forwarded.split(',')[0]) : null;
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
