import { describe, it, expect } from 'vitest';
import { cityFollowExtraZoom, worldFollowExtraZoom } from './followBonus';
import { SELF_FOLLOW_ZOOM_BONUS, SELF_FOLLOW_ZOOM_BONUS_AFRICA } from '../modeSettings';
import { InputMode } from './input';
import { makeTestCtx } from '../testCtx';
import type { AppData, Unit } from '../types';

/**
 * 输入模式自由跟随的倍率加成（2026-09 需求 8）。
 *
 * 分两层验：
 *   1. **纯函数**：非洲 6、其余 2，包括「大洲信息缺失」这条边界（数据缺字段时按普通档，别跳到 6x）；
 *   2. **接线**（真的走 `InputMode.ask`）：世界档把大洲换算出的加成交给
 *      `renderer.focusWorldCountry(iso, extra)`，中国地级交给 `renderer.focusUnit(adcode, 2)`。
 *
 * 第 2 层不能省：需求的原话是「输入模式自由跟随下缩放统一 +2x / 非洲 +6x」，
 * 只测纯函数无法证明**模式真的把加成传下去了**（历史上这里传过一个被渲染器忽略的参数）。
 */

const DATA: Partial<AppData> = {
  countries: [
    { iso: 'JPN', name: '日本', fullName: '日本国', center: [138, 36], neighbors: [], continent: 'AS' },
    { iso: 'EGY', name: '埃及', fullName: '阿拉伯埃及共和国', center: [30, 27], neighbors: [], continent: 'AF' },
  ],
  countryNames: { JPN: { en: 'Japan', capital: '东京', capitalEn: 'Tokyo' } },
  provinces: [{ adcode: '440000', name: '广东省', center: [113, 23] }],
  units: [
    { adcode: '440100', name: '广州市', shortName: '广州', province: '广东省', provinceAdcode: '440000', center: [113, 23], neighbors: [], decorative: false },
  ],
  allUnits: [
    { adcode: '440100', name: '广州市', shortName: '广州', province: '广东省', provinceAdcode: '440000', center: [113, 23], neighbors: [], decorative: false },
  ],
};

/** 记录 renderer 收到的跟随调用（adcode/iso + 额外加成）。 */
function makeRecordingCtx() {
  const { ctx, states } = makeTestCtx({ data: DATA });
  const focusUnit: [string, number | undefined][] = [];
  const focusWorld: [string, number | undefined][] = [];
  ctx.renderer.focusUnit = (adcode, extraZoom) => {
    focusUnit.push([adcode, extraZoom]);
  };
  ctx.renderer.focusWorldCountry = (iso, extraZoom) => {
    focusWorld.push([iso, extraZoom]);
  };
  return { ctx, states, focusUnit, focusWorld };
}

/** 造一个最小可用单位（只有 adcode 与所属省对本次断言有意义，其余字段补齐类型）。 */
function unit(adcode: string, name: string, provinceAdcode: string): Unit {
  return { adcode, name, shortName: name, province: '', provinceAdcode, center: [0, 0], neighbors: [] };
}

const scopeQuery = (granularity: 'world' | 'province' | 'city') => ({
  granularity,
  continent: null,
  subregion: null,
  province: null,
});

describe('worldFollowExtraZoom（非洲 +6 / 其余 +2）', () => {
  it('非洲 = +6，其余大洲 = +2', () => {
    expect(worldFollowExtraZoom('AF')).toBe(SELF_FOLLOW_ZOOM_BONUS_AFRICA);
    expect(worldFollowExtraZoom('AF')).toBe(6);
    for (const c of ['AS', 'EU', 'NA', 'SA', 'OC'] as const) {
      expect(worldFollowExtraZoom(c), c).toBe(SELF_FOLLOW_ZOOM_BONUS);
    }
  });

  it('大洲信息缺失（null / undefined）按普通 +2，不跳到 6x', () => {
    expect(worldFollowExtraZoom(null)).toBe(2);
    expect(worldFollowExtraZoom(undefined)).toBe(2);
  });
});

describe('cityFollowExtraZoom（中国地级统一 +2）', () => {
  it('恒为 +2', () => {
    expect(cityFollowExtraZoom()).toBe(2);
    expect(cityFollowExtraZoom()).toBe(SELF_FOLLOW_ZOOM_BONUS);
  });
});

describe('InputMode.ask 把加成真的传给渲染器', () => {
  it('世界档：普通国家 +2、非洲国家 +6', () => {
    const { ctx, focusWorld } = makeRecordingCtx();
    const mode = new InputMode(ctx);
    mode.applyScopeQuery(scopeQuery('world'));
    mode.ask(unit('JPN', '日本', ''));
    mode.ask(unit('EGY', '埃及', ''));
    expect(focusWorld).toEqual([
      ['JPN', 2],
      ['EGY', 6],
    ]);
  });

  it('中国地级：走 focusUnit 且 +2（不再是那个被忽略的 12）', () => {
    const { ctx, focusUnit } = makeRecordingCtx();
    const mode = new InputMode(ctx);
    mode.applyScopeQuery(scopeQuery('city'));
    mode.ask(unit('440100', '广州市', '440000'));
    expect(focusUnit).toEqual([['440100', 2]]);
  });

  it('省级全国：保持全国视野，不聚焦（无加成可言）', () => {
    const { ctx, focusUnit, focusWorld } = makeRecordingCtx();
    const mode = new InputMode(ctx);
    mode.applyScopeQuery(scopeQuery('province'));
    mode.ask(unit('440000', '广东省', '440000'));
    expect(focusUnit).toEqual([]);
    expect(focusWorld).toEqual([]);
  });
});
