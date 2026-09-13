import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { feature } from 'topojson-client';
import { buildPieces, countScopePieces, familyOf, splitHainan, SEA_DECORATIVE_ADCODE, type PuzzlePieceDef, type PuzzleScope } from './pieces';
import { buildPuzzleAdjacency, bboxGap, neighboursInPuzzle, pairKey, puzzleComponents } from './adjacency';
import { PUZZLE_ASPECT, PUZZLE_LAT_PER_LNG, PUZZLE_SPAN_LAT, PUZZLE_SPAN_LNG, pxBBoxOf } from './projection';
import { buildProvinceAdjacency } from '../province';
import { makeAppData } from '../testFixture';
import type { AppData, Continent, CountryMeta, Unit } from '../types';

/** 读 public/data 下的 TopoJSON 档并展开成 GeoJSON（与 src/data.ts 同一读法）。 */
function topoFile(file: string, objectKey = 'china'): unknown {
  const raw = readFileSync(path.join(process.cwd(), 'public', 'data', file), 'utf8');
  const topo = JSON.parse(raw) as { objects: Record<string, unknown> };
  return feature(topo as never, topo.objects[objectKey] as never);
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(path.join(process.cwd(), 'public', 'data', file), 'utf8')) as T;
}

/** 用真实的省级 plus 档几何建 fixture（省级拼图的所有规则都取决于这份数据）。 */
function realData(): AppData {
  return makeAppData({ provincesPlusGeoJson: topoFile('china_provinces_plus.json'), provinces: [] });
}

/** 真实世界档 fixture：194 个答题国 + 装饰面 + 次区域表。 */
function realWorldData(): AppData {
  const meta = readJson<{ countries: CountryMeta[] }>('countries.json');
  const sub = readJson<{ subregions: AppData['subregions']; byIso: AppData['isoSubregion'] }>('subregions.json');
  return makeAppData({
    worldGeoJson: topoFile('world_v2.topojson'),
    countries: meta.countries,
    subregions: sub.subregions,
    isoSubregion: sub.byIso,
  });
}

/** 真实市级档 fixture：340 个非装饰地级单位 + plus 档几何。 */
function realCityData(): AppData {
  const meta = readJson<{ units: Unit[]; provinces: AppData['provinces'] }>('units.json');
  return makeAppData({
    units: meta.units.filter((u) => !u.decorative),
    allUnits: meta.units,
    provinces: meta.provinces,
    plusGeoJson: topoFile('china_units_plus.json'),
  });
}

const CN_PROVINCE: PuzzleScope = { granularity: 'province', family: 'china' };
const CN_CITY: PuzzleScope = { granularity: 'city', family: 'china' };
const WORLD: PuzzleScope = { granularity: 'world', family: 'world' };

/** 省级邻接需要 units（地级单位的 neighbors）——这里只造最小可用的一份。 */
function dataWithUnits(pairs: [string, string][], provinceOf: Record<string, string>): AppData {
  const units: Unit[] = [];
  const seen = new Set<string>();
  for (const [a, b] of pairs) {
    const ua: Unit = {
      adcode: a,
      name: a,
      shortName: a,
      province: '',
      provinceAdcode: provinceOf[a] ?? a,
      center: [0, 0],
      neighbors: [b],
    };
    const ub: Unit = {
      adcode: b,
      name: b,
      shortName: b,
      province: '',
      provinceAdcode: provinceOf[b] ?? b,
      center: [0, 0],
      neighbors: [a],
    };
    if (!seen.has(a)) units.push(ua);
    if (!seen.has(b)) units.push(ub);
    seen.add(a);
    seen.add(b);
  }
  return makeAppData({ units, allUnits: units });
}

describe('familyOf', () => {
  it('世界档用 world 投影族，省级/市级用 china', () => {
    expect(familyOf('world')).toBe('world');
    expect(familyOf('province')).toBe('china');
    expect(familyOf('city')).toBe('china');
  });
});

