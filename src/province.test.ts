import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildProvinceAdjacency, canDrillProvince, continentFromScope, continentScope, drillTargetOfUnit, isNationLikeScope, provinceUnits, provinceShortName, PROVINCE_NATION_SCOPE, SINGLE_UNIT_PROVINCES, WORLD_NATION_SCOPE } from './province';
import { CONTINENTS } from './types';
import type { Unit, Province } from './types';
import { makeAppData } from './testFixture';

function u(adcode: string, provinceAdcode: string, neighbors: string[] = []): Unit {
  return { adcode, name: adcode, shortName: adcode, province: 'P', provinceAdcode, center: [0, 0], neighbors, decorative: false };
}
function p(adcode: string, name: string): Province {
  return { adcode, name, center: [0, 0] };
}

describe('buildProvinceAdjacency', () => {
  it('aggregates cross-province unit neighbors into province adjacency', () => {
    const data = makeAppData({
      units: [
        u('a1', 'p1', ['a2', 'b1']),
        u('a2', 'p1', ['a1']),
        u('b1', 'p2', ['a1']),
      ],
      provinces: [p('p1', '省一'), p('p2', '省二')],
    });
    const adj = buildProvinceAdjacency(data);
    expect([...adj.get('p1')!].sort()).toEqual(['p2']);
    expect([...adj.get('p2')!].sort()).toEqual(['p1']);
  });

  it('ignores decorative units and intra-province neighbors', () => {
    const data = makeAppData({
      units: [
        u('a1', 'p1', ['a2', 'dec']),
        u('a2', 'p1', ['a1']),
        { ...u('dec', 'p2', ['a1']), decorative: true },
      ],
      provinces: [p('p1', '省一'), p('p2', '省二')],
    });
    expect(buildProvinceAdjacency(data).size).toBe(0);
  });
});

describe('provinceUnits', () => {
  it('models provinces as virtual units with normalized short names', () => {
    const data = makeAppData({ provinces: [p('450000', '广西壮族自治区'), p('110000', '北京市')] });
    const out = provinceUnits(data, new Map([['450000', []]]));
    expect(out.map((x) => [x.adcode, x.shortName])).toEqual([['450000', '广西'], ['110000', '北京']]);
    expect(out[0].decorative).toBe(false);
  });
});

describe('provinceShortName', () => {
  it('returns normalized province short name', () => {
    const data = makeAppData({ provinces: [p('450000', '广西壮族自治区')] });
    expect(provinceShortName(data, '450000')).toBe('广西');
    expect(provinceShortName(data, '999999')).toBe('999999');
  });
});

describe('PROVINCE_NATION_SCOPE', () => {
  it('is the sentinel string', () => {
    expect(PROVINCE_NATION_SCOPE).toBe('__province_nation__');
  });
});

describe('WORLD_NATION_SCOPE', () => {
  it('is a distinct sentinel string from province/city nation', () => {
    expect(WORLD_NATION_SCOPE).toBe('__world_nation__');
    expect(WORLD_NATION_SCOPE).not.toBe(PROVINCE_NATION_SCOPE);
  });
});

describe('continentScope / continentFromScope', () => {
  it('builds the sentinel for each continent', () => {
    expect(continentScope('AS')).toBe('__continent_AS__');
    expect(continentScope('OC')).toBe('__continent_OC__');
  });

  it('round-trips every continent id', () => {
    for (const c of CONTINENTS) expect(continentFromScope(continentScope(c.id))).toBe(c.id);
  });

  it('rejects non-continent scopes without throwing', () => {
    expect(continentFromScope(null)).toBeNull();
    expect(continentFromScope('')).toBeNull();
    expect(continentFromScope('__world_nation__')).toBeNull();
    expect(continentFromScope('__province_nation__')).toBeNull();
    expect(continentFromScope('110000')).toBeNull();
    expect(continentFromScope('__continent_XX__')).toBeNull(); // 未知大洲 id
    expect(continentFromScope('__continent_AS_')).toBeNull(); // 缺尾下划线
  });
});

describe('isNationLikeScope', () => {
  it('covers 市级全国/省级全国/世界全国/大洲榜', () => {
    expect(isNationLikeScope(null)).toBe(true);
    expect(isNationLikeScope(PROVINCE_NATION_SCOPE)).toBe(true);
    expect(isNationLikeScope(WORLD_NATION_SCOPE)).toBe(true);
    expect(isNationLikeScope(continentScope('EU'))).toBe(true);
  });

  it('excludes single-province scopes and undefined', () => {
    expect(isNationLikeScope('110000')).toBe(false);
    expect(isNationLikeScope(undefined)).toBe(false);
  });
});

describe('CONTINENTS 元数据', () => {
  it('has six continents excluding Antarctica, in stable UI order', () => {
    expect(CONTINENTS.map((c) => c.id)).toEqual(['AS', 'EU', 'AF', 'NA', 'SA', 'OC']);
    expect(CONTINENTS.map((c) => c.name)).toEqual(['亚洲', '欧洲', '非洲', '北美洲', '南美洲', '大洋洲']);
  });
});

/**
 * 「唯一层级省级单位不允许下钻」这条规则（用户口径 2026-09）。
 *
 * 规则写成显式清单是为了可读，但清单必须与真实数据一致：一旦某个直辖市的单位数变了
 * （或新增了别的"只有自己一个下级单位"的省级单位），这里立刻报错。
 */
describe('canDrillProvince（唯一层级省级单位不下钻）', () => {
  it('京津沪渝与港澳台不允许下钻，其余省可以', () => {
    for (const adcode of ['110000', '120000', '310000', '500000', '810000', '820000', '710000']) {
      expect(canDrillProvince(adcode), adcode).toBe(false);
    }
    for (const adcode of ['130000', '510000', '440000', '650000']) {
      expect(canDrillProvince(adcode), adcode).toBe(true);
    }
    expect(canDrillProvince(null)).toBe(false);
  });

  it('清单与真实数据里「下级单位 ≤ 1」的省级单位完全一致', () => {
    const meta = JSON.parse(readFileSync(path.join(process.cwd(), 'public', 'data', 'units.json'), 'utf8')) as {
      units: (Unit & { decorative?: boolean })[];
      provinces: Province[];
    };
    const units = meta.units.filter((x) => !x.adcode.startsWith('100000'));
    const single = meta.provinces
      .map((p) => p.adcode)
      .filter((adcode) => units.filter((x) => x.provinceAdcode === adcode).length <= 1)
      .sort();
    expect(single).toEqual([...SINGLE_UNIT_PROVINCES].sort());
  });

  it('drillTargetOfUnit：点地级市会钻到它的省，点京津沪渝/港澳台的代表面则钻到它自己', () => {
    const data = makeAppData({
      units: [u('130100', '130000'), u('110000', '110000')],
      provinces: [p('130000', '河北省'), p('110000', '北京市')],
    });
    expect(drillTargetOfUnit(data, '130100')).toBe('130000');
    expect(canDrillProvince(drillTargetOfUnit(data, '130100'))).toBe(true);
    expect(drillTargetOfUnit(data, '110000')).toBe('110000');
    expect(canDrillProvince(drillTargetOfUnit(data, '110000'))).toBe(false);
  });
});
