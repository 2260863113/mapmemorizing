import type { AppData, Continent, Province, SubregionId, Unit } from './types';
import { CONTINENTS, SUBREGION_IDS } from './types';
import { normalizeProvince } from './matcher';
import abbrRules from './province-abbr.json';

/**
 * 省级粒度（省级全国练习 / 省名熟练度分析）与粒度共用常量的共享数据与规则。
 *
 * 省级单元 = data.provinces 的 34 个省级行政单元（含港澳台；南海诸岛装饰面不属于 provinces 表）。
 * 省级答题与地级市熟练度完全隔离：对/错只计入省级熟练度（见 MemoryStore 的省记录）。
 */

/** 排行榜/结算中“省级全国”作用域的哨兵值：区别于市级全国（scopeProvince=null）与某省地级榜（6 位 adcode）。 */
export const PROVINCE_NATION_SCOPE = '__province_nation__';
/** 排行榜/结算中“世界全国”作用域的哨兵值：区别于市级全国（null）与省级全国（__province_nation__）。 */
export const WORLD_NATION_SCOPE = '__world_nation__';
/** 大洲榜哨兵前缀（后接大洲 id，如 __continent_AS__）：世界粒度下钻某洲时的独立榜作用域。 */
export const CONTINENT_SCOPE_PREFIX = '__continent_';
/** 大洲榜哨兵（如 AS → '__continent_AS__'）。 */
export function continentScope(c: Continent): string {
  return `${CONTINENT_SCOPE_PREFIX}${c}__`;
}
/** 从 scope 值解析大洲（非大洲榜返回 null）。 */
export function continentFromScope(scope: string | null): Continent | null {
  if (!scope || !scope.startsWith(CONTINENT_SCOPE_PREFIX) || !scope.endsWith('__')) return null;
  const id = scope.slice(CONTINENT_SCOPE_PREFIX.length, -2);
  return CONTINENTS.some((c) => c.id === id) ? (id as Continent) : null;
}
/** 次区域榜哨兵前缀（后接次区域 id，如 __subregion_EAS__）：世界粒度下钻某次区域时的独立榜作用域。 */
export const SUBREGION_SCOPE_PREFIX = '__subregion_';
/** 次区域榜哨兵（如 EAS → '__subregion_EAS__'）。 */
export function subregionScope(s: SubregionId): string {
  return `${SUBREGION_SCOPE_PREFIX}${s}__`;
}
/**
 * 从 scope 值解析次区域（非次区域榜返回 null）。
 * 注意前缀与 CONTINENT_SCOPE_PREFIX 互不为前缀（'__subregion_' vs '__continent_'），
 * 但两者都以 '__' 结尾，故必须先判前缀再切后缀。
 */
export function subregionFromScope(scope: string | null): SubregionId | null {
  if (!scope || !scope.startsWith(SUBREGION_SCOPE_PREFIX) || !scope.endsWith('__')) return null;
  const id = scope.slice(SUBREGION_SCOPE_PREFIX.length, -2);
  return SUBREGION_IDS.includes(id as SubregionId) ? (id as SubregionId) : null;
}
/** 是否任意「世界范围」榜作用域（世界全国 / 大洲 / 次区域）。 */
export function isWorldScope(scope: string | null | undefined): boolean {
  if (scope === undefined) return false;
  return scope === WORLD_NATION_SCOPE || continentFromScope(scope) !== null || subregionFromScope(scope) !== null;
}

/** 是否任意「全国/大洲/次区域」级作用域（不含某省地级榜）。 */
export function isNationLikeScope(scope: string | null | undefined): boolean {
  if (scope === undefined) return false;
  return (
    scope === null ||
    scope === PROVINCE_NATION_SCOPE ||
    scope === WORLD_NATION_SCOPE ||
    continentFromScope(scope) !== null ||
    subregionFromScope(scope) !== null
  );
}

/** 测验/分析粒度：省级全国（省名）/ 市级全国或单省（地级市）/ 世界全国（国家名）。 */
export type Granularity = 'province' | 'city' | 'world';

/** 省全名 adcode 索引。 */
export function provinceByAdcode(data: AppData, adcode: string): Province | null {
  return data.provinces.find((p) => p.adcode === adcode) ?? null;
}

/**
 * 省 adcode → 去行政后缀的简称（如 广东省 → 广东；新疆维吾尔自治区 → 新疆）。
 *
 * ⚠ 这与「省级简称」**不是一回事**：这里剥后缀得到两个字（广东），车牌照式的单字简称（粤）
 * 见 `provinceAbbr()`。两者在本仓库里各有用途，别混用。
 */
export function provinceShortName(data: AppData, adcode: string): string {
  const p = provinceByAdcode(data, adcode);
  return p ? normalizeProvince(p.name) : adcode;
}

/**
 * 省级**单字简称**表（京 / 沪 / 粤 …）：「省名 / 简称」分段按钮的显示与判题口径。
 *
 * 为什么单独一张 JSON 而不是塞进 units.json：简称是**判题与显示口径**（与 `normalize-rules.json`
 * 同类），不是地图几何；而中国行政区数据管线（fetch-cn-atlas → build-data）的产物被大量代码与
 * 验收脚本按字段依赖，为 34 条静态映射重跑整条管线并不划算。`provinceAbbr.test.ts` 断言
 * 这张表的 adcode 集合与数据里的 34 个省完全一致，数据变了会立刻报错。
 *
 * `alt` = 官方同时认可的另一简称（川/蜀、贵/黔、云/滇、陕/秦、甘/陇）：**只用于接受输入**，
 * 显示一律用主简称 —— 与「地图标签显示简称」的口径保持一致。
 */
