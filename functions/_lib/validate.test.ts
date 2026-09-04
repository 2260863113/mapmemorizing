import { describe, it, expect } from 'vitest';
import { ApiError } from './http';
import { cleanUsername, normalizePasswordHash, validMode, validateScore, isBetter } from './validate';

describe('cleanUsername', () => {
  it('trims, collapses whitespace, and truncates to 24', () => {
    expect(cleanUsername('  张三  ')).toBe('张三');
    expect(cleanUsername('  张三  李四  ')).toBe('张三 李四');
    expect(cleanUsername('a'.repeat(30))).toBe('a'.repeat(24));
  });

  it('returns empty for non-strings', () => {
    expect(cleanUsername(undefined)).toBe('');
    expect(cleanUsername(null)).toBe('');
    expect(cleanUsername(123)).toBe('');
  });
});

describe('normalizePasswordHash', () => {
  const valid = { algorithm: 'PBKDF2-SHA-256', salt: 'YWJjZA==', hash: 'YWJjZA==', iterations: 120000 };

  it('accepts valid structure', () => {
    expect(normalizePasswordHash(valid)).toEqual(valid);
  });

  it('rejects wrong algorithm / low iterations / bad base64', () => {
    expect(() => normalizePasswordHash({ ...valid, algorithm: 'MD5' })).toThrow(ApiError);
    expect(() => normalizePasswordHash({ ...valid, iterations: 1000 })).toThrow(ApiError);
    expect(() => normalizePasswordHash({ ...valid, salt: '!!!' })).toThrow(ApiError);
    expect(() => normalizePasswordHash(null)).toThrow(ApiError);
  });
});

describe('validMode', () => {
  it('accepts self/click/endless only', () => {
    expect(validMode('self')).toBe(true);
    expect(validMode('click')).toBe(true);
    expect(validMode('endless')).toBe(true);
    expect(validMode('daily')).toBe(false);
    expect(validMode('bogus')).toBe(false);
  });
});

describe('validateScore', () => {
  const base = {
    mode: 'self',
    scopeProvince: null,
    scopeLabel: '全国',
    totalUnits: 10,
    correct: 10,
    wrong: 0,
    elapsedMs: 1000,
    finishedAt: Date.now(),
  } as const;

  it('rejects garbage score shapes', () => {
    expect(() => validateScore(null)).toThrow(ApiError);
    expect(() => validateScore({ mode: 'self' })).toThrow(ApiError);
  });

  it('rejects stale finishedAt', () => {
    expect(() => validateScore({ ...base, finishedAt: Date.now() - 10 * 60 * 1000 })).toThrow(ApiError);
  });

  it('rejects invalid scope (non-null, non-6-digit, non-sentinel)', () => {
    expect(() => validateScore({ ...base, scopeProvince: 'garbage' })).toThrow(ApiError);
    expect(() => validateScore({ ...base, scopeProvince: '__province_nation__', totalUnits: 34, correct: 33 })).toThrow(ApiError);
  });

  it('accepts 6-digit province scope fully correct', () => {
    expect(validateScore({ ...base, scopeProvince: '520000', totalUnits: 9, correct: 9 })).toMatchObject({ scopeProvince: '520000' });
  });

  it('endless requires coins', () => {
    expect(() => validateScore({ ...base, mode: 'endless', totalUnits: 0, correct: 0, coins: 0 })).toThrow(ApiError);
    expect(validateScore({ ...base, mode: 'endless', totalUnits: 0, correct: 0, coins: 5, level: 3 })).toMatchObject({ coins: 5, level: 3 });
  });
});

describe('isBetter', () => {
  const existing = { coins: 10, level: 2, correct: 5, elapsed_ms: 1000 };

  it('endless: more coins wins, then level', () => {
    expect(isBetter({ mode: 'endless', coins: 11, level: 1 } as never, existing)).toBe(true);
    expect(isBetter({ mode: 'endless', coins: 10, level: 3 } as never, existing)).toBe(true);
    expect(isBetter({ mode: 'endless', coins: 9, level: 9 } as never, existing)).toBe(false);
  });

  it('nation: more correct wins, then faster', () => {
    expect(isBetter({ mode: 'self', scopeProvince: null, correct: 6, elapsedMs: 9999 } as never, existing)).toBe(true);
    expect(isBetter({ mode: 'self', scopeProvince: null, correct: 5, elapsedMs: 999 } as never, existing)).toBe(true);
    expect(isBetter({ mode: 'self', scopeProvince: null, correct: 5, elapsedMs: 1001 } as never, existing)).toBe(false);
  });

  it('province: faster wins', () => {
    expect(isBetter({ mode: 'click', scopeProvince: '520000', correct: 5, elapsedMs: 999 } as never, existing)).toBe(true);
    expect(isBetter({ mode: 'click', scopeProvince: '520000', correct: 5, elapsedMs: 1001 } as never, existing)).toBe(false);
  });
});
