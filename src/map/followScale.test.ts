import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  cityFollowScale,
  scaleFollowZoom,
  SELF_FOLLOW_SCALE,
  SELF_FOLLOW_SCALE_AFRICA,
  worldFocusZoom,
  worldFollowScale,
} from './followScale';
import { worldFollowZoom, WORLD_FOLLOW_MAX_ZOOM } from './renderer';
import { followZoomFor } from './camera';
import { MAX_ZOOM, MIN_ZOOM } from './zoom';
import { isTinyCountry, setTinyCountriesForTest } from '../tinyCountries';
import type { Continent } from '../types';

/**
 * 输入模式自动跟随的**倍率系数**（2026-09 需求 8 修订版）。
 *
 * 口径：普通 ×0.75、非洲 ×0.5、面积极小的国家不乘系数而直接用世界跟随上限。
 * 为什么这些断言值得存在：系数是"乘"而不是"加"，一个符号写错就会让整个自动跟随
 * 朝反方向走一档（用户已经因为方向说反改过一次），而它在界面上只表现为"镜头有点近/有点远"，
 * 靠肉眼几乎发现不了。
 */

/** 真实国家面积（public/data/world_area.json，构建期算好的度²；形状 `{ sourceNote, area }`）。 */
function loadAreas(): Record<string, number> {
  const file = path.resolve(process.cwd(), 'public/data/world_area.json');
  const raw = JSON.parse(readFileSync(file, 'utf8')) as { area?: Record<string, number> };
  return raw.area ?? {};
}

describe('worldFollowScale / cityFollowScale（系数表）', () => {
  it('非洲 ×0.5，其余大洲一律 ×0.75', () => {
    expect(worldFollowScale('AF')).toBe(SELF_FOLLOW_SCALE_AFRICA);
    expect(worldFollowScale('AF')).toBe(0.5);
    for (const c of ['AS', 'EU', 'NA', 'SA', 'OC'] as Continent[]) {
      expect(worldFollowScale(c), c).toBe(SELF_FOLLOW_SCALE);
      expect(worldFollowScale(c), c).toBe(0.75);
    }
  });

  it('大洲缺失按通用档（不因一个空字段突然拉到 0.5 倍）', () => {
    expect(worldFollowScale(null)).toBe(0.75);
    expect(worldFollowScale(undefined)).toBe(0.75);
  });

  it('中国地级统一 ×0.75', () => {
    expect(cityFollowScale()).toBe(0.75);
    expect(cityFollowScale()).toBe(SELF_FOLLOW_SCALE);
  });
});

describe('scaleFollowZoom（基准 × 系数 → 夹取）', () => {
  it('乘法而不是加法：12 × 0.75 = 9（不是 12 + 2 = 14）', () => {
    expect(scaleFollowZoom(12, SELF_FOLLOW_SCALE)).toBe(9);
    expect(scaleFollowZoom(12, SELF_FOLLOW_SCALE_AFRICA)).toBe(6);
    // 明确的"不是加法"断言：旧版 +2/+6 的结果必须不再出现
    expect(scaleFollowZoom(12, 0.75)).not.toBe(14);
    expect(scaleFollowZoom(12, 0.5)).not.toBe(18);
  });

  it('夹到地图缩放范围 [MIN_ZOOM, MAX_ZOOM]', () => {
    expect(scaleFollowZoom(28, 0.75)).toBe(21);
    expect(scaleFollowZoom(MAX_ZOOM, 2)).toBe(MAX_ZOOM);
    expect(scaleFollowZoom(MIN_ZOOM, 0.1)).toBe(MIN_ZOOM);
  });

  it('非法系数一律按 1（NaN / Infinity / 0 / 负数都不能毁掉镜头）', () => {
    expect(scaleFollowZoom(12, Number.NaN)).toBe(12);
    expect(scaleFollowZoom(12, Number.POSITIVE_INFINITY)).toBe(12);
    // 0 是最危险的一种：会被夹成 MIN_ZOOM，表现为"跟随之后镜头突然拉到最远"。
    // 上一版这里有个「无尽传 0」的调用点，语义换过之后极易被遗留的 0 命中。
    expect(scaleFollowZoom(12, 0)).toBe(12);
    expect(scaleFollowZoom(12, -3)).toBe(12);
  });
});

