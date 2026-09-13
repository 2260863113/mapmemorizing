import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { feature } from 'topojson-client';
import { buildPieces, splitHainan, SEA_DECORATIVE_ADCODE } from './pieces';
import { buildPuzzleAdjacency, bboxGap, neighboursInPuzzle, pairKey } from './adjacency';
import { buildProvinceAdjacency } from '../province';
import { makeAppData } from '../testFixture';
import type { AppData, Unit } from '../types';

/** 用真实的省级 plus 档几何建 fixture（拼图的所有规则都取决于这份数据）。 */
function realData(): AppData {
  const raw = readFileSync(path.join(process.cwd(), 'public', 'data', 'china_provinces_plus.json'), 'utf8');
  const topo = JSON.parse(raw) as { objects: Record<string, unknown> };
  const key = Object.keys(topo.objects)[0];
  const geo = feature(topo as never, topo.objects[key] as never);
  return makeAppData({ provincesPlusGeoJson: geo, provinces: [] as AppData['provinces'] });
}

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

describe('buildPieces', () => {
  const data = realData();
  const pieces = buildPieces(data);

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
    }
    expect(pieces.find((p) => p.adcode === '150000')?.label).toBe('内蒙古');
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
  const pieces = buildPieces(data);

  it('陆地相邻：复用省级邻接聚合（河北—北京 等）', () => {
    // 造一份最小 units：北京(110000) 与河北(130000) 的地级单位跨省相邻
    const units = dataWithUnits(
      [
        ['110100', '131000'],
        ['310100', '320100'],
      ],
      { '110100': '110000', '131000': '130000', '310100': '310000', '320100': '320000' },
    );
    const adj = buildPuzzleAdjacency(pieces, buildProvinceAdjacency(units));
    expect(adj.has(pairKey('110000', '130000'))).toBe(true);
    expect(adj.has(pairKey('310000', '320000'))).toBe(true);
    expect(neighboursInPuzzle(adj, '110000').has('130000')).toBe(true);
  });

  it('岛类兜底：海南与台湾各补一个最近片（按 bbox 最小间距）', () => {
    const adj = buildPuzzleAdjacency(pieces, new Map());
    const hainan = neighboursInPuzzle(adj, '460000');
    const taiwan = neighboursInPuzzle(adj, '710000');
    expect(hainan.size).toBe(1);
    expect(taiwan.size).toBe(1);
    expect([...hainan][0]).toBe('440000'); // 广东
    expect([...taiwan][0]).toBe('350000'); // 福建
  });

  it('兜底只对零邻居生效：给了完整陆地邻接后海南仍会补最近片（聚合表里它本就零邻居）', () => {
    const adj = buildPuzzleAdjacency(pieces, new Map([['460000', []]]));
    expect(neighboursInPuzzle(adj, '460000').size).toBe(1);
  });
});
