import { describe, it, expect } from 'vitest';
import { worldFollowZoom, WORLD_FOLLOW_MAX_ZOOM, WORLD_FOLLOW_MIN_ZOOM } from './renderer';

/**
 * 标定基准：用户给定的三个锚点。
 * 面积取自 public/data/world_area.json（度²，与视觉面积一致）。
 */
const LIE = 0.0157; // 列支敦士登
const MLT = 0.0251; // 马耳他
const AND = 0.0468; // 安道尔
const FRA = 71.5379; // 法国
const RUS = 2924.1082; // 俄罗斯

describe('worldFollowZoom（缩放与国家面积成反比）', () => {
  it('命中用户标定的三个锚点', () => {
    // 极小国：公式值远超上限 → 夹到 28x
    expect(worldFollowZoom(LIE)).toBe(28);
    expect(worldFollowZoom(MLT)).toBe(28);
    expect(worldFollowZoom(AND)).toBe(28);
    // 中等国：法国 ≈ 13x
    expect(worldFollowZoom(FRA)).toBeGreaterThan(12.5);
    expect(worldFollowZoom(FRA)).toBeLessThan(13.5);
    // 超大国家：俄罗斯 = 2x
    expect(worldFollowZoom(RUS)).toBeCloseTo(2, 0);
  });

  it('在未饱和的区间里严格递减（面积 ↑ ⇒ 缩放 ↓）', () => {
    const areas = [15, 20, 40, 71.5379, 100, 300, 700, 1500, 2924.1082];
    const zooms = areas.map(worldFollowZoom);
    for (let i = 1; i < zooms.length; i++) {
      expect(zooms[i], `面积 ${areas[i]} 应比 ${areas[i - 1]} 缩得更小`).toBeLessThan(zooms[i - 1]);
    }
  });

  it('单调不增覆盖整个池子（允许在上限处持平）', () => {
    const areas = [0.000928, 0.0157, 0.0468, 1, 14.88, 15, 71.5379, 500, 2924.1082];
    const zooms = areas.map(worldFollowZoom);
    for (let i = 1; i < zooms.length; i++) expect(zooms[i]).toBeLessThanOrEqual(zooms[i - 1]);
  });

  it('与 √面积 成反比：面积变 4 倍 → 缩放约减半（未饱和区）', () => {
    const z1 = worldFollowZoom(100);
    const z2 = worldFollowZoom(400);
    expect(z1 / z2).toBeCloseTo(2, 5);
  });

  it('任何输入都落在 [MIN, MAX] 内且有限', () => {
    for (const a of [0, -1, 1e-9, 0.000928, 1e6, Number.NaN, Number.POSITIVE_INFINITY]) {
      const z = worldFollowZoom(a);
      expect(Number.isFinite(z)).toBe(true);
      expect(z).toBeGreaterThanOrEqual(WORLD_FOLLOW_MIN_ZOOM);
      expect(z).toBeLessThanOrEqual(WORLD_FOLLOW_MAX_ZOOM);
    }
  });

  it('上限就是地图的最大缩放（最小国顶到上限，而不是各自为政）', () => {
    expect(WORLD_FOLLOW_MAX_ZOOM).toBe(28);
  });

  it('面积缺失时给可用的兜底值，而不是 0 或 NaN', () => {
    const fallback = worldFollowZoom(0);
    expect(fallback).toBeGreaterThan(WORLD_FOLLOW_MIN_ZOOM);
    expect(fallback).toBeLessThan(WORLD_FOLLOW_MAX_ZOOM);
    expect(worldFollowZoom(Number.NaN)).toBe(fallback);
  });

  it('是绝对映射：同一个国家永远得到同一个倍率（与当前池子无关）', () => {
    // 归一化实现会因为「全世界 vs 某洲」的面积区间不同而给出不同值
    expect(worldFollowZoom(9.7948)).toBe(28); // 韩国
    expect(worldFollowZoom(0.4498)).toBe(28); // 文莱
    expect(worldFollowZoom(71.5379)).toBe(worldFollowZoom(71.5379));
  });
});