describe('buildPieces · 省级全国', () => {
  const data = realData();
  const pieces = buildPieces(data, CN_PROVINCE);

  it('切出 34 片：装饰面「南海诸岛」不参与拼图', () => {
    expect(pieces).toHaveLength(34);
    expect(pieces.some((p) => p.adcode === SEA_DECORATIVE_ADCODE)).toBe(false);
    expect(pieces.some((p) => p.adcode === '460000')).toBe(true);
  });

  it('每片都有几何、bbox、锚点与简称标签', () => {
    for (const piece of pieces) {
      expect(piece.polygons.length).toBeGreaterThan(0);
      expect(piece.bbox[2]).toBeGreaterThan(piece.bbox[0]);
      expect(piece.bbox[3]).toBeGreaterThan(piece.bbox[1]);
      expect(piece.label.length).toBeGreaterThan(0);
      expect(Number.isFinite(piece.origin[0])).toBe(true);
      expect(Number.isFinite(piece.labelAnchor[1])).toBe(true);
      expect(piece.area).toBeGreaterThan(0);
    }
    expect(pieces.find((p) => p.adcode === '150000')?.label).toBe('内蒙古');
  });

  it('碎片的像素宽高比 = 经纬度宽高比 × aspectScale（与地图页同一套比例）', () => {
    // 回归闸门：aspectScale 曾被用反（纬度被压扁 0.75 倍 → 视觉上"上下压扁"）。
    // ECharts 的 aspectScale 是**布局宽高比**系数，故 px_w/px_h = (deg_w/deg_h) × 0.75。
    const scale = 26.32; // 1440 宽视口下的默认比例
    for (const adcode of ['150000', '650000', '710000', '110000']) {
      const piece = pieces.find((p) => p.adcode === adcode)!;
      const degW = piece.bbox[2] - piece.bbox[0];
      const degH = piece.bbox[3] - piece.bbox[1];
      const box = pxBBoxOf(piece.polygons, scale);
      const pxW = box[2] - box[0];
      const pxH = box[3] - box[1];
      expect(pxW / pxH).toBeCloseTo((degW / degH) * PUZZLE_ASPECT, 6);
    }
    // 整幅拼图：宽高比 = (61.6 / 50.2) × 0.75 ≈ 0.92（地图页上中国就是"竖着略高"）
    const mapAspect = (PUZZLE_SPAN_LNG * scale) / (PUZZLE_SPAN_LAT * PUZZLE_LAT_PER_LNG * scale);
    expect(mapAspect).toBeCloseTo((PUZZLE_SPAN_LNG / PUZZLE_SPAN_LAT) * PUZZLE_ASPECT, 6);
    expect(mapAspect).toBeLessThan(1);
  });

  it('海南被拆成主岛（拼图用）与远海岛礁（获胜后补）', () => {
    const hainan = pieces.find((p) => p.adcode === '460000')!;
    const width = hainan.bbox[2] - hainan.bbox[0];
    const height = hainan.bbox[3] - hainan.bbox[1];
    expect(width).toBeLessThan(4); // 主岛约 2.4°，而不是整片 feature 的 9.2°
    expect(height).toBeLessThan(3); // 主岛约 2.0°，而不是 16.3°
    expect(hainan.seaIslets.length).toBeGreaterThan(100); // 三沙等远海岛礁留在 seaIslets
    expect(hainan.polygons.length).toBeLessThan(hainan.seaIslets.length);
  });

  it('其它省的碎片不被拆分（seaIslets 为空）', () => {
    for (const piece of pieces) {
      if (piece.adcode === '460000') continue;
      expect(piece.seaIslets).toHaveLength(0);
    }
  });

  it('splitHainan 对单片输入是恒等的', () => {
    const single = [[[[0, 0], [1, 0], [1, 1]]]] as never;
    const { body, islets } = splitHainan(single);
    expect(body).toHaveLength(1);
    expect(islets).toHaveLength(0);
  });
});

