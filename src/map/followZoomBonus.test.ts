import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { followZoomWithBonus, worldFollowZoom, WORLD_FOLLOW_MAX_ZOOM, WORLD_FOLLOW_MIN_ZOOM } from './renderer';
import { MAX_ZOOM, MIN_ZOOM } from './zoom';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const AREA = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data/world_area.json'), 'utf8')).area as Record<string, number>;

/**
 * 「基准倍率 + 额外加成」（2026-09 需求 8）的算术与边界。
 *
 * 需求原话：输入模式自由跟随下缩放**统一添加 2x**，**非洲添加 6x**。
 * 这里的「添加」是**在按面积/按省标定的基准倍率上相加**，不是把倍率直接设成 2/6 —— 故本文件锁两件事：
 *   1. 加法真的生效（基准 + 加成的结果与逐项相加一致）；
 *   2. 相加后仍在地图缩放范围内（极小国 +6 会顶到 28x 上限，而不是 29.6x）。
 */
describe('followZoomWithBonus（基准 + 加成，再夹到地图缩放范围）', () => {
  it('普通加成：+2 就是 +2', () => {
    expect(followZoomWithBonus(12, 2)).toBe(14); // 中国地级 / 南方省
    expect(followZoomWithBonus(6, 2)).toBe(8); // 宽省（新疆/西藏/青海/内蒙古）
    expect(followZoomWithBonus(28, 2)).toBe(28); // 海南已顶格，再加不会越界
  });

  it('非洲 +6：比普通国多 4 倍率级', () => {
    expect(followZoomWithBonus(8, 6)).toBe(14); // 法国量级
    expect(followZoomWithBonus(12, 6)).toBe(18);
  });

  it('任何加成都不越出 [MIN_ZOOM, MAX_ZOOM]（极小国基准 23.6x + 6 必须夹回 28）', () => {
    expect(WORLD_FOLLOW_MAX_ZOOM).toBe(MAX_ZOOM);
    const nru = worldFollowZoom(AREA.NRU); // 全池最小国（瑙鲁），基准最大
    expect(nru).toBeGreaterThan(23);
    expect(followZoomWithBonus(nru, 6)).toBe(MAX_ZOOM);
    // 极端值（非法/巨大加成）也被夹住，不会出现 0 或 NaN
    for (const extra of [-100, -3, 0, 2, 6, 1000, Number.NaN]) {
      const z = followZoomWithBonus(12, extra);
      expect(Number.isFinite(z)).toBe(true);
      expect(z).toBeGreaterThanOrEqual(MIN_ZOOM);
      expect(z).toBeLessThanOrEqual(MAX_ZOOM);
    }
    // 非法加成按 0（clampZoom(NaN) 会原样返回 NaN，传进 geo.zoom 就是整幅地图消失）
    expect(followZoomWithBonus(12, Number.NaN)).toBe(12);
    expect(followZoomWithBonus(12, Number.POSITIVE_INFINITY)).toBe(12);
  });

  it('需求 8 的落点：非非洲国家真实基准 +2，非洲真实基准 +6', () => {
    const zOf = (iso: string) => worldFollowZoom(AREA[iso]);
    // 中国（亚洲）与南非（非洲）各一遍：加成分别 2 / 6
    expect(followZoomWithBonus(zOf('CHN'), 2)).toBeCloseTo(zOf('CHN') + 2, 9);
    expect(followZoomWithBonus(zOf('ZAF'), 6)).toBeCloseTo(zOf('ZAF') + 6, 9);
    // 非洲加成比普通加成正好多 4（同一基准下）
    expect(followZoomWithBonus(zOf('ZAF'), 6) - followZoomWithBonus(zOf('ZAF'), 2)).toBeCloseTo(4, 9);
    // 兜底值（面积缺失）同样可加成，不会变成 NaN
    expect(followZoomWithBonus(worldFollowZoom(0), 2)).toBeGreaterThan(WORLD_FOLLOW_MIN_ZOOM);
  });
});
