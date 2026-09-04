import { describe, it, expect } from 'vitest';
import { ApiError } from './http';
import { cleanBoardText, cleanPlainText, parsePositiveInt, parseBefore, parseLimit } from './board';

describe('cleanBoardText / cleanPlainText', () => {
  it('trims and enforces unicode-codepoint max length', () => {
    expect(cleanBoardText('  你好  ', 200)).toBe('你好');
    expect(cleanBoardText('', 200)).toBe(null);
    expect(cleanBoardText(123 as never, 200)).toBe(null);
    expect(cleanBoardText('ab', 1)).toBe(null);
    expect(cleanPlainText('  标题  ', 60)).toBe('标题');
  });

  it('counts CJK as 1 codepoint', () => {
    expect(cleanBoardText('中文测试', 4)).toBe('中文测试');
    expect(cleanBoardText('中文测试', 3)).toBe(null);
  });
});

describe('parsePositiveInt', () => {
  it('parses valid positive ints', () => {
    expect(parsePositiveInt('42', 'id')).toBe(42);
  });

  it('rejects missing / non-int / non-positive', () => {
    expect(() => parsePositiveInt(undefined, 'id')).toThrow(ApiError);
    expect(() => parsePositiveInt('abc', 'id')).toThrow(ApiError);
    expect(() => parsePositiveInt('-1', 'id')).toThrow(ApiError);
    expect(() => parsePositiveInt('0', 'id')).toThrow(ApiError);
    expect(() => parsePositiveInt('1.5', 'id')).toThrow(ApiError);
  });
});

describe('parseBefore', () => {
  it('treats missing/0 as from-latest', () => {
    expect(parseBefore(null)).toBe(0);
    expect(parseBefore('0')).toBe(0);
  });

  it('rejects negative / non-int', () => {
    expect(() => parseBefore('-1')).toThrow(ApiError);
    expect(() => parseBefore('abc')).toThrow(ApiError);
  });
});

describe('parseLimit', () => {
  it('defaults to DEFAULT_LIMIT on invalid, clamps to MAX_LIMIT', () => {
    expect(parseLimit(null)).toBe(20);
    expect(parseLimit('abc')).toBe(20);
    expect(parseLimit('0')).toBe(20);
    expect(parseLimit('5')).toBe(5);
    expect(parseLimit('9999')).toBe(50);
  });
});