describe('系数作用在真实面积映射上（世界档）', () => {
  const areas = loadAreas();
  const zOf = (iso: string) => worldFollowZoom(areas[iso]);

  it('普通国：乘 0.75 后恰为基准的 3/4', () => {
    for (const iso of ['CHN', 'FRA', 'RUS']) {
      expect(scaleFollowZoom(zOf(iso), SELF_FOLLOW_SCALE), iso).toBeCloseTo(zOf(iso) * 0.75, 9);
    }
  });

  it('非洲国：乘 0.5 后恰为基准的一半，且比普通档更远', () => {
    for (const iso of ['ZAF', 'EGY', 'NGA']) {
      expect(scaleFollowZoom(zOf(iso), SELF_FOLLOW_SCALE_AFRICA), iso).toBeCloseTo(zOf(iso) * 0.5, 9);
      expect(scaleFollowZoom(zOf(iso), SELF_FOLLOW_SCALE_AFRICA), iso).toBeLessThan(
        scaleFollowZoom(zOf(iso), SELF_FOLLOW_SCALE),
      );
    }
  });

  it('乘完仍落在设计区间内（世界跟随下限 3 会降到 2.25，但不低于地图下限）', () => {
    for (const iso of ['RUS', 'CHN', 'FRA', 'ZAF', 'MCO', 'NRU']) {
      const z = scaleFollowZoom(zOf(iso), SELF_FOLLOW_SCALE);
      expect(z, iso).toBeGreaterThanOrEqual(MIN_ZOOM);
      expect(z, iso).toBeLessThanOrEqual(MAX_ZOOM);
    }
  });

  it('系数不改动大小关系：面积越大倍率越小这条性质仍成立', () => {
    const big = scaleFollowZoom(zOf('RUS'), SELF_FOLLOW_SCALE);
    const mid = scaleFollowZoom(zOf('FRA'), SELF_FOLLOW_SCALE);
    const small = scaleFollowZoom(zOf('LTU'), SELF_FOLLOW_SCALE);
    expect(big).toBeLessThan(mid);
    expect(mid).toBeLessThan(small);
  });
});

describe('极小国家：不乘系数，直接用世界跟随上限', () => {
  it('清单里的 6 国被认作极小（且与设置开关无关）', () => {
    setTinyCountriesForTest(['MCO', 'MDV', 'MHL', 'NRU', 'SMR', 'TUV']);
    for (const iso of ['MCO', 'MDV', 'MHL', 'NRU', 'SMR', 'TUV']) expect(isTinyCountry(iso), iso).toBe(true);
    for (const iso of ['CHN', 'FRA', 'ZAF']) expect(isTinyCountry(iso), iso).toBe(false);
    setTinyCountriesForTest(null);
  });

  it('清单未加载时降级为"不是极小国"（不会让镜头跳到意料之外的地方）', () => {
    setTinyCountriesForTest(null);
    expect(isTinyCountry('MCO')).toBe(false);
  });

  it('渲染器对极小国使用的目标倍率就是跟随上限，且高于任何乘完系数后的结果', () => {
    const areas = loadAreas();
    for (const iso of ['MCO', 'NRU', 'TUV', 'SMR']) {
      const base = worldFollowZoom(areas[iso]);
      const scaled = scaleFollowZoom(base, SELF_FOLLOW_SCALE);
      // 极小国：不走系数，直接上限
      expect(worldFocusZoom(base, SELF_FOLLOW_SCALE, true), iso).toBe(WORLD_FOLLOW_MAX_ZOOM);
      expect(worldFocusZoom(base, SELF_FOLLOW_SCALE_AFRICA, true), iso).toBe(WORLD_FOLLOW_MAX_ZOOM);
      // 普通国：上限分支不生效，走的仍是"基准 × 系数"
      expect(worldFocusZoom(base, SELF_FOLLOW_SCALE, false), iso).toBe(scaled);
      // 也就是：极小国拿到的倍率严格大于"乘完系数"的倍率（这正是这条例外的意义）
      expect(worldFocusZoom(base, SELF_FOLLOW_SCALE, true), iso).toBeGreaterThan(scaled);
    }
  });

  it('worldFocusZoom 的两种分支只由 tiny 决定（系数非法也不影响极小国的上限）', () => {
    expect(worldFocusZoom(23, Number.NaN, false)).toBe(23);
    expect(worldFocusZoom(23, Number.NaN, true)).toBe(28);
    expect(worldFocusZoom(23, 0, true)).toBe(28);
  });
});

describe('中国地级：系数作用在按省标定的阶梯上', () => {
  it('普通省 12 × 0.75 = 9；宽省 6 × 0.75 = 4.5；海南顶格 28 × 0.75 = 21', () => {
    expect(scaleFollowZoom(followZoomFor('440000'), cityFollowScale())).toBe(9); // 广东
    expect(scaleFollowZoom(followZoomFor('650000'), cityFollowScale())).toBe(4.5); // 新疆（宽省）
    expect(scaleFollowZoom(followZoomFor('460000'), cityFollowScale())).toBe(21); // 海南（顶格）
  });
});
