import { describe, it, expect } from 'vitest';
import { scoreColor, provinceLevelOf, provinceLevelColor, SCORE_BREAKPOINTS } from './analysis';

// 阶梯分界线：-10 / -5 / -1 / 0 / +1 / +5 / +10
describe('scoreColor', () => {
  it('exposes the documented breakpoints', () => {
    expect([...SCORE_BREAKPOINTS]).toEqual([-10, -5, -1, 0, 1, 5, 10]);
  });

  it('maps positive scores to green tiers', () => {
    expect(scoreColor(1)).toBe('scoreGreenLight');
    expect(scoreColor(4)).toBe('scoreGreenLight');
    expect(scoreColor(5)).toBe('scoreGreenMedium');
    expect(scoreColor(9)).toBe('scoreGreenMedium');
    expect(scoreColor(10)).toBe('scoreGreenDark');
    expect(scoreColor(999)).toBe('scoreGreenDark');
  });

  it('maps zero to gray', () => {
    expect(scoreColor(0)).toBe('gray');
  });

  it('maps negative scores to red tiers', () => {
    expect(scoreColor(-1)).toBe('scoreRedLight');
    expect(scoreColor(-4)).toBe('scoreRedLight');
    expect(scoreColor(-5)).toBe('scoreRedMedium');
    expect(scoreColor(-9)).toBe('scoreRedMedium');
    expect(scoreColor(-10)).toBe('scoreRedDark');
    expect(scoreColor(-999)).toBe('scoreRedDark');
  });
});

describe('provinceLevelOf', () => {
  it('maps score to seven levels at the new breakpoints', () => {
    expect(provinceLevelOf(-10)).toBe('terrible');
    expect(provinceLevelOf(-6)).toBe('poor');
    expect(provinceLevelOf(-5)).toBe('poor');
    expect(provinceLevelOf(-2)).toBe('unfamiliar');
    expect(provinceLevelOf(-1)).toBe('unfamiliar');
    expect(provinceLevelOf(0)).toBe('neutral');
    expect(provinceLevelOf(1)).toBe('beginner');
    expect(provinceLevelOf(4)).toBe('beginner');
    expect(provinceLevelOf(5)).toBe('skilled');
    expect(provinceLevelOf(9)).toBe('skilled');
    expect(provinceLevelOf(10)).toBe('master');
  });
});

describe('provinceLevelColor', () => {
  it('maps level to color', () => {
    expect(provinceLevelColor('terrible')).toBe('scoreRedDark');
    expect(provinceLevelColor('poor')).toBe('scoreRedMedium');
    expect(provinceLevelColor('unfamiliar')).toBe('scoreRedLight');
    expect(provinceLevelColor('neutral')).toBe('gray');
    expect(provinceLevelColor('beginner')).toBe('scoreGreenLight');
    expect(provinceLevelColor('skilled')).toBe('scoreGreenMedium');
    expect(provinceLevelColor('master')).toBe('scoreGreenDark');
  });
});
