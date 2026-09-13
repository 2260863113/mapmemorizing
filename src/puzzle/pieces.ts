/**
 * 拼图碎片：按**当前范围**把地图切成可拖拽的碎片。
 *
 * 三个来源（都与点击/输入模式同一套数据口径）：
 *   1. **世界档**：`worldGeoJson` 的国家面（194 个答题国，装饰面如属地/南极不作碎片）；
 *      大洲/次区域范围按 `country.continent` 与 `isoSubregion` 过滤。
 *   2. **省级档（全国）**：`provincesPlusGeoJson` 的 34 个省级单位（排除装饰面「南海诸岛」）。
 *      ⚠ 海南省的 feature 含 204 个多边形（三沙一路到 3.84°N），整片当碎片会是一块"稀疏大块"，
 *      故拆成 **主岛 + 近岸小岛**（拼图用）与 `seaIslets`（获胜后自动补上，不参与拼图/计数）。
 *   3. **市级档（全国 / 下钻某省）**：`plusGeoJson` 的 340 个真实地级单位（装饰面不作碎片，
 *      由 `data.units` 已经排除；下钻某省时按其 `provinceAdcode` 过滤）。
 *
 * 每片都带 `bbox`（经纬度）、`area`（度²，用于画布的上下覆盖：小的压在大的之上）、
 * `origin`（bbox 中心，碎片"摆到正确位置"时的落点）与 `labelAnchor`（主面质心，标签位置）。
 */
import type { AppData, Continent, SubregionId } from '../types';
import { normalizeProvince } from '../matcher';
import type { Granularity } from '../province';
import {
  bboxOfPolygons,
  bestLabelAnchor,
  largestPolygon,
  polygonsOf,
  ringArea,
  type GeoFeature,
  type GeoPoint,
  type PolygonRings,
} from '../map/geometry';
import type { PuzzleFamily } from './projection';

/** 主岛 bbox 外扩多少度以内的岛算"近岸小岛"（海南用）。 */
export const NEAR_ISLET_MARGIN_DEG = 0.5;

/** 南海诸岛装饰面的 adcode（不参与拼图）。 */
export const SEA_DECORATIVE_ADCODE = '100000_JD';

export interface PuzzlePieceDef {
  adcode: string;
  /** 官方全名（如 内蒙古自治区 / 津巴布韦）。 */
  name: string;
  /** 简称（如 内蒙古 / 阿克苏），拼图"简单"档显示它。 */
  label: string;
  /** 参与拼图的多边形。 */
  polygons: PolygonRings[];
  /** 获胜后自动补上的远海岛礁多边形（目前只有海南省档非空）。 */
  seaIslets: PolygonRings[];
  /** 本片（不含 seaIslets）的经纬度 bbox。 */
  bbox: [number, number, number, number];
  /** 真值锚点（bbox 中心，经纬度）：碎片"放到正确位置"时的落点。 */
  origin: GeoPoint;
  /** 标签锚点（主面质心，经纬度）。 */
  labelAnchor: GeoPoint;
  /** 本片面积（度²，各环 |area| 之和）：画布按它决定上下覆盖——**小的压在大的之上**。 */
  area: number;
}

/** 一次拼图的范围（粒度 + 下钻层级）。 */
export interface PuzzleScope {
  granularity: Granularity;
  /** 投影族：世界档用 world，其余用 china。 */
  family: PuzzleFamily;
  /** 市级档下钻到某省（省 adcode）；未下钻为 undefined。 */
  province?: string;
  continent?: Continent;
  subregion?: SubregionId;
}

/** 粒度 → 投影族。 */
export function familyOf(granularity: Granularity): PuzzleFamily {
  return granularity === 'world' ? 'world' : 'china';
}

function withinMargin(inner: [number, number, number, number], outer: [number, number, number, number]): boolean {
  return !(inner[0] > outer[0] || inner[2] < outer[2] || inner[1] > outer[1] || inner[3] < outer[3]);
}

/** 把海南的 204 个多边形分成"主岛及近岸"与"远海岛礁"。 */
export function splitHainan(polygons: PolygonRings[]): { body: PolygonRings[]; islets: PolygonRings[] } {
  if (polygons.length <= 1) return { body: polygons, islets: [] };
  const main = largestPolygon(polygons);
  const mainBox = bboxOfRingsOf(main);
  const expanded: [number, number, number, number] = [
    mainBox[0] - NEAR_ISLET_MARGIN_DEG,
    mainBox[1] - NEAR_ISLET_MARGIN_DEG,
    mainBox[2] + NEAR_ISLET_MARGIN_DEG,
    mainBox[3] + NEAR_ISLET_MARGIN_DEG,
  ];
  const body: PolygonRings[] = [];
  const islets: PolygonRings[] = [];
  for (const poly of polygons) {
    const box = bboxOfRingsOf(poly);
    const area = Math.abs(ringArea(poly[0] ?? []));
    // "远且小" → 远海岛礁；近岸小岛（在 margin 内）与主岛本身归入 body
    (withinMargin(box, expanded) || area >= 1 ? body : islets).push(poly);
  }
  if (!body.includes(main)) body.push(main);
  return { body, islets };
}

function bboxOfRingsOf(polygon: PolygonRings): [number, number, number, number] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const ring of polygon) {
    for (const [x, y] of ring) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  return [minX, minY, maxX, maxY];
}

