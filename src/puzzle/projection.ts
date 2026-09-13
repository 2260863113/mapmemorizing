/**
 * 拼图画布的投影：把经纬度换算成拼图自己的像素坐标。
 *
 * 为什么不复用 ECharts：拼图需要把每个省当成可以**各自平移**的独立碎片，而 ECharts 的 geo
 * 只能整体平移/缩放（逐个 region 没有独立的 transform），也没有任何既有拖拽/命中基建
 * （全仓 `draggable`/`graphic` 零使用）。详见 docs/adr/0006。
 *
 * 但**投影必须与省级地图完全一致**，否则拼出来的图形与地图页对不上：
 *   · 同一份固定投影 bbox（renderer.ts 的 `MAP_PROJECTION_BBOX.china`）
 *   · 同一个纬度压缩比（ECharts 对 GeoJSON 源的默认 `aspectScale = 0.75`，本项目未覆盖）
 * 于是 x = (lng − minLng)·scale、y = (maxLat − lat)·scale·0.75 —— 纯线性，可单测。
 */
import type { PolygonRings } from '../map/geometry';

/** 固定投影范围（与 `MAP_PROJECTION_BBOX.china` 逐字一致）。 */
export const PUZZLE_BBOX = { minLng: 73.5, minLat: 3.4, maxLng: 135.1, maxLat: 53.6 } as const;

/** ECharts geo 对 GeoJSON 源的默认纬度压缩比。 */
export const PUZZLE_ASPECT = 0.75;

/** 投影范围尺寸（度）。 */
export const PUZZLE_SPAN_LNG = PUZZLE_BBOX.maxLng - PUZZLE_BBOX.minLng; // 61.6
export const PUZZLE_SPAN_LAT = PUZZLE_BBOX.maxLat - PUZZLE_BBOX.minLat; // 50.2

/** 经纬度 → 拼图 px（scale = 每经度多少 px）。 */
export function projectX(lng: number, scale: number): number {
  return (lng - PUZZLE_BBOX.minLng) * scale;
}

export function projectY(lat: number, scale: number): number {
  return (PUZZLE_BBOX.maxLat - lat) * scale * PUZZLE_ASPECT;
}

export function project(point: [number, number], scale: number): [number, number] {
  return [projectX(point[0], scale), projectY(point[1], scale)];
}

/** 拼图 px → 经纬度（调试/探针用）。 */
export function unproject(x: number, y: number, scale: number): [number, number] {
  return [PUZZLE_BBOX.minLng + x / scale, PUZZLE_BBOX.maxLat - y / (scale * PUZZLE_ASPECT)];
}

/** 经纬度 bbox → 拼图 px 的 [minX, minY, maxX, maxY]。 */
export function projectBBox(
  bbox: [number, number, number, number],
  scale: number,
): [number, number, number, number] {
  const x0 = projectX(bbox[0], scale);
  const x1 = projectX(bbox[2], scale);
  const y0 = projectY(bbox[3], scale); // 纬度上界 → y 上界
  const y1 = projectY(bbox[1], scale);
  return [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
}

/** 一片几何在拼图 px 下的 bbox。 */
export function pxBBoxOf(polygons: PolygonRings[], scale: number): [number, number, number, number] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const rings of polygons) {
    for (const ring of rings) {
      for (const [lng, lat] of ring) {
        const x = projectX(lng, scale);
        const y = projectY(lat, scale);
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
 * 每个 `<path>` 里可能有多环（多岛省、含内环的省），用 `fill-rule: evenodd` 让内环成洞。
 * 坐标保留 1 位小数：拼图默认比例下 1px ≈ 0.037°，0.1px 的精度已远超视觉分辨率，
 * 却能让 path 字符串小一大截（34 片共 28k 顶点）。
 */
export function svgPathOf(polygons: PolygonRings[], scale: number): string {
  const parts: string[] = [];
  for (const rings of polygons) {
    for (const ring of rings) {
      if (ring.length < 3) continue;
      let segment = '';
      for (let i = 0; i < ring.length; i += 1) {
        const x = projectX(ring[i][0], scale);
        const y = projectY(ring[i][1], scale);
        segment += `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
      }
      parts.push(`${segment}Z`);
    }
  }
  return parts.join(' ');
}
