import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { feature } from 'topojson-client';
import { buildPieces, type PuzzlePieceDef, type PuzzleScope } from './pieces';
import { buildPuzzleAdjacency, pieceGap, type PuzzleGraph } from './adjacency';
import { isSpecialUnit, specialUnitsOf, tinyUnitsOf, TINY_AREA_DEG2, EXTRA_ISLAND_UNITS } from './specialUnits';
import { buildProvinceAdjacency } from '../province';
import { makeAppData } from '../testFixture';
import type { AppData, CountryMeta, Unit } from '../types';

/**
 * 「孤悬 / 极小」单位名单（困难档放宽吸附容差的对象）。
 *
 * 用真实数据断言，因为这个名单完全由**数据**决定（面积 + 有没有陆地邻居），
 * 换一份几何或换一次简化档，名单就可能变——测试是唯一能发现它漂移的地方。
 */

function topoFile(file: string, objectKey = 'china'): unknown {
  const raw = readFileSync(path.join(process.cwd(), 'public', 'data', file), 'utf8');
  const topo = JSON.parse(raw) as { objects: Record<string, unknown> };
  return feature(topo as never, topo.objects[objectKey] as never);
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(path.join(process.cwd(), 'public', 'data', file), 'utf8')) as T;
}

function provinceData(): AppData {
  return makeAppData({ provincesPlusGeoJson: topoFile('china_provinces_plus.json') });
}

function worldData(): AppData {
  const meta = readJson<{ countries: CountryMeta[] }>('countries.json');
  const sub = readJson<{ subregions: AppData['subregions']; byIso: AppData['isoSubregion'] }>('subregions.json');
  return makeAppData({
    worldGeoJson: topoFile('world_v2.topojson'),
    countries: meta.countries,
    subregions: sub.subregions,
    isoSubregion: sub.byIso,
  });
}

function cityData(): AppData {
  const meta = readJson<{ units: Unit[]; provinces: AppData['provinces'] }>('units.json');
  return makeAppData({
    units: meta.units.filter((u) => !u.decorative),
    allUnits: meta.units,
    provinces: meta.provinces,
    plusGeoJson: topoFile('china_units_plus.json'),
  });
}

const CN_PROVINCE: PuzzleScope = { granularity: 'province', family: 'china' };
const WORLD: PuzzleScope = { granularity: 'world', family: 'world' };

describe('isSpecialUnit · 认定规则', () => {
  it('三条判据取并集：极小 / 孤悬 / 另算岛国名单', () => {
    expect(isSpecialUnit('820000', 0.0025, true)).toBe(true); // 极小（澳门，且有陆地邻居）
    expect(isSpecialUnit('460000', 2.92, false)).toBe(true); // 孤悬（海南）
    expect(isSpecialUnit('GBR', 33.3, true)).toBe(true); // 名单（英国有陆地邻居）
    expect(isSpecialUnit('110000', 1.735, true)).toBe(false); // 北京：既不小也不孤悬
  });

  it('阈值就是 2000 km²（≈0.1614 度²）：港澳入选、上海天津不入选', () => {
    expect(TINY_AREA_DEG2).toBeCloseTo(0.1614, 4);
    expect(isSpecialUnit('t', TINY_AREA_DEG2, true)).toBe(true);
    expect(isSpecialUnit('t', TINY_AREA_DEG2 * 1.01, true)).toBe(false);
  });
});

describe('specialUnitsOf · 省级全国（34 片）', () => {
  const data = provinceData();
  const city = cityData();
  const pieces = buildPieces(data, CN_PROVINCE);
  const provinceAdjacency = buildProvinceAdjacency(city);
  const graph: PuzzleGraph = {
    adjacency: new Set<string>(),
    landConnected: new Set<string>(),
  };
  {
    for (const piece of pieces) {
      for (const other of provinceAdjacency.get(piece.adcode) ?? []) {
        graph.landConnected.add(piece.adcode);
        graph.landConnected.add(other);
      }
    }
  }

  it('名单正好是港澳台海南 4 个（港澳靠面积、台湾海南靠无陆地邻居）', () => {
    expect([...specialUnitsOf(pieces, graph.landConnected)].sort()).toEqual([
      '460000', // 海南
      '710000', // 台湾
      '810000', // 香港
      '820000', // 澳门
    ]);
  });

  it('上海/天津/北京不入选（面积差 4.8 倍以上，纬度换算不会改变结论）', () => {
    const special = specialUnitsOf(pieces, graph.landConnected);
    for (const adcode of ['310000', '120000', '110000']) expect(special.has(adcode), adcode).toBe(false);
  });

  it('「排到最后」的极小集合比放宽集合更窄：只有港澳，海岛不算', () => {
    const tiny = tinyUnitsOf(pieces);
    expect([...tiny].sort()).toEqual(['810000', '820000']);
  });
});

