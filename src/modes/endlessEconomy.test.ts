import { describe, it, expect } from 'vitest';
import {
  cumulativeTarget,
  coinValue,
  floatUpIncrement,
  nextPrice,
  cloverBonus,
  tokenBonus,
  foodBonus,
  hourglassSeconds,
  tokenMatchesName,
  rollShopKeys,
  intBetween,
  BASE_TARGET,
} from './endlessEconomy';

const zeroRng = () => 0; // intBetween 总是取 min
const halfRng = () => 0.499; // 落在区间中点附近

describe('intBetween', () => {
  it('is inclusive on both ends', () => {
    expect(intBetween(() => 0, 3, 5)).toBe(3);
    expect(intBetween(() => 0.9999, 3, 5)).toBe(5);
  });
});

describe('cumulativeTarget', () => {
  it('grows geometrically', () => {
    expect(cumulativeTarget(1)).toBe(BASE_TARGET);
    expect(cumulativeTarget(2)).toBe(BASE_TARGET + Math.round(BASE_TARGET * 1.1));
    expect(cumulativeTarget(3)).toBeGreaterThan(cumulativeTarget(2));
  });
});

describe('coinValue', () => {
  it('maps -1 → COIN_MIN, 1 → COIN_MAX, 0 → mid-low (squared mapping)', () => {
    expect(coinValue(-1)).toBe(50);
    expect(coinValue(1)).toBe(400);
    expect(coinValue(0)).toBe(140); // 50 + 0.25 * 350 = 137.5 → round到10 = 140
  });

  it('clamps out-of-range noise', () => {
    expect(coinValue(-5)).toBe(50);
    expect(coinValue(5)).toBe(400);
  });
});

describe('floatUpIncrement', () => {
  it('uses coarser increments for higher coin tiers', () => {
    expect(floatUpIncrement(zeroRng, 50)).toBe(30);
    expect(floatUpIncrement(zeroRng, 150)).toBe(20);
    expect(floatUpIncrement(zeroRng, 350)).toBe(10);
    expect(floatUpIncrement(zeroRng, 600)).toBe(5);
  });
});

describe('nextPrice', () => {
  it('adds 80-120 to current price', () => {
    expect(nextPrice(zeroRng, 100)).toBe(180);
    expect(nextPrice(() => 0.9999, 100)).toBe(220);
  });
});

describe('item bonuses', () => {
  it('clover/token/food cap at the city value', () => {
    expect(cloverBonus(zeroRng, 1000)).toBe(50);
    expect(cloverBonus(zeroRng, 30)).toBe(30);
    expect(tokenBonus(zeroRng, 1000, 2)).toBe(150); // 50 + 2*50
    expect(tokenBonus(zeroRng, 60, 5)).toBe(60);
    expect(foodBonus(zeroRng, 40)).toBe(40);
  });

  it('hourglass is 3-5 seconds', () => {
    expect(hourglassSeconds(zeroRng)).toBe(3);
    expect(hourglassSeconds(() => 0.9999)).toBe(5);
  });
});

describe('tokenMatchesName', () => {
  it('matches token in name or shortName', () => {
    expect(tokenMatchesName('阳', '沈阳市', '沈阳')).toBe(true);
    expect(tokenMatchesName('南', '南京市', '南京')).toBe(true);
    expect(tokenMatchesName('海', '石家庄市', '石家庄')).toBe(false);
  });

  it('「州」excludes the one inside 自治州', () => {
    expect(tokenMatchesName('州', '黔南布依族苗族自治州', '黔南')).toBe(false);
    expect(tokenMatchesName('州', '广州市', '广州')).toBe(true);
  });

  it('empty token never matches', () => {
    expect(tokenMatchesName('', '广州市', '广州')).toBe(false);
  });
});

describe('rollShopKeys', () => {
  it('keeps keys with rng < 0.5', () => {
    expect(rollShopKeys(() => 0.1, ['a', 'b'])).toEqual(['a', 'b']);
    expect(rollShopKeys(() => 0.9, ['a', 'b'])).toEqual([]);
  });
});
