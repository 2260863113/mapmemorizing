import type { AppData, CountryMeta, Unit } from './types';
import { t } from './i18n';

let cache: AppData | null = null;

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(t('data.loadFail', { url, status: res.status }));
  return res.json() as Promise<T>;
}

/** 加载数据（public/data 下的构建产物） */
export async function loadData(): Promise<AppData> {
  if (cache) return cache;
  const [meta, geo, provGeo, worldMeta, worldGeo] = await Promise.all([
    fetchJson<{ units: Unit[]; provinces: AppData['provinces'] }>('data/units.json'),
    fetchJson<unknown>('data/china_units.geojson'),
    fetchJson<unknown>('data/china_provinces.geojson'),
    fetchJson<{ countries: CountryMeta[] }>('data/countries.json'),
    fetchJson<unknown>('data/world.geojson'),
  ]);
  const allUnits = meta.units.map((u) => (isPureDecoration(u) ? u : { ...u, decorative: false }));
  const units = allUnits.filter((u) => !u.decorative);
  cache = {
    units,
    allUnits,
    provinces: meta.provinces,
    geoJson: geo,
    provincesGeoJson: provGeo,
    countries: worldMeta.countries,
    worldGeoJson: worldGeo,
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
