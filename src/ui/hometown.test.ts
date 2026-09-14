import { describe, it, expect } from 'vitest';
import {
  cityByAdcode,
  cityRows,
  matchCity,
  matchProvince,
  provinceByAdcode,
  rankCities,
  rankProvinces,
  resolveHometown,
  scoreText,
} from './hometown';
import { makeAppData } from '../testFixture';
import type { Province, Unit } from '../types';

/**
 * 家乡解析的口径单测。
 *
 * 这些规则原先埋在 `authPanel.ts` 里（浏览器里手测），但它们的产物会写进 D1 并显示在排行榜上：
 * 「广东省 + 广州」必须解析成 440000 / 440100，解析错就是永久错。
 */

function u(adcode: string, name: string, provinceAdcode: string, shortName = name): Unit {
  return { adcode, name, shortName, province: 'P', provinceAdcode, center: [0, 0], neighbors: [], decorative: false };
}
function p(adcode: string, name: string): Province {
  return { adcode, name, center: [0, 0] };
}

const DATA = makeAppData({
  provinces: [p('440000', '广东省'), p('450000', '广西壮族自治区'), p('110000', '北京市')],
  allUnits: [
    u('440100', '广州市', '440000', '广州'),
    u('440300', '深圳市', '440000', '深圳'),
    u('450100', '南宁市', '450000', '南宁'),
    u('110100', '北京市', '110000', '北京'),
    { ...u('100000_JD', '南海诸岛', '', '南海诸岛'), decorative: true },
  ],
});

describe('scoreText', () => {
  it('ranks exact > prefix > contains > no match', () => {
    expect(scoreText('广州', '广州')).toBe(100);
    expect(scoreText('广', '广州')).toBe(80);
    expect(scoreText('州', '广州')).toBe(0); // 单字非前缀不参与包含匹配
    expect(scoreText('广州', '广州南沙')).toBe(80);
    expect(scoreText('南沙', '广州南沙')).toBe(60);
    expect(scoreText('沪', '广州')).toBe(0);
  });
});

describe('rankProvinces', () => {
  it('空输入返回全部省且保持数据顺序', () => {
    expect(rankProvinces(DATA, '').map((x) => x.adcode)).toEqual(['440000', '450000', '110000']);
  });

  it('按规范化后的前缀匹配，且只保留能匹配上的行', () => {
    expect(rankProvinces(DATA, '广').map((x) => x.name)).toEqual(['广东省', '广西壮族自治区']);
    expect(rankProvinces(DATA, '海南')).toEqual([]);
  });

  it('省级后缀不参与匹配（「广西壮族自治区」可由「广西」命中）', () => {
    expect(rankProvinces(DATA, '广西').map((x) => x.adcode)).toEqual(['450000']);
  });
});

describe('rankCities', () => {
  it('只列该省的地级单位，且剔除装饰面', () => {
    expect(rankCities(DATA, '440000', '').map((x) => x.adcode)).toEqual(['440100', '440300']);
    expect(rankCities(DATA, '', '').map((x) => x.adcode)).toEqual([]);
  });

  it('按前缀/包含匹配排序', () => {
    expect(rankCities(DATA, '440000', '深').map((x) => x.adcode)).toEqual(['440300']);
    expect(rankCities(DATA, '440000', '南宁').map((x) => x.adcode)).toEqual([]);
  });
});

describe('matchProvince / matchCity（定值走精确匹配，不做模糊）', () => {
  it('省名可省后缀、可带后缀', () => {
    expect(matchProvince(DATA, '广东省')?.adcode).toBe('440000');
    expect(matchProvince(DATA, '广东')?.adcode).toBe('440000');
    expect(matchProvince(DATA, '新疆维吾尔自治区')).toBeNull();
    expect(matchProvince(DATA, '')).toBeNull();
  });

  it('市名全名或简称均可，但不接受前缀/子串匹配', () => {
    expect(matchCity(DATA, '440000', '广州市')?.adcode).toBe('440100');
    expect(matchCity(DATA, '440000', '广州')?.adcode).toBe('440100');
    expect(matchCity(DATA, '450000', '南')).toBeNull(); // 子串不命中
    expect(matchCity(DATA, '440000', '南宁')).toBeNull(); // 跨省
  });

  it('注意 normalize 会反复剥后缀：广州市 与 广 规范化后是同一个串', () => {
    // 这是 `matcher.normalize` 的既有语义（while 循环反复剥「州/市」），不是本模块引入的：
    // 于是单字「广」在判题与家乡匹配里都等价于「广州市」。改它等于改判题口径，见 AI_HANDOFF。
    expect(matchCity(DATA, '440000', '广')?.adcode).toBe('440100');
  });
});

describe('resolveHometown', () => {
  it('两项都留空 = empty（合法：用户就是不填家乡）', () => {
    expect(resolveHometown(DATA, '', '')).toEqual({ status: 'empty' });
  });

  it('省市都命中时给出 adcode 对', () => {
    expect(resolveHometown(DATA, '广东省', '广州市')).toEqual({
      status: 'ok',
      hometown: { provinceAdcode: '440000', cityAdcode: '440100' },
    });
    expect(resolveHometown(DATA, '广东', '深圳')).toEqual({
      status: 'ok',
      hometown: { provinceAdcode: '440000', cityAdcode: '440300' },
    });
  });

  it('省名对不上 = invalidProvince', () => {
    expect(resolveHometown(DATA, '海南省', '海口')).toEqual({ status: 'invalidProvince' });
    expect(resolveHometown(DATA, '', '广州')).toEqual({ status: 'invalidProvince' }); // 只填市也报省错
  });

  it('省对但市缺失或跨省 = invalidCity（口径：省市必须同时填）', () => {
    expect(resolveHometown(DATA, '广东省', '')).toEqual({ status: 'invalidCity' });
    expect(resolveHometown(DATA, '广东省', '南宁')).toEqual({ status: 'invalidCity' });
    expect(resolveHometown(DATA, '广东省', '海南')).toEqual({ status: 'invalidCity' });
  });
});

describe('cityRows / provinceByAdcode / cityByAdcode', () => {
  it('cityRows 剔除装饰面，只留该省单位', () => {
    expect(cityRows(DATA, '440000').map((x) => x.adcode)).toEqual(['440100', '440300']);
    expect(cityRows(DATA, '100000_JD')).toEqual([]);
  });

  it('按 adcode 反查，找不到返回 null', () => {
    expect(provinceByAdcode(DATA, '450000')?.name).toBe('广西壮族自治区');
    expect(provinceByAdcode(DATA, '999999')).toBeNull();
    expect(cityByAdcode(DATA, '450100')?.name).toBe('南宁市');
    expect(cityByAdcode(DATA, '100000_JD')).toBeNull(); // 装饰面不当作城市
    expect(cityByAdcode(DATA, '999999')).toBeNull();
  });
});
