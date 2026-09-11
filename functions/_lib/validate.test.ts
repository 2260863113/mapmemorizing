import { describe, it, expect } from 'vitest';
import { ApiError } from './http';
import { cleanUsername, isContinentScope, isSubregionScope, isWorldScope, normalizePasswordHash, validMode, validateScore, isBetter, SUBREGION_IDS } from './validate';

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

  it('accepts continent scopes and treats them like world-nation', () => {
    for (const id of ['AS', 'EU', 'AF', 'NA', 'SA', 'OC']) {
      const scope = `__continent_${id}__`;
      expect(validateScore({ ...base, scopeProvince: scope, totalUnits: 46, correct: 5, wrong: 0 })).toMatchObject({ scopeProvince: scope });
      expect(validateScore({ ...base, scopeProvince: scope, totalUnits: 46, correct: 46, wrong: 0 })).toMatchObject({ scopeProvince: scope });
    }
    // 与大洲榜同语义：不要求答完，但必须全对
    expect(() => validateScore({ ...base, scopeProvince: '__continent_AS__', totalUnits: 46, correct: 5, wrong: 1 })).toThrow(ApiError);
    expect(() => validateScore({ ...base, scopeProvince: '__continent_AS__', totalUnits: 46, correct: 0, wrong: 0 })).toThrow(ApiError);
  });

  it('rejects malformed continent-like scopes (whitelist cannot be widened)', () => {
    expect(() => validateScore({ ...base, scopeProvince: '__continent_XX__' })).toThrow(ApiError);
    expect(() => validateScore({ ...base, scopeProvince: '__continent_AS_' })).toThrow(ApiError);
    expect(() => validateScore({ ...base, scopeProvince: '__continent___' })).toThrow(ApiError);
    expect(() => validateScore({ ...base, scopeProvince: '__continent_AS__x' })).toThrow(ApiError);
  });

  it('isContinentScope matches only the six known ids', () => {
    expect(isContinentScope('__continent_AS__')).toBe(true);
    expect(isContinentScope('__continent_OC__')).toBe(true);
    expect(isContinentScope('__continent_XX__')).toBe(false);
    expect(isContinentScope('__world_nation__')).toBe(false);
    expect(isContinentScope(null)).toBe(false);
    expect(isContinentScope(undefined)).toBe(false);
  });

  it('accepts subregion scopes and treats them like world-nation (Q10：次区域独立榜)', () => {
    for (const id of SUBREGION_IDS) {
      const scope = `__subregion_${id}__`;
      expect(validateScore({ ...base, scopeProvince: scope, totalUnits: 11, correct: 3, wrong: 0 })).toMatchObject({ scopeProvince: scope });
    }
    // 与世界/大洲榜同语义：不要求答完，但必须全对
    expect(() => validateScore({ ...base, scopeProvince: '__subregion_EAS__', totalUnits: 5, correct: 3, wrong: 1 })).toThrow(ApiError);
    expect(() => validateScore({ ...base, scopeProvince: '__subregion_EAS__', totalUnits: 5, correct: 0, wrong: 0 })).toThrow(ApiError);
  });

  it('rejects malformed subregion-like scopes', () => {
    expect(() => validateScore({ ...base, scopeProvince: '__subregion_XXX__' })).toThrow(ApiError);
    expect(() => validateScore({ ...base, scopeProvince: '__subregion_EAS_' })).toThrow(ApiError);
    expect(() => validateScore({ ...base, scopeProvince: '__subregion___' })).toThrow(ApiError);
    expect(() => validateScore({ ...base, scopeProvince: '__subregion_eas__' })).toThrow(ApiError); // 大小写敏感
  });

  it('subregion and continent prefixes do not shadow each other', () => {
    // 两个前缀互不为前缀，且都以 __ 结尾 —— 解析器必须走各自的分支
    expect(isContinentScope('__subregion_EAS__')).toBe(false);
    expect(isSubregionScope('__continent_AS__')).toBe(false);
    expect(isWorldScope('__subregion_EAS__')).toBe(true);
    expect(isWorldScope('__continent_AS__')).toBe(true);
    expect(isWorldScope('__world_nation__')).toBe(true);
    expect(isWorldScope('__province_nation__')).toBe(false);
    expect(isWorldScope('520000')).toBe(false);
  });

  it('ranks subregion scopes by correct count, like the world board', () => {
    const existingRow = { coins: 0, level: 1, correct: 5, elapsed_ms: 1000 };
    expect(isBetter({ mode: 'click', scopeProvince: '__subregion_EAS__', correct: 6, elapsedMs: 9999 } as never, existingRow)).toBe(true);
    expect(isBetter({ mode: 'click', scopeProvince: '__subregion_EAS__', correct: 5, elapsedMs: 999 } as never, existingRow)).toBe(true);
    expect(isBetter({ mode: 'click', scopeProvince: '__subregion_EAS__', correct: 5, elapsedMs: 1001 } as never, existingRow)).toBe(false);
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

  it('world-nation: more correct wins, then faster (same as nation)', () => {
    expect(isBetter({ mode: 'click', scopeProvince: '__world_nation__', correct: 6, elapsedMs: 9999 } as never, existing)).toBe(true);
    expect(isBetter({ mode: 'click', scopeProvince: '__world_nation__', correct: 5, elapsedMs: 999 } as never, existing)).toBe(true);
    expect(isBetter({ mode: 'click', scopeProvince: '__world_nation__', correct: 5, elapsedMs: 1001 } as never, existing)).toBe(false);
  });

  it('province: faster wins', () => {
    expect(isBetter({ mode: 'click', scopeProvince: '520000', correct: 5, elapsedMs: 999 } as never, existing)).toBe(true);
    expect(isBetter({ mode: 'click', scopeProvince: '520000', correct: 5, elapsedMs: 1001 } as never, existing)).toBe(false);
  });
});
