/** 地图纯几何运算：bbox、多边形/环、质心、点在多边形内、标签锚点选址。与 ECharts 无关，可独立单测。 */

export type GeoPoint = [number, number];
export type PolygonRings = GeoPoint[][];
export type GeoFeature = {
  properties: { adcode?: string; name?: string; iso_a3?: string; decorative?: number };
  geometry: { type: string; coordinates: unknown };
};

export function bboxOf(feature: { geometry: { coordinates: unknown } }): [number, number, number, number] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const walk = (coords: unknown) => {
    if (!Array.isArray(coords)) return;
    for (const c of coords as unknown[]) {
      if (Array.isArray(c) && typeof c[0] === 'number') {
        const x = c[0] as number;
        const y = c[1] as number;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      } else {
        walk(c);
      }
    }
  };
  walk(feature.geometry.coordinates);
  return [minX, minY, maxX, maxY];
}

export function polygonsOf(feature: GeoFeature): PolygonRings[] {
  const geometry = feature.geometry;
  if (geometry.type === 'Polygon') return [ringsOf(geometry.coordinates)].filter((rings) => rings.length > 0);
  if (geometry.type !== 'MultiPolygon' || !Array.isArray(geometry.coordinates)) return [];
  return geometry.coordinates.map((poly) => ringsOf(poly)).filter((rings) => rings.length > 0);
}

export function ringsOf(raw: unknown): PolygonRings {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((ring) => {
      if (!Array.isArray(ring)) return [];
      return ring.filter(isGeoPoint).map((p) => [p[0], p[1]] as GeoPoint);
    })
    .filter((ring) => ring.length >= 3);
}

export function isGeoPoint(value: unknown): value is GeoPoint {
  return Array.isArray(value) && typeof value[0] === 'number' && typeof value[1] === 'number';
}

export function bestLabelAnchor(polygons: PolygonRings[]): GeoPoint {
  const polygon = largestPolygon(polygons);
  const outer = polygon[0];
  const [minX, minY, maxX, maxY] = bboxOfRings(polygon);
  const centroid = ringCentroid(outer);
  let best = pointInPolygon(centroid, polygon) ? centroid : firstInsidePoint(polygon) ?? [(minX + maxX) / 2, (minY + maxY) / 2];
  let bestScore = anchorScore(best, polygon);

  const search = (fromX: number, fromY: number, toX: number, toY: number, steps: number) => {
    const dx = (toX - fromX) / steps;
    const dy = (toY - fromY) / steps;
    for (let ix = 0; ix <= steps; ix += 1) {
      for (let iy = 0; iy <= steps; iy += 1) {
        const point: GeoPoint = [fromX + dx * ix, fromY + dy * iy];
        const score = anchorScore(point, polygon);
        if (score > bestScore) {
          best = point;
          bestScore = score;
        }
      }
    }
  };

  search(minX, minY, maxX, maxY, 14);
  let spanX = (maxX - minX) / 6;
  let spanY = (maxY - minY) / 6;
  for (let i = 0; i < 2; i += 1) {
    search(best[0] - spanX, best[1] - spanY, best[0] + spanX, best[1] + spanY, 10);
    spanX /= 3;
    spanY /= 3;
  }
  return best;
}

export function largestPolygon(polygons: PolygonRings[]): PolygonRings {
  return polygons.reduce((best, current) => (Math.abs(ringArea(current[0])) > Math.abs(ringArea(best[0])) ? current : best));
}

export function bboxOfRings(rings: PolygonRings): [number, number, number, number] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const ring of rings) {
    for (const [x, y] of ring) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  return [minX, minY, maxX, maxY];
}

export function firstInsidePoint(polygon: PolygonRings): GeoPoint | null {
  for (const ring of polygon) {
    for (const point of ring) {
      if (pointInPolygon(point, polygon)) return point;
    }
  }
  return null;
}

export function anchorScore(point: GeoPoint, polygon: PolygonRings): number {
  if (!pointInPolygon(point, polygon)) return -Infinity;
  let minDistance = Infinity;
  for (const ring of polygon) {
    for (let i = 0; i < ring.length; i += 1) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      minDistance = Math.min(minDistance, distanceToSegment(point, a, b));
    }
  }
  return minDistance;
}

export function ringCentroid(ring: GeoPoint[]): GeoPoint {
  let area2 = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[(i + 1) % ring.length];
    const cross = x0 * y1 - x1 * y0;
    area2 += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }
  if (Math.abs(area2) < 1e-9) return averagePoint(ring);
  return [cx / (3 * area2), cy / (3 * area2)];
}

export function averagePoint(points: GeoPoint[]): GeoPoint {
  const sum = points.reduce((acc, [x, y]) => [acc[0] + x, acc[1] + y] as GeoPoint, [0, 0]);
  return [sum[0] / points.length, sum[1] / points.length];
}

export function ringArea(ring: GeoPoint[]): number {
  let area = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[(i + 1) % ring.length];
    area += x0 * y1 - x1 * y0;
  }
  return area / 2;
}

export function pointInPolygon(point: GeoPoint, polygon: PolygonRings): boolean {
  if (!pointInRing(point, polygon[0])) return false;
  return polygon.slice(1).every((hole) => !pointInRing(point, hole));
}

export function pointInRing([x, y]: GeoPoint, ring: GeoPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

export function distanceToSegment(point: GeoPoint, a: GeoPoint, b: GeoPoint): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  if (dx === 0 && dy === 0) return Math.hypot(point[0] - a[0], point[1] - a[1]);
  const t = Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / (dx * dx + dy * dy)));
  const x = a[0] + t * dx;
  const y = a[1] + t * dy;
  return Math.hypot(point[0] - x, point[1] - y);
}