const PROVINCE_ABBR = abbrRules.abbr as Record<string, string>;
const PROVINCE_ABBR_ALT = abbrRules.alt as Record<string, string[]>;

/** 该省的主简称（表里没有该 adcode 时回落去后缀省名，保证调用方永远拿得到可显示文本）。 */
export function provinceAbbr(data: AppData, adcode: string): string {
  return PROVINCE_ABBR[adcode] ?? provinceShortName(data, adcode);
}

/** 该省接受的**全部**简称写法（主简称 + 别名）。 */
export function provinceAbbrInputs(data: AppData, adcode: string): string[] {
  const main = PROVINCE_ABBR[adcode];
  if (!main) return [provinceShortName(data, adcode)];
  return [main, ...(PROVINCE_ABBR_ALT[adcode] ?? [])];
}

/**
 * 简称档判题：只认简称（含别名），**不认省全名与去后缀省名**。
 *
 * 口径理由（用户 2026-09 需求「按照简称来出例如沪」）：简称档考的正是「省 ↔ 单字简称」这条记忆，
 * 若同时接受「上海」，不记得「沪」的人也能过关，这一档就白开了。与 `Matcher.bestUnit`
 * 「不做模糊匹配、避免错误答案蒙混过关」是同一原则。
 */
export function isProvinceAbbrInput(data: AppData, adcode: string, input: string): boolean {
  const s = input.trim();
  return !!s && provinceAbbrInputs(data, adcode).includes(s);
}

/**
 * 省-省邻接关系：由地级单位邻接聚合成省邻接（跨省的地级相邻对 ⇒ 两省相邻）。
 * 台湾无相邻地级 → 孤立（顺序/BFS 出题时回退最近未测省）。装饰面（南海诸岛、省直辖县级）不参与。
 */
export function buildProvinceAdjacency(data: AppData): Map<string, string[]> {
  const out = new Map<string, Set<string>>();
  const ensure = (adcode: string) => {
    if (!out.has(adcode)) out.set(adcode, new Set());
    return out.get(adcode)!;
  };
  for (const u of data.units) {
    if (u.decorative) continue;
    for (const n of u.neighbors) {
      const nu = data.units.find((x) => x.adcode === n);
      if (!nu || nu.decorative) continue;
      if (nu.provinceAdcode !== u.provinceAdcode) {
        ensure(u.provinceAdcode).add(nu.provinceAdcode);
        ensure(nu.provinceAdcode).add(u.provinceAdcode);
      }
    }
  }
  const list = new Map<string, string[]>();
  for (const [adcode, set] of out) {
    list.set(adcode, [...set].sort());
  }
  return list;
}

/**
 * **唯一层级省级单位**：京津沪渝（直辖市）与港澳台（特别行政区/地区）。
 *
 * 它们在 `units.json` 里各自只有 1 个下级单位 —— 就是它自己，所以任何模式"下钻"进去都只会得到
 * 一个退化的"1 个单位的练习 / 1 片拼图"。用户口径（2026-09）：**这类单位一律不允许下钻**。
 *
 * 这里写成显式清单（而不是"数一数下级单位"）是为了让规则可读、可核对；
 * `province.test.ts` 另有一条断言：清单与真实数据里"下级单位 ≤ 1 的省级单位"完全一致，
 * 数据变了会立刻报错。
 */
export const SINGLE_UNIT_PROVINCES: readonly string[] = [
  '110000', // 北京
  '120000', // 天津
  '310000', // 上海
  '500000', // 重庆
  '810000', // 香港
  '820000', // 澳门
  '710000', // 台湾
];

/** 该省级单位是否允许下钻（唯一层级的京津沪渝/港澳台不允许）。 */
export function canDrillProvince(adcode: string | null | undefined): boolean {
  return !!adcode && !SINGLE_UNIT_PROVINCES.includes(adcode);
}

/**
 * 点某个地图单位时**会下钻到的省级目标**：地级单位 → 它所属的省 adcode；省级单位 → 它自己。
 *
 * 市级视图里点一下地级市，renderer 会自动钻到它的省；点京津沪渝/港澳台这类单位的代表面时，
 * 钻的目标就是它自己 —— 这正是要被 `canDrillProvince` 拦下的情形。
 *
 * ⚠ 查的是 `allUnits`（含装饰面）：省直辖县级市/兵团城市这些**装饰面也在地图上可点**，
 * 它们的 `provinceAdcode` 才是正确的下钻目标；只查 `units` 会退化成"拿它自己当省"，
 * 于是钻出一个不存在下级单位的空范围。
 */
export function drillTargetOfUnit(data: AppData, adcode: string): string {
  const unit = data.allUnits.find((u) => u.adcode === adcode) ?? data.units.find((u) => u.adcode === adcode);
  return unit ? unit.provinceAdcode : adcode;
}

/**
 * 省级“虚拟地级单位”：把 34 个省级单元建模成 Unit，让 click/self 的出题循环、
 * 顺序/BFS、错题、进度存取完全复用现有的 Unit 逻辑。
 * adcode=省 adcode；neighbors=省-省邻接（BFS 扩张用）。
 */
export function provinceUnits(data: AppData, adjacency: Map<string, string[]>): Unit[] {
  return data.provinces.map((p) => ({
    adcode: p.adcode,
    name: p.name,
    shortName: normalizeProvince(p.name),
    province: p.name,
    provinceAdcode: p.adcode,
    center: p.center,
    neighbors: adjacency.get(p.adcode) ?? [],
    decorative: false,
  }));
}
