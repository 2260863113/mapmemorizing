import { describe, it, expect } from 'vitest';
import { canSubmitScore } from './scoreRules';
import type { RoundResult } from './types';

function result(over: Partial<RoundResult>): RoundResult {
  return {
    mode: 'self',
    scopeProvince: null,
    scopeLabel: '全国',
    totalUnits: 340,
    correct: 0,
    wrong: 0,
    elapsedMs: 1000,
    finishedAt: Date.now(),
    ...over,
  };
}

describe('canSubmitScore', () => {
  it('endless requires coins > 0', () => {
    expect(canSubmitScore(result({ mode: 'endless', coins: 1 }))).toBe(true);
    expect(canSubmitScore(result({ mode: 'endless', coins: 0 }))).toBe(false);
    expect(canSubmitScore(result({ mode: 'endless' }))).toBe(false);
  });

  it('nation scope: correct > 0 and wrong === 0 (allow unfinished)', () => {
    expect(canSubmitScore(result({ scopeProvince: null, correct: 5, wrong: 0 }))).toBe(true);
    expect(canSubmitScore(result({ scopeProvince: null, correct: 5, wrong: 1 }))).toBe(false);
    expect(canSubmitScore(result({ scopeProvince: null, correct: 0, wrong: 0 }))).toBe(false);
  });

  it('world-nation scope: correct > 0 and wrong === 0 (same as nation)', () => {
    expect(canSubmitScore(result({ scopeProvince: '__world_nation__', totalUnits: 195, correct: 5, wrong: 0 }))).toBe(true);
    expect(canSubmitScore(result({ scopeProvince: '__world_nation__', totalUnits: 195, correct: 5, wrong: 1 }))).toBe(false);
    expect(canSubmitScore(result({ scopeProvince: '__world_nation__', totalUnits: 195, correct: 194, wrong: 0 }))).toBe(true);
  });

  it('province scope: must be fully correct', () => {
    expect(canSubmitScore(result({ scopeProvince: '520000', totalUnits: 9, correct: 9, wrong: 0 }))).toBe(true);
    expect(canSubmitScore(result({ scopeProvince: '520000', totalUnits: 9, correct: 8, wrong: 1 }))).toBe(false);
  });

  it('province-nation scope: must be fully correct', () => {
    expect(canSubmitScore(result({ scopeProvince: '__province_nation__', totalUnits: 34, correct: 34, wrong: 0 }))).toBe(true);
    expect(canSubmitScore(result({ scopeProvince: '__province_nation__', totalUnits: 34, correct: 33, wrong: 0 }))).toBe(false);
  });
});
