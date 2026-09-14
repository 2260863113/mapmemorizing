/**
 * 地图几何索引的构建：把 GeoJSON 压成运行时查表的**纯函数**。
 *
 * 为什么单独成模块：这些构建只在渲染器构造期各跑一次，输入是数据本身、输出是纯查表，
 * 与相机 / ECharts 实例状态毫无关系。它们原先待在 1800 行的 `MapRenderer` 里 ——
 * 既无法单测，也让「这个类到底管什么」更难回答。抽走后渲染器只剩它的真实职责：
 * 相机、几何档位、着色与标签策略。
 */
import { bestLabelAnchor, polygonsOf, type GeoFeature, type GeoPoint } from './geometry';

/** 省界折线的一个环：属于哪个省 + 环坐标。 */
export interface ProvinceLineRing {
  adcode: string;
  coords: number[][];
}

/** 省界 GeoJSON 的形状（只声明用到的字段）。 */
export interface ProvinceLineGeoJson {
  features: { properties: { adcode: string }; geometry: { type: string; coordinates: unknown } }[];
}

/**
 * 省界折线：把省界 GeoJSON 的每个环转成线坐标（用于 `lines` 系列的粗线渲染）。
 * 五个精细度档各调一次，各得一份表。
 *
 * `src` 缺失时回落 `fallback` —— 沿用原实现里的防御性回退（字段类型是 `unknown`，
 * 编译期无法保证非空）。
 */
export function buildProvinceLines(src: unknown, fallback: unknown): ProvinceLineRing[] {
  const geo = (src ?? fallback) as ProvinceLineGeoJson;
  const out: ProvinceLineRing[] = [];
  for (const f of geo.features) {
    const g = f.geometry;
    const rings: unknown[] = [];
    if (g.type === 'Polygon') rings.push(...(g.coordinates as unknown[]));
    else if (g.type === 'MultiPolygon') {
      for (const poly of g.coordinates as unknown[]) rings.push(...(poly as unknown[]));
    }
    for (const ring of rings) {
      const coords = (ring as unknown[])
        .filter((c) => Array.isArray(c) && typeof (c as number[])[0] === 'number')
        .map((c) => c as number[]);
      if (coords.length >= 2) out.push({ adcode: f.properties.adcode, coords });
    }
  }
  return out;
}

/**
 * 从一份行政面 GeoJSON 计算 `adcode → 文字锚点`（主面质心）。
 *
 * 地级与省级用的是**同一套算法** —— 原先渲染器里写了两份逐字相同的私有方法
 * （只差数据源），现在收敛成一个纯函数。锚点只服务文字位置，不影响聚焦与下钻
 * 使用的地图相机中心。
 */
export function buildLabelAnchors(geo: { features?: GeoFeature[] }): Map<string, GeoPoint> {
  const out = new Map<string, GeoPoint>();
  for (const feature of geo.features ?? []) {
    const adcode = feature.properties.adcode;
    if (!adcode) continue;
    const polygons = polygonsOf(feature);
    if (!polygons.length) continue;
    out.set(adcode, bestLabelAnchor(polygons));
  }
  return out;
}
