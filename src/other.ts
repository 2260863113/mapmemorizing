/**
 * 「其他」档（他国一级行政区）的共享规则：虚拟 Unit 题池、判题匹配、作用域文案、语言选择存储。
 *
 * ## 为什么复用"虚拟 Unit"
 *
 * 与省级全国（34 个省 = 虚拟地级单位）、世界全国（195 国 = 虚拟 Unit）同一手法：
 * 把一级行政区建成 `Unit`，出题循环、顺序/BFS/错题、进度、标签、判题全部复用现有机制。
 * 本模块只负责"怎么把一国的元数据变成一个题池"和"什么样的输入算答对"。
 *
 * ## 判题：三种名字都算对，且**与当前语言无关**
 *
 * 一道题的名字有三种来源：中文名、当地语言名、英文（罗马字）名。用户可能在任何语言档下
 * 打出其中任意一种（中文用户在"外语"档下也未必打得出俄文；日语名带假名/汉字两种写法）。
 * 故判题**不看当前语言档**，三种都接受，并做轻量归一化：去空格与标点、忽略大小写与变音符号、
 * 剥掉通用行政后缀（州/省/县/府/道/自治区/共和国/边疆区/地区/область/край/州…）。
 *
 * ⚠ 归一化**只用于比对**，显示文本一律用原始名（`name` / `nameLocal`）—— 归一化后的
 * "加利福尼亚"不该出现在界面上。
 */
import type { OtherCountryCode, OtherCountryData, OtherUnitMeta, Unit } from './types';
import { otherUnitName, type OtherLang } from './map/layers';

/** 一国的题池变成虚拟 Unit（adcode = ISO 3166-2 编码；`name` 按当前语言档取）。 */
export function otherUnits(country: OtherCountryData, lang: OtherLang): Unit[] {
  return country.pool.map((u) => ({
    adcode: u.code,
    name: otherUnitName(u, lang),
    shortName: otherUnitName(u, lang),
    // `province` 字段用于 tooltip 的"所属"一行：他国一级行政区直接显示所属国家
    province: country.meta.name,
    provinceAdcode: country.meta.cc,
    center: u.center,
    neighbors: u.neighbors,
    decorative: false,
  }));
}

/** 通用行政后缀（中英日俄四语）：比对前剥掉，避免「阿尔伯塔」与「阿尔伯塔省」被判成不同答案。 */
const SUFFIXES = [
  // 中文
  '特别行政区', '自治区', '自治共和国', '自治州', '边疆区', '共和国', '自治省', '直辖市', '联邦市',
  '地区', '省', '州', '县', '府', '都', '道', '区', '市',
  // 英文
  'state', 'province', 'territory', 'district', 'region', 'republic', 'oblast', 'krai', 'okrug', 'autonomous',
  // 俄文（西里尔）
  'область', 'край', 'республика', 'автономный округ', 'автономная область', 'город',
  // 日文
  '県', '都', '府', '道',
];

/**
 * 比对用归一化（**不剥行政后缀**）：小写、去变音符号、去空白与标点。
 *
 * 变音符号用 NFD 分解后剔除组合字符（Québec → quebec、Ōita → oita、São → sao），
 * 这样"打不出长音符号/重音"的用户也能答对。
 */
