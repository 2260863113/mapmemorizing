import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseScopeQuery } from './scopeQuery';
import { hasSubregions, subregionOfContinent, subregionOfIso, subregionsOf } from './subregions';
import { makeAppData } from './testFixture';
import type { AppData, CountryMeta, SubregionMeta } from './types';
import { SUBREGION_IDS } from './types';
import { SUBREGION_IDS as BACKEND_SUBREGION_IDS } from '../functions/_lib/validate';

/** 世界固件：3 个大洲 + 1 个单分区大洲，覆盖「分区数 > 1 才给次区域行」的边界。 */
function country(iso: string, continent: CountryMeta['continent']): CountryMeta {
  return { iso, name: iso, fullName: iso, center: [0, 0], neighbors: [], continent };
}

const SUBREGIONS: SubregionMeta[] = [
  { id: 'EAS', name: '东亚', continent: 'AS', count: 2 },
  { id: 'SEA', name: '东南亚', continent: 'AS', count: 1 },
  { id: 'WEU', name: '西欧', continent: 'EU', count: 1 },
  { id: 'EEU', name: '东欧', continent: 'EU', count: 1 },
  { id: 'SAM', name: '南美', continent: 'SA', count: 1 },
];

const DATA: AppData = makeAppData({
  subregions: SUBREGIONS,
  isoSubregion: { CHN: 'EAS', JPN: 'EAS', THA: 'SEA', FRA: 'WEU', RUS: 'EEU', BRA: 'SAM' },
  countries: [country('CHN', 'AS'), country('JPN', 'AS'), country('THA', 'AS'), country('FRA', 'EU'), country('RUS', 'EU'), country('BRA', 'SA')],
  provinces: [{ adcode: '440000', name: '广东省', center: [113, 23] }],
});

describe('subregions helpers', () => {
  it('lists subregions of a continent in metadata order', () => {
    expect(subregionsOf(DATA, 'AS').map((s) => s.id)).toEqual(['EAS', 'SEA']);
    expect(subregionsOf(DATA, null)).toEqual([]);
  });

  it('only offers the subregion row when a continent has more than one subregion', () => {
    expect(hasSubregions(DATA, 'AS')).toBe(true); // 2 个分区
    expect(hasSubregions(DATA, 'EU')).toBe(true); // 2 个分区
    expect(hasSubregions(DATA, 'SA')).toBe(false); // 只有「南美」1 个 → 不给次区域行
    expect(hasSubregions(DATA, null)).toBe(false);
  });

  it('maps iso → subregion and subregion → continent', () => {
    expect(subregionOfIso(DATA, 'CHN')).toBe('EAS');
    expect(subregionOfIso(DATA, 'BRA')).toBe('SAM');
    expect(subregionOfIso(DATA, 'ZZZ')).toBe(null);
    expect(subregionOfContinent(DATA, 'EAS')).toBe('AS');
    expect(subregionOfContinent(DATA, 'SAM')).toBe('SA');
  });

  it('keeps SUBREGION_IDS covering the fixture metadata (drift guard)', () => {
    const ids = new Set(SUBREGIONS.map((s) => s.id));
    expect(ids.size).toBe(SUBREGIONS.length); // 元数据内部无重复 id
    for (const id of ids) expect(SUBREGION_IDS).toContain(id);
  });
});

