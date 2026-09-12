import { describe, it, expect } from 'vitest';
import { worldFollowZoom, WORLD_FOLLOW_MAX_ZOOM, WORLD_FOLLOW_MIN_ZOOM } from './renderer';

/** 世界面积区间（度²），取自 public/data/world_area.json 的实测极值。 */
const RANGE = { min: 0.000928, max: 2924.108196 };

describe('worldFollowZoom (缩放与国家面积成反比)', () => {
  it('maps the smallest country to the largest zoom and the largest to the smallest', () => {
    expect(worldFollowZoom(RANGE.min, RANGE)).toBeCloseTo(WORLD_FOLLOW_MAX_ZOOM, 6);
    expect(worldFollowZoom(RANGE.max, RANGE)).toBeCloseTo(WORLD_FOLLOW_MIN_ZOOM, 6);
  });

  it('is strictly decreasing in area (area ↑ ⇒ zoom ↓)', () => {
    const areas = [RANGE.min, 0.001, 0.01, 0.1, 1, 10, 100, 1000, RANGE.max];
    const zooms = areas.map((a) => worldFollowZoom(a, RANGE));
    for (let i = 1; i < zooms.length; i++) {
      expect(zooms[i], `area ${areas[i]} should zoom out vs ${areas[i - 1]}`).toBeLessThan(zooms[i - 1]);
    }
  });

  it('stays inside the configured zoom band for any input', () => {
    for (const a of [0, -1, 1e-9, 1e9, Number.NaN]) {
      const z = worldFollowZoom(a, RANGE);
      expect(z).toBeGreaterThanOrEqual(WORLD_FOLLOW_MIN_ZOOM);
      expect(z).toBeLessThanOrEqual(WORLD_FOLLOW_MAX_ZOOM);
      expect(Number.isFinite(z)).toBe(true);
    }
  });

  it('falls back to the band midpoint when the range is degenerate or the area is unusable', () => {
    const mid = (WORLD_FOLLOW_MIN_ZOOM + WORLD_FOLLOW_MAX_ZOOM) / 2;
    expect(worldFollowZoom(5, { min: 10, max: 10 })).toBeCloseTo(mid, 6);
    expect(worldFollowZoom(0, RANGE)).toBeCloseTo(mid, 6);
    expect(worldFollowZoom(5, { min: 0, max: 1 })).toBeCloseTo(mid, 6);
  });

  it('gives a real country a sane, visibly distinct zoom', () => {
    // 俄罗斯 vs 新加坡：面积差 4 个数量级 → 缩放必须有明显差别
    const rus = worldFollowZoom(2924.108196, RANGE);
    const sgp = worldFollowZoom(0.0409, RANGE);
    expect(sgp).toBeGreaterThan(rus);
    expect(sgp - rus).toBeGreaterThan(2); // 至少差 2 倍，肉眼可辨
  });
});
