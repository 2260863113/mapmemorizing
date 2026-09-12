import { describe, it, expect } from 'vitest';
import { worldFaceInteractive, worldFeatureVisible, type WorldFaceContext } from './worldFaces';

/**
 * 本轮的回归锁：下钻（大洲/次区域）之后，**空白区域必须没有任何交互**。
 *
 * 曾经的 bug：非当前范围的面只是没有外观，几何仍在 → 悬停空白处会高亮一个
 * 看不见的国家，点击还会跳到它的上级区域。修复分两层：
 *   - 渲染层把范围外的面画成 `silent` 透明面（ECharts 对 silent region 不发事件、不做 emphasis）；
 *   - 这一层兜底判定 name→iso 回传（下面这些用例）。
 */

const ISO_CONTINENT = new Map<string, string>([
  ['CHN', 'AS'],
  ['JPN', 'AS'],
  ['FRA', 'EU'],
  ['DEU', 'EU'],
  ['BRA', 'SA'],
]);

const ISO_SUBREGION = new Map<string, string>([
  ['CHN', 'EAS'],
  ['JPN', 'EAS'],
  ['THA', 'SEA'],
  ['FRA', 'WEU'],
  ['DEU', 'CEU'],
  ['BRA', 'SAM'],
]);
ISO_CONTINENT.set('THA', 'AS');

function ctx(over: Partial<WorldFaceContext> = {}): WorldFaceContext {
  return { continent: null, subregion: null, isoContinent: ISO_CONTINENT, isoSubregion: ISO_SUBREGION, ...over };
}

const LOOKUPS = {
  nameToIso: new Map<string, string>([
    ['中国', 'CHN'],
    ['日本', 'JPN'],
    ['法国', 'FRA'],
    ['德国', 'DEU'],
    ['巴西', 'BRA'],
  ]),
  decorativeNames: new Set<string>(['南极洲', '格陵兰']),
  excludedNames: new Set<string>(['摩纳哥']),
};

describe('worldFeatureVisible', () => {
  it('makes everything visible in worldwide view', () => {
    expect(worldFeatureVisible(ctx(), 'FRA', false)).toBe(true);
    expect(worldFeatureVisible(ctx(), '', true)).toBe(true); // 全世界时装饰面也照常渲染
  });

  it('keeps only the selected continent when drilled into a continent', () => {
    const c = ctx({ continent: 'EU' });
    expect(worldFeatureVisible(c, 'FRA', false)).toBe(true);
    expect(worldFeatureVisible(c, 'CHN', false)).toBe(false);
    expect(worldFeatureVisible(c, 'BRA', false)).toBe(false);
  });

  it('hides decorative faces once any scope is active', () => {
    expect(worldFeatureVisible(ctx({ continent: 'AS' }), '', true)).toBe(false);
    expect(worldFeatureVisible(ctx({ subregion: 'EAS' }), 'ATA', true)).toBe(false);
  });

  it('lets the subregion scope win over the continent scope', () => {
    const c = ctx({ continent: 'AS', subregion: 'EAS' });
    expect(worldFeatureVisible(c, 'CHN', false)).toBe(true);
    expect(worldFeatureVisible(c, 'THA', false)).toBe(false); // 同属亚洲，但不属东亚
  });
});

describe('worldFaceInteractive (空白区无交互)', () => {
  it('allows answering countries in worldwide view', () => {
    for (const name of ['中国', '日本', '法国', '德国', '巴西']) {
      expect(worldFaceInteractive(ctx(), name, LOOKUPS), name).toBe(true);
    }
  });

  it('treats hidden faces from other continents as blank space after drilling in', () => {
    const c = ctx({ continent: 'EU' });
    // 这正是用户报的 bug：在亚洲视图里悬停/点击法国所在的空白区域
    expect(worldFaceInteractive(c, '法国', LOOKUPS)).toBe(true); // 欧洲视图下法国可见
    expect(worldFaceInteractive(c, '中国', LOOKUPS)).toBe(false); // 亚洲国家不可交互
    expect(worldFaceInteractive(c, '巴西', LOOKUPS)).toBe(false);
  });

  it('treats faces outside the subregion as blank space too', () => {
    const c = ctx({ continent: 'AS', subregion: 'EAS' });
    expect(worldFaceInteractive(c, '中国', LOOKUPS)).toBe(true);
    expect(worldFaceInteractive(c, '日本', LOOKUPS)).toBe(true);
    expect(worldFaceInteractive(c, '泰国', LOOKUPS)).toBe(false); // 未在 nameToIso 里
  });

  it('keeps decorative and excluded faces inert in every scope', () => {
    for (const scope of [ctx(), ctx({ continent: 'EU' }), ctx({ subregion: 'EAS' })]) {
      expect(worldFaceInteractive(scope, '南极洲', LOOKUPS)).toBe(false);
      expect(worldFaceInteractive(scope, '格陵兰', LOOKUPS)).toBe(false);
      expect(worldFaceInteractive(scope, '摩纳哥', LOOKUPS)).toBe(false);
    }
  });

  it('never treats an unknown face name as interactive (click → blank, not drill-up)', () => {
    expect(worldFaceInteractive(ctx(), '某个不存在的面', LOOKUPS)).toBe(false);
    expect(worldFaceInteractive(ctx(), '', LOOKUPS)).toBe(false);
  });
});
