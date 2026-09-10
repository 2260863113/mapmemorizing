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

/** 把 TopoJSON（objects.china 拓扑对象）转成 GeoJSON，并拼接装饰面（省直辖县级/兵团城市，DataV 源）。 */
function topoToGeoJson(topo: Topology, decorative: { features?: unknown[] }): unknown {
  const obj = topo.objects?.china as GeometryCollection | undefined;
  if (!obj) throw new Error('TopoJSON 缺 objects.china');
  const geo = feature(topo, obj);
  const decoFeatures = decorative.features ?? [];
  return { type: 'FeatureCollection', features: [...geo.features, ...decoFeatures] };
}

/** 省级无损档 TopoJSON → GeoJSON（不拼装饰面：省界折线只要省级面）。 */
function provRawTopoToGeoJson(topo: Topology): unknown {
  const obj = topo.objects?.china as GeometryCollection | undefined;
  if (!obj) throw new Error('省级无损档 TopoJSON 缺 objects.china');
  return feature(topo, obj);
}

/** 加载数据（public/data 下的构建产物）。raw 档（无压缩，889KB）单独异步加载，不阻塞首屏。 */
export async function loadData(): Promise<AppData> {
  if (cache) return cache;
  const [meta, fineTopo, coarseTopo, ultraTopo, decorativeGeo, provGeo, provCoarseGeo, provRawTopo, hkmacGeo, worldMeta, worldGeo] = await Promise.all([
    fetchJson<{ units: Unit[]; provinces: AppData['provinces'] }>('data/units.json'),
    fetchJson<Topology>('data/china_units.json'),
    fetchJson<Topology>('data/china_units_coarse.json'),
    fetchJson<Topology>('data/china_units_ultra.json'),
    fetchJson<{ features?: unknown[] }>('data/china_decorative.geojson'),
    fetchJson<unknown>('data/china_provinces.geojson'),
    fetchJson<unknown>('data/china_provinces_coarse.geojson'),
    fetchJson<Topology>('data/china_provinces_raw.json'),
    fetchJson<unknown>('data/hkmac.geojson'),
    fetchJson<{ countries: CountryMeta[] }>('data/countries.json'),
    fetchJson<unknown>('data/world.geojson'),
  ]);
  const allUnits = meta.units.map((u) => (isPureDecoration(u) ? u : { ...u, decorative: false }));
  const units = allUnits.filter((u) => !u.decorative);
  cache = {
    units,
    allUnits,
    provinces: meta.provinces,
    geoJson: topoToGeoJson(fineTopo, decorativeGeo),
    coarseGeoJson: topoToGeoJson(coarseTopo, decorativeGeo),
    ultraGeoJson: topoToGeoJson(ultraTopo, decorativeGeo),
    rawGeoJson: null, // 无压缩档异步加载（见 loadRawGeoJson）
    provincesGeoJson: provGeo,
    provincesCoarseGeoJson: provCoarseGeo,
    provincesRawGeoJson: provRawTopoToGeoJson(provRawTopo), // 省级无损档（zoom ≥ 10）
    hkmacGeoJson: hkmacGeo, // 港澳放大框无压缩面（广东+香港+澳门）
    countries: worldMeta.countries,
    worldGeoJson: worldGeo,
  };
  return cache;
}

/** 异步加载无压缩 raw 档（不阻塞首屏）。返回拼接装饰面后的 GeoJSON。 */
export async function loadRawGeoJson(): Promise<unknown> {
  const [rawTopo, decorativeGeo] = await Promise.all([
    fetchJson<Topology>('data/china_units_raw.json'),
    fetchJson<{ features?: unknown[] }>('data/china_decorative.geojson'),
  ]);
  return topoToGeoJson(rawTopo, decorativeGeo);
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