describe('buildPieces · 世界档', () => {
  const data = realWorldData();

  it('全世界切出 194 个答题国（属地/南极等装饰面不作碎片）', () => {
    const pieces = buildPieces(data, WORLD);
    expect(pieces).toHaveLength(data.countries.length);
    expect(pieces.every((p) => p.polygons.length > 0)).toBe(true);
    // adcode 用 iso_a3，标签用中文名
    expect(pieces.find((p) => p.adcode === 'JPN')?.label).toBe('日本');
    expect(pieces.every((p) => p.label.length > 0)).toBe(true);
  });

  it('大洲范围只留该洲的国家；再叠次区域范围只留该次区域', () => {
    const asia: PuzzleScope = { ...WORLD, continent: 'AS' as Continent };
    const asiaPieces = buildPieces(data, asia);
    expect(asiaPieces.length).toBeGreaterThan(0);
    expect(asiaPieces.length).toBeLessThan(194);
    expect(asiaPieces.every((p) => data.countries.find((c) => c.iso === p.adcode)?.continent === 'AS')).toBe(true);

    const eastAsia: PuzzleScope = { ...asia, subregion: 'EAS' };
    const easPieces = buildPieces(data, eastAsia);
    expect(easPieces.length).toBeGreaterThan(0);
    expect(easPieces.length).toBeLessThan(asiaPieces.length);
    expect(easPieces.every((p) => data.isoSubregion[p.adcode] === 'EAS')).toBe(true);
    expect(easPieces.some((p) => p.adcode === 'JPN')).toBe(true);
    expect(easPieces.some((p) => p.adcode === 'CHN')).toBe(true);
  });

  it('世界族的像素比例与中国族一致（都用 aspectScale 布局系数）', () => {
    const scale = 4.6; // 世界范围 360° 摊在视口上，每度像素小得多
    const pieces = buildPieces(data, WORLD);
    const russia = pieces.find((p) => p.adcode === 'RUS')!;
    const degW = russia.bbox[2] - russia.bbox[0];
    const degH = russia.bbox[3] - russia.bbox[1];
    const box = pxBBoxOf(russia.polygons, scale, 'world');
    expect((box[2] - box[0]) / (box[3] - box[1])).toBeCloseTo((degW / degH) * PUZZLE_ASPECT, 6);
  });
});

describe('buildPieces · 市级档', () => {
  const data = realCityData();

  it('全国切出 340 个地级单位（33 个装饰面不作碎片）', () => {
    const pieces = buildPieces(data, CN_CITY);
    expect(pieces).toHaveLength(340);
    expect(data.allUnits.length).toBeGreaterThan(340); // 装饰面确实存在，只是被排除
  });

  it('下钻某省只留该省的地级单位', () => {
    const hebei: PuzzleScope = { ...CN_CITY, province: '130000' };
    const pieces = buildPieces(data, hebei);
    expect(pieces.length).toBeGreaterThan(5);
    expect(pieces.length).toBeLessThan(340);
    expect(pieces.every((p) => data.units.find((u) => u.adcode === p.adcode)?.provinceAdcode === '130000')).toBe(true);
    expect(pieces.some((p) => p.adcode === '130100')).toBe(true); // 石家庄
  });

  it('每个碎片都能在 units 里找到名称与简称', () => {
    for (const piece of buildPieces(data, CN_CITY)) {
      const unit = data.units.find((u) => u.adcode === piece.adcode);
      expect(unit).toBeDefined();
      expect(piece.name).toBe(unit!.name);
    }
  });
});

describe('countScopePieces', () => {
  it('只数个数与真建碎片的结果逐档一致（开始卡片用它写"把 xx 拼成…"）', () => {
    const cases: [AppData, PuzzleScope][] = [
      [realData(), CN_PROVINCE],
      [realCityData(), CN_CITY],
      [realCityData(), { ...CN_CITY, province: '130000' }],
      [realCityData(), { ...CN_CITY, province: '650000' }],
      [realWorldData(), WORLD],
      [realWorldData(), { ...WORLD, continent: 'AS' }],
      [realWorldData(), { ...WORLD, continent: 'AS', subregion: 'EAS' }],
      [realWorldData(), { ...WORLD, continent: 'EU' }],
    ];
    for (const [data, scope] of cases) {
      const label = `${scope.granularity}/${scope.province ?? scope.subregion ?? scope.continent ?? '-'}`;
      expect(countScopePieces(data, scope), label).toBe(buildPieces(data, scope).length);
    }
  });

  it('片数口径：省级 34 / 市级全国 340 / 世界 194，下钻后变小', () => {
    expect(countScopePieces(realData(), CN_PROVINCE)).toBe(34);
    const city = realCityData();
    expect(countScopePieces(city, CN_CITY)).toBe(340);
    expect(countScopePieces(city, { ...CN_CITY, province: '130000' })).toBeLessThan(340);
    const world = realWorldData();
    expect(countScopePieces(world, WORLD)).toBe(194);
    expect(countScopePieces(world, { ...WORLD, continent: 'AS' })).toBeLessThan(194);
  });
});

