import { describe, it, expect, vi, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 档位切换的**跨档一致性**验证。
 *
 * 为什么这是关键不变式：ECharts 的 `registerMap` 按 `feature.properties.name` 建 region，
 * 着色（geo.regions）、点击/悬浮命中、标签锚点全部靠这个名字匹配。
 * 若各档的 name 集合不一致（例如某一档简化后丢了某个小面、或名字被写成拼音），
 * 那么「放大跨过阈值换档」时该单位会突然失去颜色/点不中 —— 这是本项目最隐蔽的一类 bug
 * （历史上 DataV/拼音名混用就踩过）。
 *
 * 本测试对五档地级 + 五档省级逐一断言：
 *   1. 每档每个 feature 都有非空 name 与 adcode；
 *   2. 五档的 name 集合**完全相同**；
 *   3. adcode ↔ name 的对应关系跨档一致（不能出现同 adcode 换档后改名）。
 */
const DATA = join(process.cwd(), 'public', 'data');

describe('五档跨档一致性（换档不丢色/不丢命中）', () => {
  beforeAll(() => {
    vi.stubGlobal('fetch', async (url: string) => {
      const name = String(url).replace(/^.*\/data\//, '').replace(/^data\//, '');
      try {
        const body = readFileSync(join(DATA, name), 'utf8');
        return { ok: true, status: 200, json: async () => JSON.parse(body) };
      } catch {
        return { ok: false, status: 404, json: async () => { throw new Error('404 ' + name); } };
      }
    });
  });

  it('prefecture tiers: identical name set and identical adcode→name map', async () => {
    const { loadData } = await import('./data');
    const data = await loadData();
    const tiers = [
      ['ultra', data.ultraGeoJson], ['pro', data.proGeoJson], ['fine', data.geoJson],
      ['plus', data.plusGeoJson], ['lossless', data.losslessGeoJson],
    ] as const;

    const maps = tiers.map(([label, gj]) => {
      const m = new Map<string, string>();
      for (const f of (gj as { features: { properties: { name?: string; adcode?: string } }[] }).features) {
        expect(f.properties.name, `${label} 档有 feature 缺 name`).toBeTruthy();
        expect(f.properties.adcode, `${label} 档有 feature 缺 adcode`).toBeTruthy();
        m.set(String(f.properties.adcode), String(f.properties.name));
      }
      return { label, m };
    });

    const base = maps[2]; // fine 为基准
    for (const { label, m } of maps) {
      expect(m.size, `${label} 档面数与 fine 不同`).toBe(base.m.size);
      const missing = [...base.m.keys()].filter((ad) => !m.has(ad));
      const extra = [...m.keys()].filter((ad) => !base.m.has(ad));
      expect(missing, `${label} 档缺少 adcode`).toEqual([]);
      expect(extra, `${label} 档多出 adcode`).toEqual([]);
      // 同 adcode 必须同名
      const renamed = [...base.m.entries()].filter(([ad, nm]) => m.get(ad) !== nm);
      expect(renamed, `${label} 档有单位改名（换档会丢色/丢命中）`).toEqual([]);
    }
  });

  it('province tiers: identical name set and identical adcode→name map', async () => {
    const { loadData } = await import('./data');
    const data = await loadData();
    const tiers = [
      ['ultra', data.provincesUltraGeoJson], ['pro', data.provincesProGeoJson], ['fine', data.provincesGeoJson],
      ['plus', data.provincesPlusGeoJson], ['lossless', data.provincesRawGeoJson],
    ] as const;

    const maps = tiers.map(([label, gj]) => {
      const m = new Map<string, string>();
      for (const f of (gj as { features: { properties: { name?: string; adcode?: string } }[] }).features) {
        expect(f.properties.name, `省级 ${label} 档有 feature 缺 name`).toBeTruthy();
        expect(f.properties.adcode, `省级 ${label} 档有 feature 缺 adcode`).toBeTruthy();
        m.set(String(f.properties.adcode), String(f.properties.name));
      }
      return { label, m };
    });

    const base = maps[2];
    for (const { label, m } of maps) {
      expect(m.size, `省级 ${label} 档面数与 fine 不同`).toBe(base.m.size);
      const renamed = [...base.m.entries()].filter(([ad, nm]) => m.get(ad) !== nm);
      expect(renamed, `省级 ${label} 档有省改名`).toEqual([]);
    }
  });

  it('every unit adcode in units.json has a face in the fine tier', async () => {
    const { loadData } = await import('./data');
    const data = await loadData();
    const have = new Set(
      (data.geoJson as { features: { properties: { adcode: string } }[] }).features.map((f) => String(f.properties.adcode)),
    );
    const missing = data.allUnits.filter((u) => !have.has(u.adcode)).map((u) => `${u.name}(${u.adcode})`);
    // 缺面 = 该单位永远无法被着色/点击，属严重问题
    expect(missing).toEqual([]);
  });
});