describe('specialUnitsOf · 世界全国（194 片）', () => {
  const data = worldData();
  const pieces = buildPieces(data, WORLD);
  const landConnected = new Set<string>();
  for (const piece of pieces) {
    for (const other of data.countries.find((c) => c.iso === piece.adcode)?.neighbors ?? []) {
      landConnected.add(piece.adcode);
      landConnected.add(other);
    }
  }
  const special = specialUnitsOf(pieces, landConnected);

  it('孤悬的岛国入选：澳大利亚、日本、新西兰、冰岛', () => {
    for (const iso of ['AUS', 'JPN', 'NZL', 'ISL']) expect(special.has(iso), iso).toBe(true);
  });

  it('「另算岛国」名单补上了有陆地邻居的岛：英国/爱尔兰/印尼等 8 个', () => {
    for (const iso of EXTRA_ISLAND_UNITS) expect(special.has(iso), iso).toBe(true);
  });

  it('极小的国家入选：瑙鲁、摩纳哥、图瓦卢、马尔代夫、圣马力诺、马绍尔', () => {
    for (const iso of ['NRU', 'MCO', 'TUV', 'MDV', 'SMR', 'MHL']) expect(special.has(iso), iso).toBe(true);
  });

  it('大陆国家不入选（中美俄法德巴西等）', () => {
    for (const iso of ['CHN', 'USA', 'RUS', 'FRA', 'DEU', 'BRA', 'IND', 'KAZ']) {
      expect(special.has(iso), iso).toBe(false);
    }
  });

  it('名单规模：51 / 194（39 个无陆地邻国 + 4 个欧洲微国家 + 8 个另算岛国）', () => {
    expect(special.size).toBe(51);
  });

  it('面积判据在世界档只为"有陆地邻居的微型国"补位（摩纳哥/圣马力诺/列支敦士登/安道尔）', () => {
    for (const iso of ['MCO', 'SMR', 'LIE', 'AND']) expect(special.has(iso), iso).toBe(true);
  });

  it('面积小而孤悬的国家由"孤悬"那条收进来，与面积无关（毛里求斯 0.1649 在阈值外，照样入选）', () => {
    expect(special.has('MUS')).toBe(true);
    expect(landConnected.has('MUS')).toBe(false); // 它零陆地邻居，走的是孤悬那条
  });
});

describe('兜底配对不再"落到地球另一端"（逐多边形几何间距）', () => {
  const data = worldData();
  const pieces = buildPieces(data, WORLD);
  const byIso = new Map(pieces.map((p) => [p.adcode, p]));
  const nearestOf = (iso: string) => {
    const self = byIso.get(iso)!;
    let best: PuzzlePieceDef | null = null;
    let bestGap = Number.POSITIVE_INFINITY;
    for (const other of pieces) {
      if (other.adcode === iso) continue;
      const gap = pieceGap(self, other);
      if (gap < bestGap) {
        bestGap = gap;
        best = other;
      }
    }
    return best!.adcode;
  };

  it('冰岛不配俄罗斯、马尔代夫不配中国、塞浦路斯不配挪威、新西兰不配南非', () => {
    expect(nearestOf('ISL')).not.toBe('RUS');
    expect(nearestOf('MDV')).not.toBe('CHN');
    expect(nearestOf('CYP')).not.toBe('NOR');
    expect(nearestOf('NZL')).not.toBe('ZAF');
  });

  it('最近片落在合理范围里（冰岛→英国/挪威、马尔代夫→印度/斯里兰卡）', () => {
    expect(['GBR', 'NOR', 'IRL']).toContain(nearestOf('ISL'));
    expect(['IND', 'LKA']).toContain(nearestOf('MDV'));
  });

  it('兜底仍然保证"每个碎片至少一个可吸附对象"（连通性硬要求）', () => {
    const adj = buildPuzzleAdjacency(pieces, (iso) => data.countries.find((c) => c.iso === iso)?.neighbors ?? []);
    for (const piece of pieces) {
      const deg = [...adj].filter((k) => k.split('|').includes(piece.adcode)).length;
      expect(deg, piece.adcode).toBeGreaterThan(0);
    }
  });
});
