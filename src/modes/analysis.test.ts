import { describe, it, expect } from 'vitest';
import { scoreColor, provinceLevelOf, provinceLevelColor } from './analysis';

describe('scoreColor', () => {
  it('maps positive scores to green tiers', () => {
    expect(scoreColor(1)).toBe('scoreGreenLight');
    expect(scoreColor(2)).toBe('scoreGreenLight');
    expect(scoreColor(3)).toBe('scoreGreenMedium');
    expect(scoreColor(4)).toBe('scoreGreenMedium');
    expect(scoreColor(5)).toBe('scoreGreenDark');
    expect(scoreColor(999)).toBe('scoreGreenDark');
  });

  it('maps zero to gray', () => {
    expect(scoreColor(0)).toBe('gray');
  });

  it('maps negative scores to red tiers', () => {
    expect(scoreColor(-1)).toBe('scoreRedLight');
    expect(scoreColor(-2)).toBe('scoreRedLight');
    expect(scoreColor(-3)).toBe('scoreRedMedium');
    expect(scoreColor(-4)).toBe('scoreRedMedium');
    expect(scoreColor(-5)).toBe('scoreRedDark');
    expect(scoreColor(-999)).toBe('scoreRedDark');
  });
});

describe('provinceLevelOf', () => {
  it('maps score to seven levels', () => {
    expect(provinceLevelOf(-5)).toBe('terrible');
    expect(provinceLevelOf(-3)).toBe('poor');
    expect(provinceLevelOf(-1)).toBe('unfamiliar');
    expect(provinceLevelOf(0)).toBe('neutral');
    expect(provinceLevelOf(1)).toBe('beginner');
    expect(provinceLevelOf(3)).toBe('skilled');
    expect(provinceLevelOf(5)).toBe('master');
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