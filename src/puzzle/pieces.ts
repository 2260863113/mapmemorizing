/**
 * 拼图碎片：把省级 plus 档（40%）几何切成 34 片。
 *
 * 三件与数据有关的事实决定了这里的规则（均在 grill 中与用户确认）：
 *   1. 省级档里共 **35 个 feature**：34 个省级单位 + 1 个装饰面「南海诸岛」（adcode `100000_JD`）。
 *      装饰面**不参与拼图**（它是个框，不是省）。
 *   2. 海南省的 feature 含 **204 个多边形**（三沙/南海岛礁一路向南到 3.84°N），bbox 达 9.22°×16.32°，
 *      而主岛只有 2.41°×1.99°。整片拿来当碎片会是一块"稀疏大块"，故拆成两部分：
 *        · `polygons`  = 主岛 + 主岛 bbox 外扩 0.5° 内的近岸小岛 → 参与拼图；
 *        · `seaIslets` = 其余远海岛礁 → **获胜后自动补上**（用户口径），不参与拼图/计数。
 *   3. 其它省的 feature 直接整片当作碎片。
 */
import type { AppData } from '../types';
import { normalizeProvince } from '../matcher';
import {
  bboxOfPolygons,
  bboxOfRings,
  bestLabelAnchor,
  largestPolygon,
  polygonsOf,
  ringArea,
  type GeoFeature,
  type GeoPoint,
  type PolygonRings,
} from '../map/geometry';

/** 主岛 bbox 外扩多少度以内的岛算"近岸小岛"（海南用）。 */
export const NEAR_ISLET_MARGIN_DEG = 0.5;

/** 南海诸岛装饰面的 adcode（不参与拼图）。 */
export const SEA_DECORATIVE_ADCODE = '100000_JD';

export interface PuzzlePieceDef {
  adcode: string;
  /** 官方全名（如 内蒙古自治区）。 */
  name: string;
  /** 简称（如 内蒙古），拼图"简单"档显示它。 */
  label: string;
  /** 参与拼图的多边形。 */
  polygons: PolygonRings[];
  /** 获胜后自动补上的远海岛礁多边形（目前只有海南非空）。 */
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

function withinMargin(inner: [number, number, number, number], outer: [number, number, number, number]): boolean {
  return !(inner[0] > outer[0] || inner[2] < outer[2] || inner[1] > outer[1] || inner[3] < outer[3]);
}

/** 把海南的 204 个多边形分成"主岛及近岸"与"远海岛礁"。 */
export function splitHainan(polygons: PolygonRings[]): { body: PolygonRings[]; islets: PolygonRings[] } {
  if (polygons.length <= 1) return { body: polygons, islets: [] };
  const main = largestPolygon(polygons);
  const mainBox = bboxOfRings(main);
  const expanded: [number, number, number, number] = [
    mainBox[0] - NEAR_ISLET_MARGIN_DEG,
    mainBox[1] - NEAR_ISLET_MARGIN_DEG,
    mainBox[2] + NEAR_ISLET_MARGIN_DEG,
    mainBox[3] + NEAR_ISLET_MARGIN_DEG,
  ];
  const body: PolygonRings[] = [];
  const islets: PolygonRings[] = [];
  for (const poly of polygons) {
    const box = bboxOfRings(poly);
    const area = Math.abs(ringArea(poly[0] ?? []));
    // "远且小" → 远海岛礁；近岸小岛（在 margin 内）与主岛本身归入 body
    const isIslet = !withinMargin(box, expanded) && area < 1;
    (isIslet ? islets : body).push(poly);
  }
  // 兜底：主岛本身一定要在 body 里
  if (!body.includes(main)) body.push(main);
  return { body, islets };
}

/**
 * 从省级 plus 档几何构建 34 片。
 *
 * @param data 应用数据（用 `provincesPlusGeoJson`；缺失时返回空数组，调用方降级）
 */
export function buildPieces(data: AppData): PuzzlePieceDef[] {
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
    const bbox = bboxOfPolygons(body);
    const area = body.reduce((sum, poly) => sum + Math.abs(ringArea(poly[0] ?? [])), 0);
    out.push({
      adcode,
      name,
      label: normalizeProvince(name),
      polygons: body,
      seaIslets: islets,
      bbox,
      area,
      origin: [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2],
      labelAnchor: bestLabelAnchor(body),
    });
  }
  return out.sort((a, b) => a.adcode.localeCompare(b.adcode));
}
