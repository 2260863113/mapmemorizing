import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { worldFollowZoom, WORLD_FOLLOW_A, WORLD_FOLLOW_B, WORLD_FOLLOW_MAX_ZOOM, WORLD_FOLLOW_MIN_ZOOM } from './renderer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const AREA = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data/world_area.json'), 'utf8')).area as Record<string, number>;

/** 用户本轮给定的三档锚点。 */
const ANCHORS: [string, number][] = [
  ['LTU', 11], // 立陶宛
  ['FRA', 8], // 法国
  ['RUS', 3], // 俄罗斯
];

describe('worldFollowZoom（缩放与国家面积成反比）', () => {
  it('命中用户标定的三档锚点（立陶宛 11x / 法国 8x / 俄罗斯 3x）', () => {
    for (const [iso, want] of ANCHORS) {
      const z = worldFollowZoom(AREA[iso]);
      expect(Math.abs(z - want), `${iso} 得到 ${z.toFixed(2)}x，期望 ${want}x`).toBeLessThanOrEqual(0.15);
    }
  });

  it('全池严格递减（面积 ↑ ⇒ 缩放 ↓），除非触到下限', () => {
    const isos = Object.keys(AREA).filter((i) => AREA[i] > 0).sort((a, b) => AREA[a] - AREA[b]);
    const zooms = isos.map((i) => worldFollowZoom(AREA[i]));
    for (let i = 1; i < zooms.length; i++) {
      expect(zooms[i], `${isos[i]} 应不比 ${isos[i - 1]} 放得更大`).toBeLessThanOrEqual(zooms[i - 1]);
      // 只在贴住下限时才允许持平
      if (zooms[i] === zooms[i - 1]) expect(zooms[i]).toBe(WORLD_FOLLOW_MIN_ZOOM);
    }
  });

  it('对数模型：面积乘 e^(1/B) 时倍率减少 1（A、B 与公式自洽）', () => {
    // zoom(a) - zoom(a·k) = B·ln k
    const a = 100;
    const k = Math.exp(1 / WORLD_FOLLOW_B);
    expect(worldFollowZoom(a) - worldFollowZoom(a * k)).toBeCloseTo(1, 6);
    // 且与常量的定义一致
    expect(WORLD_FOLLOW_A - WORLD_FOLLOW_B * Math.log(a)).toBeCloseTo(worldFollowZoom(a), 6);
  });

  it('任何输入都落在 [MIN, MAX] 内且有限', () => {
    for (const a of [0, -1, 1e-12, 0.000928, 1e9, Number.NaN, Number.POSITIVE_INFINITY]) {
      const z = worldFollowZoom(a);
      expect(Number.isFinite(z)).toBe(true);
      expect(z).toBeGreaterThanOrEqual(WORLD_FOLLOW_MIN_ZOOM);
      expect(z).toBeLessThanOrEqual(WORLD_FOLLOW_MAX_ZOOM);
    }
  });

  it('上限即地图最大缩放；本模型下全池都够不到它（最大的是瑙鲁）', () => {
    expect(WORLD_FOLLOW_MAX_ZOOM).toBe(28);
    const maxZoomInPool = Math.max(...Object.values(AREA).filter((a) => a > 0).map(worldFollowZoom));
    expect(maxZoomInPool).toBeLessThan(WORLD_FOLLOW_MAX_ZOOM);
    // 最小国（瑙鲁）应拿到全池最大倍率
    expect(worldFollowZoom(AREA.NRU)).toBeCloseTo(maxZoomInPool, 6);
  });

  it('面积缺失时给可用的兜底值，而不是 0 或 NaN', () => {
    const fallback = worldFollowZoom(0);
    expect(fallback).toBeGreaterThan(WORLD_FOLLOW_MIN_ZOOM);
    expect(fallback).toBeLessThan(WORLD_FOLLOW_MAX_ZOOM);
    expect(worldFollowZoom(Number.NaN)).toBe(fallback);
    expect(worldFollowZoom(-5)).toBe(fallback);
  });

  it('是绝对映射：同一国家在任何范围下倍率一致（与当前池子无关）', () => {
    expect(worldFollowZoom(AREA.FRA)).toBe(worldFollowZoom(AREA.FRA));
    expect(worldFollowZoom(AREA.LTU)).toBeCloseTo(10.94, 1);
  });

  it('本轮口径变化的事实：极小国不再顶到 28x（上一轮是 28x）', () => {
    // 锚点整体压缩后，安道尔/马耳他/列支敦士登落在 18–20x 区间
    for (const iso of ['AND', 'MLT', 'LIE']) {
      const z = worldFollowZoom(AREA[iso]);
      expect(z, iso).toBeGreaterThan(17);
      expect(z, iso).toBeLessThan(21);
    }
  });
});
