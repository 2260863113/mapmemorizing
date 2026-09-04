import type { AppData, Province, Unit } from './types';
import { normalizeProvince } from './matcher';

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

/** 测验/分析粒度：省级全国（省名）/ 市级全国或单省（地级市）/ 世界全国（国家名）。 */
export type Granularity = 'province' | 'city' | 'world';

/** 省全名 adcode 索引。 */
export function provinceByAdcode(data: AppData, adcode: string): Province | null {
  return data.provinces.find((p) => p.adcode === adcode) ?? null;
}

/** 省 adcode → 去行政后缀的简称（如 广东省 → 广东；新疆维吾尔自治区 → 新疆）。 */
export function provinceShortName(data: AppData, adcode: string): string {
  const p = provinceByAdcode(data, adcode);
  return p ? normalizeProvince(p.name) : adcode;
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
