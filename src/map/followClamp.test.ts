import { describe, it, expect } from 'vitest';
import { clampFollowAxis } from './follow';

/**
 * 跟随钳制的单轴纯函数（用户 2026-09 需求）：
 * 「被跟随的地点已经在取景边界附近时，不要把它挪到视觉正中，防止半屏空白」。
 *
 * center = clamp( clamp(t, min+hw, max−hw), t−(hw−m), t+(hw−m) )
 *   · 内层：视口不越出取景边界（露白 0）；
 *   · 外层：目标离屏幕边至少 m；两者冲突时**外层让步**（用户口径：优先保证目标不贴屏幕边）。
 *
 * 由此得到两条可检验的性质：
 *   1. 目标**在取景边界内**时，露白 ≤ m（目标正好落在边界上时露白 = m）；
 *   2. 目标恒在视口内、且离屏幕边 ≥ m —— 目标落在边界外时露白会超过 m，
 *      但那只可能发生在「大洲/次区域标定框」这种**取景框**上（世界地图那里并没有数据边界，
 *      不会有真正的背景色露出）；真实数据边界（中国 bbox / 世界 bbox / 下钻省框）内的目标
 *      按构造都在框内，故性质 1 始终成立。
 */
describe('clampFollowAxis', () => {
  // 用中国纬度边界做算例：3.4 ~ 53.6，视口跨度 20（半宽 10），边距 2
  const MIN = 3.4;
  const MAX = 53.6;
  const SPAN = 20;
  const M = 2;
  const hw = SPAN / 2;

  it('目标在边界中部时保持不动（正常情况仍然居中）', () => {
    expect(clampFollowAxis(30, SPAN, M, MIN, MAX)).toBeCloseTo(30, 9);
  });

  it('目标贴近边界时被推开，且露白不超过边距', () => {
    const c = clampFollowAxis(52, SPAN, M, MIN, MAX);
    expect(c).toBeLessThan(52); // 不再居中
    expect(c + hw - MAX).toBeLessThanOrEqual(M + 1e-9); // 越界（露白）≤ m
    expect(c + hw - 52).toBeGreaterThanOrEqual(M - 1e-9); // 目标离屏幕边 ≥ m
  });

  it('目标正好落在边界上：露白恰好 = m，目标仍离屏幕边 m', () => {
    const c = clampFollowAxis(MAX, SPAN, M, MIN, MAX);
    expect(c + hw - MAX).toBeCloseTo(M, 9);
    expect(c + hw - MAX).toBeCloseTo(M, 9);
  });

  it('性质 1 + 2：边界内的目标，露白 ≤ m 且恒在视口内、离屏幕边 ≥ m', () => {
    for (let t = MIN; t <= MAX; t += 0.25) {
      const c = clampFollowAxis(t, SPAN, M, MIN, MAX);
      const blank = Math.max(c + hw - MAX, MIN - (c - hw), 0);
      expect(blank).toBeLessThanOrEqual(M + 1e-9);
      expect(t - (c - hw)).toBeGreaterThanOrEqual(M - 1e-9);
      expect(c + hw - t).toBeGreaterThanOrEqual(M - 1e-9);
    }
  });

  it('取景边界比视口还小时退化为边界中心（空白无法避免）', () => {
    const bigSpan = 60; // 半宽 30 > 边界半宽 25.1
    expect(clampFollowAxis(50, bigSpan, M, MIN, MAX)).toBeCloseTo((MIN + MAX) / 2, 9);
  });

  it('边距不小于半视口时退化为完全居中', () => {
    expect(clampFollowAxis(52, SPAN, 12, MIN, MAX)).toBeCloseTo(52, 9);
  });

  it('目标在取景边界外（只可能是大洲/次区域取景框）：仍留在视口内且离屏幕边 m', () => {
    for (const t of [55, 60, 70, 100]) {
      const c = clampFollowAxis(t, SPAN, M, MIN, MAX);
      expect(c + hw - t).toBeCloseTo(M, 9); // 目标恒距屏幕边 m
      expect(c - hw).toBeLessThanOrEqual(t);
      expect(c + hw).toBeGreaterThanOrEqual(t); // 仍在视口内（不会被推出屏幕）
    }
  });
});
