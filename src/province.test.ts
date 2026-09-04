import { describe, it, expect } from 'vitest';
import { buildProvinceAdjacency, provinceUnits, provinceShortName, PROVINCE_NATION_SCOPE } from './province';
import type { AppData, Unit, Province } from './types';

function u(adcode: string, provinceAdcode: string, neighbors: string[] = []): Unit {
  return { adcode, name: adcode, shortName: adcode, province: 'P', provinceAdcode, center: [0, 0], neighbors, decorative: false };
}
function p(adcode: string, name: string): Province {
  return { adcode, name, center: [0, 0] };
}

describe('buildProvinceAdjacency', () => {
  it('aggregates cross-province unit neighbors into province adjacency', () => {
    const data: AppData = {
      units: [
        u('a1', 'p1', ['a2', 'b1']),
        u('a2', 'p1', ['a1']),
        u('b1', 'p2', ['a1']),
      ],
      allUnits: [],
      provinces: [p('p1', '省一'), p('p2', '省二')],
      geoJson: null,
      provincesGeoJson: null,
    };
    const adj = buildProvinceAdjacency(data);
    expect([...adj.get('p1')!].sort()).toEqual(['p2']);
    expect([...adj.get('p2')!].sort()).toEqual(['p1']);
  });

  it('ignores decorative units and intra-province neighbors', () => {
    const data: AppData = {
      units: [
        u('a1', 'p1', ['a2', 'dec']),
        u('a2', 'p1', ['a1']),
        { ...u('dec', 'p2', ['a1']), decorative: true },
      ],
      allUnits: [],
      provinces: [p('p1', '省一'), p('p2', '省二')],
      geoJson: null,
      provincesGeoJson: null,
    };
    expect(buildProvinceAdjacency(data).size).toBe(0);
  });
});

describe('provinceUnits', () => {
  it('models provinces as virtual units with normalized short names', () => {
    const data: AppData = {
      units: [],
      allUnits: [],
      provinces: [p('450000', '广西壮族自治区'), p('110000', '北京市')],
      geoJson: null,
      provincesGeoJson: null,
    };
    const out = provinceUnits(data, new Map([['450000', []]]));
    expect(out.map((x) => [x.adcode, x.shortName])).toEqual([['450000', '广西'], ['110000', '北京']]);
    expect(out[0].decorative).toBe(false);
  });
});

describe('provinceShortName', () => {
  it('returns normalized province short name', () => {
    const data: AppData = {
      units: [], allUnits: [],
      provinces: [p('450000', '广西壮族自治区')],
      geoJson: null, provincesGeoJson: null,
    };
    expect(provinceShortName(data, '450000')).toBe('广西');
    expect(provinceShortName(data, '999999')).toBe('999999');
  });
});

describe('PROVINCE_NATION_SCOPE', () => {
  it('is the sentinel string', () => {
    expect(PROVINCE_NATION_SCOPE).toBe('__province_nation__');
  });
});
