import type { AppData, CountryMeta, Unit } from './types';
import { t } from './i18n';
import { feature } from 'topojson-client';
import type { Topology, GeometryCollection } from 'topojson-specification';

let cache: AppData | null = null;

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(t('data.loadFail', { url, status: res.status }));
  return res.json() as Promise<T>;
}

/** 把 TopoJSON（objects.china 拓扑对象）转成 GeoJSON。 */
function topoToGeoJson(topo: Topology): unknown {
  const obj = topo.objects?.china as GeometryCollection | undefined;
  if (!obj) throw new Error('TopoJSON 缺 objects.china');
  return feature(topo, obj);
}

/** 省级 TopoJSON 档 → GeoJSON（不拼装饰面：省界折线/省级地图只要省级面）。 */
function provTopoToGeoJson(topo: Topology): unknown {
  const obj = topo.objects?.china as GeometryCollection | undefined;
  if (!obj) throw new Error('省级 TopoJSON 缺 objects.china');
  return feature(topo, obj);
}

/** 世界 TopoJSON 档 → GeoJSON（objects.china 含答题国 + 装饰面；与地级/省级同一读法）。 */
function topoWorldToGeoJson(topo: Topology): unknown {
  const obj = topo.objects?.china as GeometryCollection | undefined;
  if (!obj) throw new Error('世界 TopoJSON 缺 objects.china');
  return feature(topo, obj);
}

/** 加载数据（public/data 下的构建产物）。 */
export async function loadData(): Promise<AppData> {
  if (cache) return cache;
  const [
    meta, ultraTopo, proTopo, fineTopo, plusTopo, losslessTopo,
    provUltraTopo, provProTopo, provFineTopo, provPlusTopo, provRawTopo,
    hkmacGeo, worldMeta, worldGeo, subMeta,
  ] = await Promise.all([
    fetchJson<{ units: Unit[]; provinces: AppData['provinces'] }>('data/units.json'),
    fetchJson<Topology>('data/china_units_ultra.json'),
    fetchJson<Topology>('data/china_units_pro.json'),
    fetchJson<Topology>('data/china_units.json'),
    fetchJson<Topology>('data/china_units_plus.json'),
    fetchJson<Topology>('data/china_units_lossless.json'),
    fetchJson<Topology>('data/china_provinces_ultra.json'),
    fetchJson<Topology>('data/china_provinces_pro.json'),
    fetchJson<Topology>('data/china_provinces.json'),
    fetchJson<Topology>('data/china_provinces_plus.json'),
    fetchJson<Topology>('data/china_provinces_raw.json'),
    fetchJson<unknown>('data/hkmac.geojson'),
    fetchJson<{ countries: CountryMeta[] }>('data/countries.json'),
    fetchJson<Topology>('data/world_v2.topojson'),
    fetchJson<{ subregions: AppData['subregions']; byIso: AppData['isoSubregion'] }>('data/subregions.json'),
  ]);
  const allUnits = meta.units.map((u) => (isPureDecoration(u) ? u : { ...u, decorative: false }));
  const units = allUnits.filter((u) => !u.decorative);
  const provFine = provTopoToGeoJson(provFineTopo);
  // 五档精细度阶梯（顶点保留比例）：ultra 4% < pro 8% < fine 15% < plus 40% < lossless 100%
  // 县级装饰面（省直辖县级/兵团城市）已并入地级拓扑组，随各档一起输出，无需再单独拼接。
  //
  // 注意：TopoJSON → GeoJSON 的转换**每次都要重新展开所有弧**，代价不低（fine 档约 12ms）。
  // 历史别名字段（coarse / provincesCoarse）必须复用同一份转换结果，不能各转一次 ——
  // pro 档 18k 顶点、省级 ultra 4.8k 顶点，重复转换既白费内存也让「别名」不再真正同一份数据。
  const proGeo = topoToGeoJson(proTopo);
  const provUltraGeo = provTopoToGeoJson(provUltraTopo);
  cache = {
    units,
    allUnits,
    provinces: meta.provinces,
    ultraGeoJson: topoToGeoJson(ultraTopo),
    proGeoJson: proGeo,
    geoJson: topoToGeoJson(fineTopo),
    plusGeoJson: topoToGeoJson(plusTopo),
    losslessGeoJson: topoToGeoJson(losslessTopo), // 无损档（100% 顶点，zoom ≥ 14）
    // 历史字段别名（旧测试固件/旧缓存仍引用）：coarse = pro 8% / provincesCoarse = 省级 4%
    coarseGeoJson: proGeo,
    provincesGeoJson: provFine,
    provincesCoarseGeoJson: provUltraGeo,
    provincesUltraGeoJson: provUltraGeo,
    provincesProGeoJson: provTopoToGeoJson(provProTopo),
    provincesPlusGeoJson: provTopoToGeoJson(provPlusTopo),
    provincesRawGeoJson: provTopoToGeoJson(provRawTopo), // 省级无损档（zoom ≥ 14）
    hkmacGeoJson: hkmacGeo, // 港澳放大框无压缩面（广东+香港+澳门）
    countries: worldMeta.countries,
    // 世界地图：Natural Earth 50m（dp 50% + TopoJSON 量化），中位线段 0.179°（旧档 0.733°，4.1 倍精细）。
    // 旧档 data/world.geojson 与旧管线 scripts/fetch-world-data.mjs 保留在库中但不再加载（回滚路径）。
    // 展开后契约与旧档逐字一致：properties 为 { iso_a3, name, full_name, decorative }。
    worldGeoJson: topoWorldToGeoJson(worldGeo),
    subregions: subMeta.subregions,
    isoSubregion: subMeta.byIso,
  };
  return cache;
}

/** 常用索引 */
export function buildIndex(data: AppData) {
  const byAdcode = new Map<string, Unit>();
  for (const u of data.allUnits) byAdcode.set(u.adcode, u);
  const provinceUnits = new Map<string, Unit[]>();
  for (const u of data.units) {
    const list = provinceUnits.get(u.provinceAdcode) ?? [];
    list.push(u);
    provinceUnits.set(u.provinceAdcode, list);
  }
  return { byAdcode, provinceUnits };
}

function isPureDecoration(unit: Unit) {
  return unit.adcode === '100000_JD';
}

export type Index = ReturnType<typeof buildIndex>;
