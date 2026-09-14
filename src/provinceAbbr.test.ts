import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { isProvinceAbbrInput, provinceAbbr, provinceAbbrInputs, provinceShortName } from './province';
import { makeAppData } from './testFixture';
import type { Province } from './types';

/**
 * 省级单字简称（京/沪/粤…）的口径测试。
 *
 * 表在 `province-abbr.json`，但它是**判题与显示口径**：写错一个 adcode 或漏一个省，
 * 表现是「某个省永远出不了简称题」这种只会在真机上偶发的问题。故这里既断表本身，
 * 也断它与真实数据（units.json 的 34 个省）的一致性。
 */

const REAL = JSON.parse(
  readFileSync(path.join(process.cwd(), 'public', 'data', 'units.json'), 'utf8'),
) as { provinces: Province[] };

const realData = makeAppData({ provinces: REAL.provinces });

describe('省级简称表 × 真实数据', () => {
  it('34 个省级单位都有单字简称（缺一个就会回落成去后缀省名，此处会暴露）', () => {
    expect(REAL.provinces.length).toBe(34);
    for (const p of REAL.provinces) {
      const abbr = provinceAbbr(realData, p.adcode);
      expect(abbr, `${p.name}(${p.adcode}) 没有简称`).toHaveLength(1);
      expect(abbr, `${p.name} 的简称不应等于去后缀省名`).not.toBe(provinceShortName(realData, p.adcode));
    }
  });

  it('34 个简称互不重复（简称必须唯一，否则判题无法定位到省）', () => {
    const abbrs = REAL.provinces.map((p) => provinceAbbr(realData, p.adcode));
    expect(new Set(abbrs).size).toBe(abbrs.length);
  });

  it('抽查常见简称', () => {
    const byName = new Map(REAL.provinces.map((p) => [p.name, p.adcode]));
    const cases: [string, string][] = [
      ['北京市', '京'],
      ['上海市', '沪'],
      ['广东省', '粤'],
      ['内蒙古自治区', '蒙'],
      ['新疆维吾尔自治区', '新'],
      ['四川省', '川'],
      ['香港特别行政区', '港'],
      ['澳门特别行政区', '澳'],
    ];
    for (const [name, abbr] of cases) {
      const adcode = byName.get(name);
      expect(adcode, name).toBeTruthy();
      expect(provinceAbbr(realData, adcode!), name).toBe(abbr);
    }
  });
});

describe('provinceAbbr / provinceAbbrInputs', () => {
  const data = makeAppData({
    provinces: [
      { adcode: '310000', name: '上海市', center: [0, 0] },
      { adcode: '510000', name: '四川省', center: [0, 0] },
    ],
  });

  it('表里没有的 adcode 回落去后缀省名（调用方永远拿得到可显示文本）', () => {
    expect(provinceAbbr(data, '999999')).toBe('999999');
    expect(provinceAbbrInputs(data, '999999')).toEqual(['999999']);
  });

  it('别名（川/蜀）只进「接受的输入」，显示仍是主简称', () => {
    expect(provinceAbbrInputs(data, '510000')).toEqual(['川', '蜀']);
    expect(provinceAbbr(data, '510000')).toBe('川');
  });
});

describe('isProvinceAbbrInput（简称档判题）', () => {
  const data = makeAppData({
    provinces: [
      { adcode: '310000', name: '上海市', center: [0, 0] },
      { adcode: '510000', name: '四川省', center: [0, 0] },
    ],
  });

  it('认主简称与别名，忽略首尾空白', () => {
    expect(isProvinceAbbrInput(data, '310000', '沪')).toBe(true);
    expect(isProvinceAbbrInput(data, '310000', ' 沪 ')).toBe(true);
    expect(isProvinceAbbrInput(data, '510000', '蜀')).toBe(true);
    expect(isProvinceAbbrInput(data, '510000', '川')).toBe(true);
  });

  it('**不认**省全名与去后缀省名（简称档考的就是这条记忆，口径见 province.ts）', () => {
    expect(isProvinceAbbrInput(data, '310000', '上海')).toBe(false);
    expect(isProvinceAbbrInput(data, '310000', '上海市')).toBe(false);
    expect(isProvinceAbbrInput(data, '510000', '四川')).toBe(false);
  });

  it('空输入与不相干的字都不算对', () => {
    expect(isProvinceAbbrInput(data, '310000', '')).toBe(false);
    expect(isProvinceAbbrInput(data, '310000', '京')).toBe(false);
  });
});