describe('次区域 id 三处定义逐字一致（持久化契约）', () => {
  /**
   * 为什么值得一条专门的测试：次区域 id 会以 `__subregion_<ID>__` 的形式**永久**写进 D1
   * 的 leaderboard.scope_province。三处定义中任意一处漂移，症状都是
   * 「某个次区域的成绩静默提交失败」或「某个次区域在地图上点不到」——
   * 而这类故障只在跑测时暴露的成本，远低于等线上用户报障。
   *
   * 这里刻意让 src 侧的测试直接 import 后端的 validate.ts，而不是复制一份常量：
   * 复制会让测试变成同义反复（两边都由人手维护，一起改错就一起通过）。
   */
  it('types.ts / validate.ts / subregions.json 三者一致', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const file = path.join(here, '..', 'public', 'data', 'subregions.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { subregions: SubregionMeta[]; byIso: Record<string, string> };
    const fromData = raw.subregions.map((s) => s.id as string);

    expect(fromData.length).toBe(23); // 23 个次区域是本轮的既定范围，变动须显式改这里
    expect(new Set(fromData).size).toBe(fromData.length); // 无重复
    expect([...SUBREGION_IDS].sort()).toEqual([...fromData].sort());
    expect([...BACKEND_SUBREGION_IDS].sort()).toEqual([...fromData].sort());
  });

  it('subregions.json 的映射与元数据互为一致（无孤儿、无缺号）', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const file = path.join(here, '..', 'public', 'data', 'subregions.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      subregions: SubregionMeta[];
      byIso: Record<string, string>;
    };
    const declared = new Set<string>(raw.subregions.map((s) => s.id as string));
    const used = new Set<string>(Object.values(raw.byIso));

    // 每个被引用的次区域都已声明
    for (const sr of used) expect(declared.has(sr)).toBe(true);
    // 每个声明的次区域都至少有一个国家（否则是空分区，会在 UI 上给出一个点了没反应的按钮）
    for (const id of declared) expect(used.has(id)).toBe(true);
    // count 字段与实际映射条数一致（落地页正文直接引用这个数字）
    for (const meta of raw.subregions) {
      const actual = Object.values(raw.byIso).filter((v) => v === meta.id).length;
      expect(meta.count).toBe(actual);
    }
  });
});

describe('parseScopeQuery', () => {
  it('parses a full world → continent → subregion deep link', () => {
    expect(parseScopeQuery('?g=world&c=AS&s=EAS', DATA)).toEqual({
      granularity: 'world',
      continent: 'AS',
      subregion: 'EAS',
      province: null,
    });
  });

  it('parses a world → continent link without subregion', () => {
    expect(parseScopeQuery('?g=world&c=EU', DATA)).toEqual({
      granularity: 'world',
      continent: 'EU',
      subregion: null,
      province: null,
    });
  });

  it('parses a city granularity province drill-down link', () => {
    expect(parseScopeQuery('?g=city&p=440000', DATA)).toEqual({
      granularity: 'city',
      continent: null,
      subregion: null,
      province: '440000',
    });
  });

  it('accepts a bare leading-question-mark-less query string', () => {
    expect(parseScopeQuery('g=province', DATA).granularity).toBe('province');
  });

  it('silently ignores unknown values instead of throwing', () => {
    expect(parseScopeQuery('?g=mars&c=ZZ&s=NOPE&p=abc', DATA)).toEqual({
      granularity: null,
      continent: null,
      subregion: null,
      province: null,
    });
    expect(parseScopeQuery('', DATA)).toEqual({ granularity: null, continent: null, subregion: null, province: null });
  });

  it('drops a subregion that does not belong to the requested continent', () => {
    // EAS 属亚洲，却要求欧洲 → 次区域被丢弃，大洲保留（不修正成别的次区域）
    expect(parseScopeQuery('?g=world&c=EU&s=EAS', DATA).subregion).toBe(null);
    expect(parseScopeQuery('?g=world&c=EU&s=EAS', DATA).continent).toBe('EU');
  });

  it('drops a subregion given without a continent', () => {
    expect(parseScopeQuery('?g=world&s=EAS', DATA)).toEqual({
      granularity: 'world',
      continent: null,
      subregion: null,
      province: null,
    });
  });

  it('drops continent/subregion when granularity is not world', () => {
    expect(parseScopeQuery('?g=city&c=AS&s=EAS&p=440000', DATA)).toEqual({
      granularity: 'city',
      continent: null,
      subregion: null,
      province: '440000',
    });
  });

  it('drops a province adcode that does not exist in the data', () => {
    expect(parseScopeQuery('?g=city&p=999999', DATA).province).toBe(null);
  });

  it('drops a malformed province adcode', () => {
    expect(parseScopeQuery('?g=city&p=44', DATA).province).toBe(null);
  });
});
