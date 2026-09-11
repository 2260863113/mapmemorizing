import type { AppData, Continent, SubregionId, SubregionMeta } from './types';

/**
 * 世界粒度「次区域」层（大洲 → 次区域）的共享数据与规则。
 *
 * 层级：世界 → 大洲 → 次区域（叶子）。次区域是方位式粗分，不做「北亚」
 * （俄罗斯整体归东欧，避免切割国界几何）。口径与断言见 scripts/build-subregions.mjs
 * 与 docs/adr/0004。
 *
 * 关键不变量（构建期已断言，运行期仍按此使用）：
 *   - 195 个答题国恰好各属一个次区域；
 *   - 每个次区域恰好属于一个大洲，且同一大洲内次区域成员并集 = 该洲全部国家。
 */

/** 某大洲下的次区域（按元数据顺序；无次区域返回空数组）。 */
export function subregionsOf(data: AppData, continent: Continent | null): SubregionMeta[] {
  if (!continent) return [];
  return data.subregions.filter((s) => s.continent === continent);
}

/**
 * 该大洲是否提供次区域下钻。
 * 分区数 ≤ 1 时不给次区域行（如南美只有一个「南美」分区，行内容退化为无意义）。
 */
export function hasSubregions(data: AppData, continent: Continent | null): boolean {
  return subregionsOf(data, continent).length > 1;
}

/** 次区域元数据（无命中返回 null）。 */
export function subregionById(data: AppData, id: SubregionId | null): SubregionMeta | null {
  if (!id) return null;
  return data.subregions.find((s) => s.id === id) ?? null;
}

/** iso_a3 → 次区域 id（无命中返回 null）。 */
export function subregionOfIso(data: AppData, iso: string): SubregionId | null {
  return data.isoSubregion[iso] ?? null;
}

/** 次区域 id → 所属大洲（无命中返回 null）。 */
export function subregionOfContinent(data: AppData, id: SubregionId): Continent | null {
  return data.subregions.find((s) => s.id === id)?.continent ?? null;
}

/** 某大洲下全部国家的 iso 列表（次区域并集，供校验与统计用）。 */
export function isosOfContinent(data: AppData, continent: Continent): string[] {
  return Object.keys(data.isoSubregion).filter(
    (iso) => data.countries.find((c) => c.iso === iso)?.continent === continent,
  );
}
