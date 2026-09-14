import { describe, it, expect } from 'vitest';
import { normalizeCountryName, stripStateSuffix, WorldMatcher } from './worldNames';
import type { CountryMeta, CountryNames } from './types';

function c(iso: string, name: string, fullName: string): CountryMeta {
  return { iso, name, fullName, center: [0, 0], neighbors: [], continent: 'AS' };
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

/**
 * 「国名 / 首都」+「中文 / 英文」口径下的匹配（2026-09 新增）。
 *
 * 口径：**改的是考什么，就只接受什么** —— 首都档只认首都名；而中/英文是同一个名字的两种写法，
 * 故两种都接受（语言开关只换显示文字，不改变"考什么"）。
 */
describe('WorldMatcher · 首都档与英文（acceptsCapital）', () => {
  const NAMES: Record<string, CountryNames> = {
    CHN: { en: 'China', capital: '北京', capitalEn: 'Beijing' },
    USA: { en: 'United States of America', capital: '华盛顿哥伦比亚特区', capitalEn: 'Washington' },
    JPN: { en: 'Japan', capital: '东京', capitalEn: 'Tokyo' },
  };
  const m = new WorldMatcher([...FIXTURES, c('JPN', '日本', '日本国')], NAMES);

  it('首都档认得首都中英文名，但**不认**国名', () => {
    expect(m.acceptsCapital('CHN', '北京')).toBe(true);
    expect(m.acceptsCapital('CHN', 'Beijing')).toBe(true);
    expect(m.acceptsCapital('JPN', '东京')).toBe(true);
    expect(m.acceptsCapital('JPN', 'Tokyo')).toBe(true);
    // 首都档答国名 → 不算对（与「简称档不认省名」同一口径）
    expect(m.acceptsCapital('CHN', '中国')).toBe(false);
    expect(m.acceptsCapital('JPN', 'Japan')).toBe(false);
  });

  it('国名档不认首都（反向也要挡住）', () => {
    expect(m.bestMatch('东京')).toBe(null);
    expect(m.bestMatch('Tokyo')).toBe(null);
  });

  it('英文国名可命中，且英文常用别名也接受（USA：United States / America）', () => {
    expect(m.bestMatch('Japan')).toBe('JPN');
    expect(m.bestMatch('china')).toBe('CHN');
    expect(m.bestMatch('United States')).toBe('USA');
    expect(m.bestMatch('USA')).toBe('USA');
    expect(m.bestMatch('America')).toBe('USA');
  });

  it('首都的接受别名：数据源的长名与实际首都都可接受（美国等）', () => {
    expect(m.acceptsCapital('USA', '华盛顿')).toBe(true); // 数据给「华盛顿哥伦比亚特区」，别名补「华盛顿」
    expect(m.acceptsCapital('USA', 'Washington DC')).toBe(true);
  });

  it('首都档不会认成别国的首都（跨国家隔离）', () => {
    expect(m.acceptsCapital('JPN', '北京')).toBe(false);
    expect(m.acceptsCapital('CHN', 'Tokyo')).toBe(false);
  });

  it('没有名字数据时首都档安全返回 false（不抛错、不误判）', () => {
    const bare = new WorldMatcher(FIXTURES);
    expect(bare.acceptsCapital('CHN', '北京')).toBe(false);
    // 国名档不受影响
    expect(bare.bestMatch('中国')).toBe('CHN');
  });

  it('跨国同形首都名（金斯敦：牙买加 Kingston / 圣文森特 Kingstown）两国都算对', () => {
    // 回归闸门：早期实现沿用国名档的「重名剔除」，于是这两国在中文首都档**永远答不出来**。
    const homonym = new WorldMatcher(
      [...FIXTURES, c('JAM', '牙买加', '牙买加'), c('VCT', '圣文森特和格林纳丁斯', '圣文森特和格林纳丁斯')],
      {
        JAM: { en: 'Jamaica', capital: '金斯敦', capitalEn: 'Kingston' },
        VCT: { en: 'Saint Vincent and the Grenadines', capital: '金斯敦', capitalEn: 'Kingstown' },
      },
    );
    expect(homonym.acceptsCapital('JAM', '金斯敦')).toBe(true);
    expect(homonym.acceptsCapital('VCT', '金斯敦')).toBe(true);
    // 英文名不同形，各自仍只认自己的那个
    expect(homonym.acceptsCapital('JAM', 'Kingstown')).toBe(false);
    expect(homonym.acceptsCapital('VCT', 'Kingston')).toBe(false);
  });
});
