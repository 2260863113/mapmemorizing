/**
 * 拼图画布的投影：把经纬度换算成拼图自己的像素坐标。
 *
 * 为什么不复用 ECharts：拼图需要把每个单位当成可以**各自平移**的独立碎片，而 ECharts 的 geo
 * 只能整体平移/缩放（逐个 region 没有独立的 transform），也没有任何既有拖拽/命中基建
 * （全仓 `draggable`/`graphic` 零使用）。详见 docs/adr/0006。
 *
 * 但**投影必须与地图页完全一致**，否则拼出来的图形与地图页对不上：
 *   · 同一份固定投影 bbox（renderer.ts 的 `MAP_PROJECTION_BBOX`，分中国/世界两族）
 *   · 同一个纬度比例（ECharts 对 GeoJSON 源的默认 `aspectScale = 0.75`，本项目未覆盖）
 *
 * **aspectScale 的方向很容易搞反**（本项目踩过：碎片被上下压扁）。ECharts 的用法是
 * `geoCreator.resizeGeo`：`aspect = rect.width / rect.height * aspectScale`，
 * 再把 geo 的视口按这个宽高比铺开（`layout.getLayoutRect`）——它是**布局宽高比系数**，
 * 不是纬度缩放系数。于是：
 *
 *   viewW / viewH = (bboxW / bboxH) · aspectScale
 *   ⇒ px/度(纬度) = viewH / bboxH = (viewW / bboxW) / aspectScale = px/度(经度) / 0.75
 *
 * 即 **1 度纬度占的像素是 1 度经度的 1/0.75 ≈ 1.333 倍**（纬度被"拉长"，等价于经度被压短），
 * 这正是为了让中国纬度带（≈40°N，cos40° ≈ 0.766）的比例看起来正确。
 * 实测印证：1440×762 视口下地图上可见经纬跨度之比 = 2.52 = (1440/762)/0.75。
 *
 * 于是 x = (lng − minLng)·scale、y = (maxLat − lat)·scale/0.75 —— 纯线性，可单测。
 */
import type { PolygonRings } from '../map/geometry';

/** 投影族：中国族（地级/省级）与世界族（国家），各有一套钉死的 bbox。 */
export type PuzzleFamily = 'china' | 'world';

/** 固定投影范围（与 `MAP_PROJECTION_BBOX` 逐字一致）。 */
export const PUZZLE_BBOX: Record<PuzzleFamily, { minLng: number; minLat: number; maxLng: number; maxLat: number }> = {
  china: { minLng: 73.5, minLat: 3.4, maxLng: 135.1, maxLat: 53.6 },
  world: { minLng: -180, minLat: -90, maxLng: 180, maxLat: 83.6 },
};

/** ECharts geo 对 GeoJSON 源的默认 `aspectScale`（用于**布局宽高比**）。 */
export const PUZZLE_ASPECT = 0.75;

/** 每度纬度占的像素 ÷ 每度经度占的像素 = 1 / aspectScale ≈ 1.333。 */
export const PUZZLE_LAT_PER_LNG = 1 / PUZZLE_ASPECT;

export function spanLng(family: PuzzleFamily): number {
  const b = PUZZLE_BBOX[family];
  return b.maxLng - b.minLng;
}

export function spanLat(family: PuzzleFamily): number {
  const b = PUZZLE_BBOX[family];
  return b.maxLat - b.minLat;
}

/** 中国族投影范围尺寸（度）；世界族见 `spanLng/spanLat('world')`。 */
export const PUZZLE_SPAN_LNG = spanLng('china'); // 61.6
export const PUZZLE_SPAN_LAT = spanLat('china'); // 50.2

/** 经纬度 → 拼图 px（scale = 每经度多少 px）。 */
export function projectX(lng: number, scale: number, family: PuzzleFamily = 'china'): number {
  return (lng - PUZZLE_BBOX[family].minLng) * scale;
}

export function projectY(lat: number, scale: number, family: PuzzleFamily = 'china'): number {
  return (PUZZLE_BBOX[family].maxLat - lat) * scale * PUZZLE_LAT_PER_LNG;
}

export function project(point: [number, number], scale: number, family: PuzzleFamily = 'china'): [number, number] {
  return [projectX(point[0], scale, family), projectY(point[1], scale, family)];
}

/** 拼图 px → 经纬度（调试/探针用）。 */
export function unproject(x: number, y: number, scale: number, family: PuzzleFamily = 'china'): [number, number] {
  const b = PUZZLE_BBOX[family];
  return [b.minLng + x / scale, b.maxLat - y / (scale * PUZZLE_LAT_PER_LNG)];
}

/** 经纬度 bbox → 拼图 px 的 [minX, minY, maxX, maxY]。 */
export function projectBBox(
  bbox: [number, number, number, number],
  scale: number,
  family: PuzzleFamily = 'china',
): [number, number, number, number] {
  const x0 = projectX(bbox[0], scale, family);
  const x1 = projectX(bbox[2], scale, family);
  const y0 = projectY(bbox[3], scale, family); // 纬度上界 → y 上界
  const y1 = projectY(bbox[1], scale, family);
  return [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
}

/** 一片几何在拼图 px 下的 bbox。 */
export function pxBBoxOf(polygons: PolygonRings[], scale: number, family: PuzzleFamily = 'china'): [number, number, number, number] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const rings of polygons) {
    for (const ring of rings) {
      for (const [lng, lat] of ring) {
        const x = projectX(lng, scale, family);
        const y = projectY(lat, scale, family);
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (!Number.isFinite(minX)) return [0, 0, 0, 0];
  return [minX, minY, maxX, maxY];
}

/**
 * 几何 → SVG path 字符串。
 *
 * 每个 `<path>` 里可能有多环（多岛单位、含内环的省），用 `fill-rule: evenodd` 让内环成洞。
 * 坐标保留 1 位小数：拼图默认比例下 0.1px 已远超视觉分辨率，却能让 path 字符串小一大截。
 */
export function svgPathOf(polygons: PolygonRings[], scale: number, family: PuzzleFamily = 'china'): string {
  const parts: string[] = [];
  for (const rings of polygons) {
    for (const ring of rings) {
      if (ring.length < 3) continue;
      let segment = '';
      for (let i = 0; i < ring.length; i += 1) {
        const x = projectX(ring[i][0], scale, family);
        const y = projectY(ring[i][1], scale, family);
        segment += `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
      }
      parts.push(`${segment}Z`);
    }
  }
  return parts.join(' ');
}
