import { describe, it, expect } from 'vitest';
import { normalize, normalizeProvince, Matcher } from './matcher';
import type { AppData, Unit, Province } from './types';

describe('normalize', () => {
  it('strips whitespace and lowercases', () => {
    expect(normalize('  黔南  ')).toBe('黔南');
  });

  it('converts full-width to half-width', () => {
    expect(normalize('黔南布依族苗族自治州')).toBe('黔南');
  });

  it('strips ethnic words and administrative suffixes', () => {
    expect(normalize('黔南布依族苗族自治州')).toBe('黔南');
    expect(normalize('恩施土家族苗族自治州')).toBe('恩施');
    expect(normalize('延边朝鲜族自治州')).toBe('延边');
  });

  it('handles the "州" suffix without 族 (伊犁哈萨克自治州)', () => {
    expect(normalize('伊犁哈萨克自治州')).toBe('伊犁');
  });

  it('does not harm ordinary names like 白山市 / 满洲里', () => {
    expect(normalize('白山市')).toBe('白山');
    expect(normalize('满洲里')).toBe('满洲里');
  });

  it('strips repeated suffixes', () => {
    expect(normalize('北京市')).toBe('北京');
    expect(normalize('神农架林区')).toBe('神农架');
  });
});

describe('normalizeProvince', () => {
  it('strips province suffixes', () => {
    expect(normalizeProvince('海南省')).toBe('海南');
    expect(normalizeProvince('新疆维吾尔自治区')).toBe('新疆');
    expect(normalizeProvince('广西壮族自治区')).toBe('广西');
    expect(normalizeProvince('香港特别行政区')).toBe('香港');
    expect(normalizeProvince('北京市')).toBe('北京');
  });

  it('keeps names without suffixes unchanged', () => {
    expect(normalizeProvince('贵州')).toBe('贵州');
  });
});

function unit(adcode: string, name: string, shortName: string, province: string, provinceAdcode: string): Unit {
  return { adcode, name, shortName, province, provinceAdcode, center: [0, 0], neighbors: [], decorative: false };
}

describe('Matcher.bestUnit', () => {
  const data: AppData = {
    units: [
      unit('522700', '黔南布依族苗族自治州', '黔南', '贵州省', '520000'),
      unit('422800', '恩施土家族苗族自治州', '恩施', '湖北省', '420000'),
    ],
    allUnits: [],
    provinces: [{ adcode: '520000', name: '贵州省', center: [0, 0] }],
    geoJson: null,
    provincesGeoJson: null,
  };
  const m = new Matcher(data);

  it('matches by exact normalized short name', () => {
    expect(m.bestUnit('黔南')?.adcode).toBe('522700');
  });

  it('matches by full official name', () => {
    expect(m.bestUnit('黔南布依族苗族自治州')?.adcode).toBe('522700');
  });

  it('matches abbreviated 黔南州', () => {
    expect(m.bestUnit('黔南州')?.adcode).toBe('522700');
  });

  it('does not fuzzy-match wrong answers (exact only)', () => {
    // 编辑距离容错不用于判题：错别字「黔南洲」不得命中
    expect(m.bestUnit('黔南洲')).toBeNull();
    // 缺少「自治州」后缀时民族词剥离不触发（避免误伤普通地名），故不命中
    expect(m.bestUnit('黔南布依族苗族')).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(m.bestUnit('  ')).toBeNull();
  });
});