export function looseKey(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[\s\-_.'’·,，。()（）]/g, '');
}

/**
 * 比对用归一化：在 `looseKey` 基础上**再剥掉行政后缀**。
 *
 * ⚠ 剥后缀会让不同的行政区撞成同一个键 —— 源数据里就有两对：
 *   `阿尔泰共和国` 与 `阿尔泰边疆区` 都剥成「阿尔泰」、`莫斯科` 与 `莫斯科州` 都剥成「莫斯科」。
 * 故归一化结果**不能单独作为判题依据**（会把「阿尔泰边疆区」判成阿尔泰共和国），
 * 它只是 `matchOtherUnit` 打分里的第二档：精确（不剥后缀）优先。
 */
export function normalizeOtherName(raw: string): string {
  let s = looseKey(raw);
  // 后缀剥离：反复剥（「阿尔泰共和国」→ 阿尔泰；「Республика Алтай」的前缀形式见下）
  let changed = true;
  while (changed && s.length > 2) {
    changed = false;
    for (const suf of SUFFIXES) {
      const n = looseKey(suf);
      if (s.length > n.length && s.endsWith(n)) {
        s = s.slice(0, -n.length);
        changed = true;
      }
    }
  }
  // 俄文的「Республика Алтай」是**前缀**式（共和国 + 名），剥掉前缀
  for (const pre of ['республика', 'respublika']) {
    if (s.startsWith(pre) && s.length > pre.length + 1) s = s.slice(pre.length);
  }
  return s;
}

/** 一个单位的全部可接受写法（原始名与归一化名都给出，便于"原始优先"的提示文案）。 */
export function acceptedNamesOf(u: OtherUnitMeta): string[] {
  return [u.name, u.nameLocal, u.nameEn].filter((v, i, a) => !!v && a.indexOf(v) === i);
}

/** 匹配分档：精确 > 归一化（剥后缀）> 前缀兜底。分越高越可信。 */
const SCORE_EXACT = 3;
const SCORE_NORMALIZED = 2;
const SCORE_PREFIX = 1;

/**
 * 判题：输入是否命中某个一级行政区（返回编码；未命中 null）。
 *
 * ## 为什么是"打分 + 决胜"而不是"归一化后查表"
 *
 * 剥掉行政后缀之后，源数据里有**两对**名字会撞车（`阿尔泰共和国`/`阿尔泰边疆区`、
 * `莫斯科`/`莫斯科州`）。若只做归一化相等，输入「阿尔泰边疆区」会命中排序更靠前的
 * 阿尔泰共和国 —— 用户明明答对却判错，而且不报错（由 `other.test.ts` 的全覆盖用例抓出）。
 * 故按可信度分三档，取最高分：
 *   1. **精确**：只做大小写/标点/变音符号归一化，不剥后缀（「Алтайский край」对「Алтайский край」）；
 *   2. **归一化**：剥掉行政后缀后相等（「加利福尼亚」对「加利福尼亚州」）；
 *   3. **前缀兜底**：`北卡` → `北卡罗来纳` 这类常见简写（要求输入至少 2 个字，避免单字乱命中）。
 *
 * 仍然并列时（例如只输入「阿尔泰」，两个阿尔泰都同分）：优先 `preferred`（**当前题目**的编码，
 * 由输入模式从 `NamingJudgeCtx.question` 传进来）—— 这既让"答对了核心名字"被判对，
 * 又不会把"别的行政区"判成正确。没有 `preferred` 时取第一个（题池按编码排序，结果稳定可复现）。
 */
export function matchOtherUnit(
  input: string,
  units: readonly OtherUnitMeta[],
  preferred: string | null = null,
): string | null {
  const loose = looseKey(input);
  if (!loose) return null;
  const key = normalizeOtherName(input);
  let best = 0;
  let hits: string[] = [];
  for (const u of units) {
    let score = 0;
    for (const name of acceptedNamesOf(u)) {
      if (looseKey(name) === loose) score = Math.max(score, SCORE_EXACT);
      else if (normalizeOtherName(name) === key) score = Math.max(score, SCORE_NORMALIZED);
    }
    if (!score && key.length >= 2) {
      const short = normalizeOtherName(u.name);
      if (short.length >= 2 && (short.startsWith(key) || key.startsWith(short))) score = SCORE_PREFIX;
    }
    if (score > best) {
      best = score;
      hits = [u.code];
    } else if (score === best && score > 0) {
      hits.push(u.code);
    }
  }
  if (!hits.length) return null;
  if (hits.length === 1) return hits[0];
  if (preferred && hits.includes(preferred)) return preferred;
  return hits[0];
}

// ==================== 语言选择的本地存储 ====================

const LANG_KEY_PREFIX = 'china-admin-other-lang:';
const COUNTRY_KEY_PREFIX = 'china-admin-other-country:';

/** 取值合法性 + 逐字段回落（与 `granularityStore` 同一手法：非法值一律回落默认，不抛错）。 */
export function loadOtherLang(modePrefix: string): OtherLang {
  try {
    return localStorage.getItem(LANG_KEY_PREFIX + modePrefix) === 'local' ? 'local' : 'zh';
  } catch {
    return 'zh';
  }
}

export function saveOtherLang(modePrefix: string, lang: OtherLang): void {
  try {
    localStorage.setItem(LANG_KEY_PREFIX + modePrefix, lang);
  } catch {
    /* 存不下不影响答题 */
  }
}

/**
 * 上次选的「其他」档国家（默认第一个：美国）。
 *
 * 为什么记住它：用户多半会连续几天练同一个国家，每次进来都从美国重新点一遍很烦。
 * 取值不在 index.json 里时回落默认 —— 数据里删了某个国家而本地还记着旧值时不会崩。
 */
export function loadOtherCountryChoice(modePrefix: string, available: readonly OtherCountryCode[]): OtherCountryCode {
  const fallback = available[0] ?? 'usa';
  try {
    const raw = localStorage.getItem(COUNTRY_KEY_PREFIX + modePrefix);
    return available.includes(raw as OtherCountryCode) ? (raw as OtherCountryCode) : fallback;
  } catch {
    return fallback;
  }
}

export function saveOtherCountryChoice(modePrefix: string, cc: OtherCountryCode): void {
  try {
    localStorage.setItem(COUNTRY_KEY_PREFIX + modePrefix, cc);
  } catch {
    /* 同上 */
  }
}

// ==================== 错题清单（纯练习：不进熟练度，但「错题」按钮要能用） ====================

const WRONG_KEY_PREFIX = 'china-admin-other-wrong:';

/**
 * 他国一级行政区的错题集合。
 *
 * ⚠ 用户口径是"纯练习：不计熟练度、不上排行榜"。但**「错题」分段按钮是输入/点击模式原有的功能**，
 * 若错一条都不记，那个按钮永远选出空池 —— 于是这里单独存一份**只服务于错题**的清单：
 * 它不进 `MemoryStore`（熟练度分析的三个分区都不受影响），也不参与任何成绩提交。
 * 换句话说："不计分"与"记得你错过"是两件事，用户要的是前者。
 */
export function loadOtherWrong(modePrefix: string): Set<string> {
  try {
    const raw = localStorage.getItem(WRONG_KEY_PREFIX + modePrefix);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(arr) ? arr.filter((v): v is string => typeof v === 'string') : []);
  } catch {
    return new Set();
  }
}

export function saveOtherWrong(modePrefix: string, codes: ReadonlySet<string>): void {
  try {
    localStorage.setItem(WRONG_KEY_PREFIX + modePrefix, JSON.stringify([...codes]));
  } catch {
    /* 同上 */
  }
}

// ==================== 作用域文案 ====================

/**
 * 开始卡片与游玩记录里的范围文案，如「美国 · 一级行政区」。
 *
 * 「一级行政区」这个说法与中国的「省级」对应（用户原话：对应中国的省级），
 * 但它对用户更陌生，故带上国家名（美国 · 一级行政区）而不是只写「其他」。
 */
export function otherScopeLabel(country: OtherCountryData): string {
  return `${country.meta.name} · 一级行政区`;
}