/** 由多边形集合造一片。 */
function makePiece(
  adcode: string,
  name: string,
  label: string,
  body: PolygonRings[],
  seaIslets: PolygonRings[] = [],
): PuzzlePieceDef {
  const bbox = bboxOfPolygons(body);
  const area = body.reduce((sum, poly) => sum + Math.abs(ringArea(poly[0] ?? [])), 0);
  return {
    adcode,
    name,
    label,
    polygons: body,
    seaIslets,
    bbox,
    area,
    origin: [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2],
    labelAnchor: bestLabelAnchor(body),
  };
}

/** 世界档：国家面。 */
function buildCountryPieces(data: AppData, scope: PuzzleScope): PuzzlePieceDef[] {
  const geo = data.worldGeoJson as { features?: GeoFeature[] } | null | undefined;
  const features = geo?.features ?? [];
  const meta = new Map(data.countries.map((c) => [c.iso, c]));
  const out: PuzzlePieceDef[] = [];
  for (const feature of features) {
    const iso = feature.properties.iso_a3 ? String(feature.properties.iso_a3) : '';
    const country = meta.get(iso);
    if (!country) continue; // 装饰面（属地/南极等）不作碎片
    if (scope.continent && country.continent !== scope.continent) continue;
    if (scope.subregion && data.isoSubregion[iso] !== scope.subregion) continue;
    const polygons = polygonsOf(feature);
    if (!polygons.length) continue;
    out.push(makePiece(iso, country.fullName || country.name, country.name, polygons));
  }
  return out.sort((a, b) => a.adcode.localeCompare(b.adcode));
}

/** 省级档（全国）：34 个省级单位，海南拆主岛/远海岛礁。 */
function buildProvincePieces(data: AppData): PuzzlePieceDef[] {
  const geo = data.provincesPlusGeoJson as { features?: GeoFeature[] } | null | undefined;
  const features = geo?.features ?? [];
  const byAdcode = new Map(data.provinces.map((p) => [p.adcode, p]));
  const out: PuzzlePieceDef[] = [];
  for (const feature of features) {
    const adcode = feature.properties.adcode ?? '';
    if (!adcode || adcode === SEA_DECORATIVE_ADCODE) continue;
    const name = feature.properties.name ?? byAdcode.get(adcode)?.name ?? adcode;
    const all = polygonsOf(feature);
    if (!all.length) continue;
    const { body, islets } = adcode === '460000' ? splitHainan(all) : { body: all, islets: [] };
    out.push(makePiece(adcode, name, normalizeProvince(name), body, islets));
  }
  return out.sort((a, b) => a.adcode.localeCompare(b.adcode));
}

/** 市级档：地级单位（全国 340 个；下钻某省时只用该省的）。 */
function buildCityPieces(data: AppData, scope: PuzzleScope): PuzzlePieceDef[] {
  const geo = data.plusGeoJson as { features?: GeoFeature[] } | null | undefined;
  const features = geo?.features ?? [];
  const featureByAdcode = new Map<string, GeoFeature>();
  for (const f of features) {
    const adcode = f.properties.adcode;
    if (adcode) featureByAdcode.set(String(adcode), f);
  }
  const out: PuzzlePieceDef[] = [];
  for (const unit of data.units) {
    if (scope.province && unit.provinceAdcode !== scope.province) continue;
    const feature = featureByAdcode.get(unit.adcode);
    if (!feature) continue;
    const polygons = polygonsOf(feature);
    if (!polygons.length) continue;
    out.push(makePiece(unit.adcode, unit.name, unit.shortName || unit.name, polygons));
  }
  return out.sort((a, b) => a.adcode.localeCompare(b.adcode));
}

/** 按范围构建碎片（顺序稳定：adcode 升序）。 */
export function buildPieces(data: AppData, scope: PuzzleScope): PuzzlePieceDef[] {
  if (scope.granularity === 'world') return buildCountryPieces(data, scope);
  if (scope.granularity === 'province') return buildProvincePieces(data);
  return buildCityPieces(data, scope);
}

/**
 * 只数碎片个数（不解析几何）：开始卡片要写"把 xx 拼成…"，而那时还没开局。
 *
 * 过滤条件与三个 builder **逐条对齐**（单测断言与 `buildPieces().length` 相等），
 * 但不做 `polygonsOf`，所以是毫秒级的；省/市/世界三档都不解析坐标。
 */
export function countScopePieces(data: AppData, scope: PuzzleScope): number {
  if (scope.granularity === 'world') {
    const geo = data.worldGeoJson as { features?: GeoFeature[] } | null | undefined;
    const available = new Set<string>();
    for (const f of geo?.features ?? []) {
      const iso = f.properties.iso_a3 ? String(f.properties.iso_a3) : '';
      if (iso) available.add(iso);
    }
    return data.countries.filter((c) => {
      if (!available.has(c.iso)) return false;
      if (scope.continent && c.continent !== scope.continent) return false;
      if (scope.subregion && data.isoSubregion[c.iso] !== scope.subregion) return false;
      return true;
    }).length;
  }
  if (scope.granularity === 'province') {
    const geo = data.provincesPlusGeoJson as { features?: GeoFeature[] } | null | undefined;
    let n = 0;
    for (const f of geo?.features ?? []) {
      const adcode = f.properties.adcode;
      if (adcode && adcode !== SEA_DECORATIVE_ADCODE) n += 1;
    }
    return n;
  }
  const geo = data.plusGeoJson as { features?: GeoFeature[] } | null | undefined;
  const available = new Set<string>();
  for (const f of geo?.features ?? []) {
    const adcode = f.properties.adcode;
    if (adcode) available.add(String(adcode));
  }
  return data.units.filter((u) => (!scope.province || u.provinceAdcode === scope.province) && available.has(u.adcode)).length;
}
