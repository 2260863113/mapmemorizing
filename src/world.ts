import type { CountryMeta, Unit } from './types';
import { WORLD_NATION_SCOPE } from './province';

/**
 * 世界粒度（世界全国练习 / 国家名熟练度分析）的共享数据与规则。
 *
 * 答题单元 = public/data/countries.json 的 195 国（联合国 193 会员国 + 梵蒂冈 + 巴勒斯坦）。
 * 世界答题与地级市/省级熟练度完全隔离：对/错只计入国家熟练度（见 MemoryStore 的国家记录）。
 * 国家单元同样建模为「虚拟 Unit」（iso_a3 作为 adcode），让 click/self 的出题循环、
 * 顺序/BFS、错题、进度存取完全复用现有 Unit 逻辑——与省级「虚拟地级单位」同一思路。
 */

/** 「世界全国」排行榜/结算哨兵（纯新增作用域行，DB UNIQUE(user_id, mode, scope_province) 天然隔离）。 */
export { WORLD_NATION_SCOPE };

/** 由 countries.json 元数据构造答题国 Unit 列表（iso_a3 → adcode）。 */
export function countryUnits(countries: readonly CountryMeta[]): Unit[] {
  return countries.map((c) => ({
    adcode: c.iso,
    name: c.name,
    shortName: c.name,
    province: c.name,
    provinceAdcode: c.iso,
    center: c.center,
    neighbors: c.neighbors,
    decorative: false,
  }));
}

/** 由 iso 反查国家简称（无命中回退 iso 本身）。 */
export function countryShortName(countries: readonly CountryMeta[], iso: string): string {
  return countries.find((c) => c.iso === iso)?.name ?? iso;
}