describe('bboxGap', () => {
  it('相交或相接为 0', () => {
    expect(bboxGap([0, 0, 2, 2], [1, 1, 3, 3])).toBe(0);
    expect(bboxGap([0, 0, 2, 2], [2, 0, 4, 2])).toBe(0);
  });

  it('分离时为两框最小间距', () => {
    expect(bboxGap([0, 0, 1, 1], [2, 1, 3, 2])).toBeCloseTo(1, 9);
    expect(bboxGap([0, 0, 1, 1], [1, 2, 2, 3])).toBeCloseTo(1, 9);
  });
});

describe('buildPuzzleAdjacency', () => {
  const data = realData();
  const pieces = buildPieces(data, CN_PROVINCE);

  it('陆地相邻：复用省级邻接聚合（河北—北京 等）', () => {
    // 造一份最小 units：北京(110000) 与河北(130000) 的地级单位跨省相邻
    const units = dataWithUnits(
      [
        ['110100', '131000'],
        ['310100', '320100'],
      ],
      { '110100': '110000', '131000': '130000', '310100': '310000', '320100': '320000' },
    );
    const provinceAdjacency = buildProvinceAdjacency(units);
    const adj = buildPuzzleAdjacency(pieces, (adcode) => provinceAdjacency.get(adcode) ?? []);
    expect(adj.has(pairKey('110000', '130000'))).toBe(true);
    expect(adj.has(pairKey('310000', '320000'))).toBe(true);
    expect(neighboursInPuzzle(adj, '110000').has('130000')).toBe(true);
  });

  it('岛类兜底：海南与台湾各补一个最近片（按 bbox 最小间距）', () => {
    const adj = buildPuzzleAdjacency(pieces, () => []);
    const hainan = neighboursInPuzzle(adj, '460000');
    const taiwan = neighboursInPuzzle(adj, '710000');
    expect(hainan.size).toBe(1);
    expect(taiwan.size).toBe(1);
    expect([...hainan][0]).toBe('440000'); // 广东
    expect([...taiwan][0]).toBe('350000'); // 福建
  });

  it('兜底只对零邻居生效：给了完整陆地邻接后海南仍会补最近片（聚合表里它本就零邻居）', () => {
    const adj = buildPuzzleAdjacency(pieces, (adcode) => (adcode === '460000' ? [] : []));
    expect(neighboursInPuzzle(adj, '460000').size).toBe(1);
  });

  it('范围外的邻居被忽略：下钻某省的碎片不会连到别的省', () => {
    const cityData = realCityData();
    const shanxi: PuzzleScope = { ...CN_CITY, province: '140000' };
    const shanxiPieces = buildPieces(cityData, shanxi);
    const known = new Set(shanxiPieces.map((p) => p.adcode));
    const adj = buildPuzzleAdjacency(shanxiPieces, (adcode) => cityData.units.find((u) => u.adcode === adcode)?.neighbors ?? []);
    for (const key of adj) {
      for (const adcode of key.split('|')) expect(known.has(adcode)).toBe(true);
    }
    expect(adj.size).toBeGreaterThan(0);
  });

  it('世界档：岛国也有兜底邻居（日本→韩国/俄罗斯 之一）', () => {
    const worldData = realWorldData();
    const worldPieces = buildPieces(worldData, WORLD);
    const adj = buildPuzzleAdjacency(worldPieces, (iso) => worldData.countries.find((c) => c.iso === iso)?.neighbors ?? []);
    expect(neighboursInPuzzle(adj, 'CHN').size).toBeGreaterThan(0);
    expect(neighboursInPuzzle(adj, 'JPN').size).toBeGreaterThan(0);
    // 每个碎片至少有一个可吸附对象，否则整局不可能拼成一块
    for (const piece of worldPieces) expect(neighboursInPuzzle(adj, piece.adcode).size).toBeGreaterThan(0);
  });
});

