import { describe, it, expect } from 'vitest';
import {
  tierOfZoom, chinaMapNameForTier, provinceMapNameForTier,
  TIER_ZOOM_MIN, TIER_KEEP_PCT, ALL_CHINA_MAP_NAMES, ALL_PROVINCE_MAP_NAMES,
  type Tier,
} from './tiers';

const TIERS: Tier[] = ['ultra', 'pro', 'fine', 'plus', 'lossless'];

describe('tierOfZoom', () => {
  it('maps each zoom band to its tier', () => {
    expect(tierOfZoom(1)).toBe('ultra');
    expect(tierOfZoom(3)).toBe('pro');
    expect(tierOfZoom(8)).toBe('fine');
    expect(tierOfZoom(12)).toBe('plus');
    expect(tierOfZoom(20)).toBe('lossless');
  });

  it('treats each threshold as the *first* zoom of the finer tier (inclusive lower bound)', () => {
    // 边界必须归到更精细的一侧，否则 14 会退回 fine，用户放大到 14 反而变糙。
    expect(tierOfZoom(TIER_ZOOM_MIN.pro - 1e-9)).toBe('ultra');
    expect(tierOfZoom(TIER_ZOOM_MIN.pro)).toBe('pro');
    expect(tierOfZoom(TIER_ZOOM_MIN.fine - 1e-9)).toBe('pro');
    expect(tierOfZoom(TIER_ZOOM_MIN.fine)).toBe('fine');
    expect(tierOfZoom(TIER_ZOOM_MIN.plus - 1e-9)).toBe('fine');
    expect(tierOfZoom(TIER_ZOOM_MIN.plus)).toBe('plus');
    expect(tierOfZoom(TIER_ZOOM_MIN.lossless - 1e-9)).toBe('plus');
    expect(tierOfZoom(TIER_ZOOM_MIN.lossless)).toBe('lossless');
  });

  it('covers the极端 zoom values actually reachable in the app', () => {
    // MIN_ZOOM = 0.8 / MAX_ZOOM = 28（见 renderer.ts）
    expect(tierOfZoom(0.8)).toBe('ultra');
    expect(tierOfZoom(28)).toBe('lossless');
  });

  it('forces lossless when drilled, regardless of zoom', () => {
    // 钻省后视口只剩一个省，顶点再多也被视口裁剪挡住 → 不必降精度。
    for (const z of [0.8, 1, 3, 8, 12, 13.9]) expect(tierOfZoom(z, true)).toBe('lossless');
  });

  it('is monotonically non-decreasing in precision as zoom grows', () => {
    const order = TIERS.map((t) => TIER_KEEP_PCT[t]);
    expect(order).toEqual([...order].sort((a, b) => a - b)); // 4 < 8 < 15 < 40 < 100
    let prev = -1;
    for (let z = 0.8; z <= 28; z += 0.1) {
      const idx = TIERS.indexOf(tierOfZoom(z));
      expect(idx).toBeGreaterThanOrEqual(prev); // 绝不允许「放大反而变糙」
      prev = idx;
    }
  });

  it('never skips a tier while zooming in (every tier is reachable)', () => {
    const seen = new Set<Tier>();
    for (let z = 0.8; z <= 28; z += 0.05) seen.add(tierOfZoom(z));
    expect([...seen].sort()).toEqual([...TIERS].sort());
  });
});

describe('tier → map name', () => {
  it('uses the legacy unsuffixed names for the fine tier', () => {
    // 历史命名：地级 fine 档叫 'china'，省级 fine 档叫 'china-provinces'。
    // 改这两名字会让所有既有缓存/测试固件失效，故永久保留。
    expect(chinaMapNameForTier('fine')).toBe('china');
    expect(provinceMapNameForTier('fine')).toBe('china-provinces');
  });

  it('uses -raw as the province lossless name', () => {
    expect(provinceMapNameForTier('lossless')).toBe('china-provinces-raw');
    expect(chinaMapNameForTier('lossless')).toBe('china-lossless');
  });

  it('produces the 5 expected names per family, all distinct', () => {
    expect(ALL_CHINA_MAP_NAMES).toEqual(['china-ultra', 'china-pro', 'china', 'china-plus', 'china-lossless']);
    expect(ALL_PROVINCE_MAP_NAMES).toEqual([
      'china-provinces-ultra', 'china-provinces-pro', 'china-provinces', 'china-provinces-plus', 'china-provinces-raw',
    ]);
    expect(new Set(ALL_CHINA_MAP_NAMES).size).toBe(5);
    expect(new Set(ALL_PROVINCE_MAP_NAMES).size).toBe(5);
  });

  it('keeps prefecture and province namespaces disjoint', () => {
    // 两族若同名会互相覆盖 registerMap，是难以察觉的严重 bug。
    const overlap = ALL_CHINA_MAP_NAMES.filter((n) => ALL_PROVINCE_MAP_NAMES.includes(n));
    expect(overlap).toEqual([]);
  });

  it('agrees with the tier order for every tier', () => {
    for (const t of TIERS) {
      expect(chinaMapNameForTier(t)).toBeTruthy();
      expect(provinceMapNameForTier(t)).toBeTruthy();
    }
  });
});
