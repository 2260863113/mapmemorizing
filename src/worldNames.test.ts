import { describe, it, expect } from 'vitest';
import { normalizeCountryName, stripStateSuffix, WorldMatcher } from './worldNames';
import type { CountryMeta } from './types';

function c(iso: string, name: string, fullName: string): CountryMeta {
  return { iso, name, fullName, center: [0, 0], neighbors: [] };
}

const FIXTURES: CountryMeta[] = [
  c('CHN', '中国', '中华人民共和国'),
  c('USA', '美国', '美利坚合众国'),
  c('RUS', '俄罗斯', '俄罗斯联邦'),
  c('COD', '刚果（金）', '刚果民主共和国'),
  c('COG', '刚果（布）', '刚果共和国'),
  c('LAO', '老挝', '老挝人民民主共和国'),
  c('CHE', '瑞士', '瑞士联邦'),
  c('KOR', '韩国', '大韩民国'),
];

describe('normalizeCountryName', () => {
  it('trims, lowercases and collapses whitespace', () => {
    expect(normalizeCountryName('  中 国 ')).toBe('中 国');
    expect(normalizeCountryName(' USA ')).toBe('usa');
  });

  it('converts full-width to half-width', () => {
    expect(normalizeCountryName('ＵＳＡ')).toBe('usa');
  });
});

describe('stripStateSuffix', () => {
  it('strips political suffixes repeatedly', () => {
    expect(stripStateSuffix('中华人民共和国')).toBe('中华');
    expect(stripStateSuffix('美利坚合众国')).toBe('美利坚');
    expect(stripStateSuffix('俄罗斯联邦')).toBe('俄罗斯');
    expect(stripStateSuffix('老挝人民民主共和国')).toBe('老挝人民');
    expect(stripStateSuffix('瑞士联邦')).toBe('瑞士');
    expect(stripStateSuffix('大韩民国')).toBe('大韩民国');
  });

  it('leaves plain names unchanged', () => {
    expect(stripStateSuffix('新西兰')).toBe('新西兰');
  });
});

describe('WorldMatcher.bestMatch', () => {
  const m = new WorldMatcher(FIXTURES);

  it('matches by short name', () => {
    expect(m.bestMatch('中国')).toBe('CHN');
    expect(m.bestMatch('美国')).toBe('USA');
    expect(m.bestMatch('俄罗斯')).toBe('RUS');
  });

  it('matches by official full name', () => {
    expect(m.bestMatch('中华人民共和国')).toBe('CHN');
    expect(m.bestMatch('美利坚合众国')).toBe('USA');
    expect(m.bestMatch('俄罗斯联邦')).toBe('RUS');
  });

  it('matches parenthesized Congo disambiguators only', () => {
    expect(m.bestMatch('刚果（金）')).toBe('COD');
    expect(m.bestMatch('刚果（布）')).toBe('COG');
    // 剥后缀后重名的「刚果」被剔除，避免歧义命中
    expect(m.bestMatch('刚果')).toBe(null);
  });

  it('returns null on unknown / empty input', () => {
    expect(m.bestMatch('亚特兰蒂斯')).toBe(null);
    expect(m.bestMatch('')).toBe(null);
    expect(m.bestMatch('   ')).toBe(null);
  });

  it('matches official full names with suffix stripped to short name (e.g. 联邦)', () => {
    expect(m.bestMatch('俄罗斯')).toBe('RUS');
    expect(m.bestMatch('瑞士联邦')).toBe('CHE');
  });
});
