import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { isProvinceCapitalInput, provinceCapital, provinceShortName } from './province';
import { makeAppData } from './testFixture';
import type { Province } from './types';

/**
 * 省级省会的口径测试（表在 `src/province-capital.json`，与 `province-abbr.json` 同一手法）。
 *
 * 为什么值得逐条断言：省会是**判题与显示口径**，写错一个 adcode 或漏一个省，表现是
 * 「某个省的省会题永远显示省名」或「输入正确的省会却判错」—— 只在真机上随机抽到那个省时才暴露。
 * 故这里既断表本身，也断它与真实数据（units.json 的 34 个省级单位）的一致性。
 */

const REAL = JSON.parse(
  readFileSync(path.join(process.cwd(), 'public', 'data', 'units.json'), 'utf8'),
) as { provinces: Province[] };

const realData = makeAppData({ provinces: REAL.provinces });

/**
 * 直辖市与特别行政区（京津沪渝港澳）：**省会就是它自己**（北京市政府驻北京市）。
 * 这是事实而不是占位，故这几条「省会 == 去后缀省名」是预期的，不算回落；其余 28 条必须严格不同
 * —— 否则等于省会表漏了一条，回落成了省名（用户看到的会是"省会题显示省名"）。
 */
const SELF_CAPITAL = new Set(['110000', '120000', '310000', '500000', '810000', '820000']);

describe('省级省会表 × 真实数据', () => {
  it('34 个省级单位都有省会，且除京津沪渝港澳外不与省名相同（相同即是漏表回落）', () => {
    expect(REAL.provinces.length).toBe(34);
    for (const p of REAL.provinces) {
      const capital = provinceCapital(realData, p.adcode);
      expect(capital, `${p.name}(${p.adcode}) 没有省会`).toBeTruthy();
      const short = provinceShortName(realData, p.adcode);
      if (SELF_CAPITAL.has(p.adcode)) {
        expect(capital, `${p.name} 的省会应为它自己`).toBe(short);
      } else {
        expect(capital, `${p.name} 的省会不应等于去后缀省名`).not.toBe(short);
      }
    }
  });

  it('34 个省会互不重复（重名会让判题无法定位到省）', () => {
    const capitals = REAL.provinces.map((p) => provinceCapital(realData, p.adcode));
    expect(new Set(capitals).size).toBe(capitals.length);
  });

  it('抽查常见省会（含直辖市与特区：它们的「省会」就是它自己）', () => {
    const byName = new Map(REAL.provinces.map((p) => [p.name, p.adcode]));
    const cases: [string, string][] = [
      ['北京市', '北京'],
      ['上海市', '上海'],
      ['重庆市', '重庆'],
      ['香港特别行政区', '香港'],
      ['河北省', '石家庄'],
      ['广东省', '广州'],
      ['四川省', '成都'],
      ['内蒙古自治区', '呼和浩特'],
      ['新疆维吾尔自治区', '乌鲁木齐'],
      ['西藏自治区', '拉萨'],
      ['台湾省', '台北'],
    ];
    for (const [name, capital] of cases) {
      const adcode = byName.get(name);
      expect(adcode, name).toBeTruthy();
      expect(provinceCapital(realData, adcode!), name).toBe(capital);
    }
  });
});

describe('provinceCapital / isProvinceCapitalInput', () => {
  const data = makeAppData({
    provinces: [
      { adcode: '130000', name: '河北省', center: [114.5, 38] },
      { adcode: '310000', name: '上海市', center: [121, 31] },
    ],
  });

  it('表里没有的 adcode 回落去后缀省名（调用方永远拿得到可显示文本）', () => {
    expect(provinceCapital(data, '999999')).toBe('999999');
  });

  it('认「石家庄」与「石家庄市」（同一个名字的行政后缀写法），忽略首尾空白', () => {
    expect(isProvinceCapitalInput(data, '130000', '石家庄')).toBe(true);
    expect(isProvinceCapitalInput(data, '130000', '石家庄市')).toBe(true);
    expect(isProvinceCapitalInput(data, '130000', ' 石家庄 ')).toBe(true);
  });

  it('**不认**省名与简称（省会档考的就是「省 ↔ 省会」这条记忆，口径见 province.ts）', () => {
    expect(isProvinceCapitalInput(data, '130000', '河北')).toBe(false);
    expect(isProvinceCapitalInput(data, '130000', '河北省')).toBe(false);
    expect(isProvinceCapitalInput(data, '130000', '冀')).toBe(false);
  });

  it('认的是**这一题**的省会：别省的省会不算对（直辖市自证时不误判）', () => {
    expect(isProvinceCapitalInput(data, '130000', '上海')).toBe(false);
    expect(isProvinceCapitalInput(data, '310000', '上海')).toBe(true);
    expect(isProvinceCapitalInput(data, '310000', '')).toBe(false);
  });
});
