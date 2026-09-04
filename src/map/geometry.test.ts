import { describe, it, expect } from 'vitest';
import { bboxOfRings, ringCentroid, ringArea, pointInRing, pointInPolygon, distanceToSegment, largestPolygon, bestLabelAnchor, ringsOf } from './geometry';
import type { GeoPoint, PolygonRings } from './geometry';

// 一个简单的方形环（外环）+ 一个洞（内环）
const square: GeoPoint[] = [[0, 0], [10, 0], [10, 10], [0, 10]];
const hole: GeoPoint[] = [[3, 3], [7, 3], [7, 7], [3, 7]];

describe('ringArea', () => {
  it('computes signed area of a square (counter-clockwise positive)', () => {
    expect(ringArea([[0, 0], [10, 0], [10, 10], [0, 10]])).toBeCloseTo(100);
  });
  it('is negative for clockwise winding', () => {
    expect(ringArea([[0, 0], [0, 10], [10, 10], [10, 0]])).toBeCloseTo(-100);
  });
});

describe('ringCentroid', () => {
  it('returns center of a square', () => {
    const [cx, cy] = ringCentroid(square);
    expect(cx).toBeCloseTo(5);
    expect(cy).toBeCloseTo(5);
  });
});

describe('pointInRing', () => {
  it('detects inside vs outside', () => {
    expect(pointInRing([5, 5], square)).toBe(true);
    expect(pointInRing([11, 5], square)).toBe(false);
    expect(pointInRing([0, 5], square)).toBe(true); // 边界点判定为内（含边界）
  });
});

describe('pointInPolygon', () => {
  it('excludes points inside a hole', () => {
    const poly: PolygonRings = [square, hole];
    expect(pointInPolygon([5, 5], poly)).toBe(false); // 洞内
    expect(pointInPolygon([1, 5], poly)).toBe(true); // 外环内、洞外
    expect(pointInPolygon([12, 5], poly)).toBe(false);
  });
});

describe('bboxOfRings', () => {
  it('computes bounding box', () => {
    expect(bboxOfRings([square])).toEqual([0, 0, 10, 10]);
  });
});

describe('distanceToSegment', () => {
  it('computes distance to a segment', () => {
    expect(distanceToSegment([5, 5], [0, 0], [10, 0])).toBeCloseTo(5);
    expect(distanceToSegment([5, -5], [0, 0], [10, 0])).toBeCloseTo(5);
    expect(distanceToSegment([0, 5], [0, 0], [0, 0])).toBeCloseTo(5); // 退化为点
  });
});

describe('largestPolygon', () => {
  it('picks the polygon with the largest outer-ring area', () => {
    const small: PolygonRings = [[[0, 0], [1, 0], [1, 1], [0, 1]]];
    const big: PolygonRings = [square];
    expect(largestPolygon([small, big])).toEqual(big);
  });
});

describe('ringsOf', () => {
  it('filters non-numeric and short rings', () => {
    const out = ringsOf([[[0, 0], [1, 0], [1, 1]], [[0, 0], [1, 0]], [[0, 0], 'x', [1, 1]]]);
    expect(out.length).toBe(1);
    expect(out[0].length).toBe(3);
  });
});

describe('bestLabelAnchor', () => {
  it('returns a point inside the polygon', () => {
    const poly: PolygonRings = [square]; // 单环多边形
    const anchor = bestLabelAnchor([poly]);
    expect(pointInPolygon(anchor, poly)).toBe(true);
  });
  it('avoids the hole in a polygon-with-hole', () => {
    const poly: PolygonRings = [square, hole];
    const anchor = bestLabelAnchor([poly]);
    expect(pointInPolygon(anchor, poly)).toBe(true);
  });
});