/**
 * 「能拼完」的硬保证：邻接图必须**连通**。
 *
 * 不连通 = 一定有几片永远吸不到主块上（实测世界档兜底只给孤立片一条边，仍会分成 6 块：
 * 澳洲—巴新、新西兰、马达加斯加、日本…），所以 `buildPuzzleAdjacency` 末尾要做连通性修补。
 * 这里对每个可选范围都断言 `puzzleComponents(...).length === 1`。
 */
describe('拼图邻接连通性（每个范围都必须能拼成一整块）', () => {
  const worldData = realWorldData();
  const cityData = realCityData();
  const provinceData = realData();
  const worldNeighbours = (iso: string) => worldData.countries.find((c) => c.iso === iso)?.neighbors ?? [];

  const scopes: { name: string; pieces: PuzzlePieceDef[]; neighboursOf: (a: string) => string[] }[] = [
    { name: '省级全国 34', pieces: buildPieces(provinceData, CN_PROVINCE), neighboursOf: (a) => buildProvinceAdjacency(provinceData).get(a) ?? [] },
    { name: '市级全国 340', pieces: buildPieces(cityData, CN_CITY), neighboursOf: (a) => cityData.units.find((u) => u.adcode === a)?.neighbors ?? [] },
    { name: '市级·河北', pieces: buildPieces(cityData, { ...CN_CITY, province: '130000' }), neighboursOf: (a) => cityData.units.find((u) => u.adcode === a)?.neighbors ?? [] },
    { name: '市级·海南', pieces: buildPieces(cityData, { ...CN_CITY, province: '460000' }), neighboursOf: (a) => cityData.units.find((u) => u.adcode === a)?.neighbors ?? [] },
    { name: '世界 194', pieces: buildPieces(worldData, WORLD), neighboursOf: worldNeighbours },
    { name: '世界·亚洲', pieces: buildPieces(worldData, { ...WORLD, continent: 'AS' }), neighboursOf: worldNeighbours },
    { name: '世界·东亚', pieces: buildPieces(worldData, { ...WORLD, continent: 'AS', subregion: 'EAS' }), neighboursOf: worldNeighbours },
    { name: '世界·大洋洲', pieces: buildPieces(worldData, { ...WORLD, continent: 'OC' }), neighboursOf: worldNeighbours },
    { name: '世界·加勒比', pieces: buildPieces(worldData, { ...WORLD, continent: 'NA', subregion: 'CAR' }), neighboursOf: worldNeighbours },
  ];

  for (const scope of scopes) {
    it(`${scope.name}：邻接图连通（有解）`, () => {
      const adj = buildPuzzleAdjacency(scope.pieces, scope.neighboursOf);
      const comps = puzzleComponents(scope.pieces, adj);
      expect(comps.map((c) => c.length), `${scope.name} 连通块=${comps.length}`).toHaveLength(1);
      expect(comps[0]).toHaveLength(scope.pieces.length);
      // 顺带：每片都能吸到东西（孤立片必须被兜底补边）
      for (const piece of scope.pieces) expect(neighboursInPuzzle(adj, piece.adcode).size).toBeGreaterThan(0);
    });
  }

  it('连通性修补只搭桥、不改已有的陆地邻接', () => {
    const pieces = buildPieces(provinceData, CN_PROVINCE);
    const provinceAdjacency = buildProvinceAdjacency(provinceData);
    const adj = buildPuzzleAdjacency(pieces, (a) => provinceAdjacency.get(a) ?? []);
    expect(adj.has(pairKey('110000', '130000'))).toBe(true); // 北京—河北 仍在
    expect(adj.has(pairKey('440000', '460000'))).toBe(true); // 广东—海南（兜底边）
  });
});
