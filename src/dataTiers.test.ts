import { describe, it, expect, vi, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 端到端数据加载验证（跑在 vitest 里，复用它的 TS 解析）。
 *
 * 为什么需要：`tsc` 只能证明字段**类型**对，不能证明
 *   · `data.ts` 里的文件名与 `public/data/` 下真实文件对得上（写错 → 运行时 404 → 地图空白）
 *   · 各档真的是合法 GeoJSON、且顶点数随档位单调递增
 *   · `tiers.ts` 算出的地图名与 `data.ts` 的字段一一对应
 * 这里用 fetch shim 把请求重定向到磁盘，跑**真实的** loadData()。
 */
const DATA = join(process.cwd(), 'public', 'data');

describe('数据加载端到端（真实 loadData）', () => {
  const requested: string[] = [];

  beforeAll(() => {
    vi.stubGlobal('fetch', async (url: string) => {
      const name = String(url).replace(/^.*\/data\//, '').replace(/^data\//, '');
      requested.push(name);
      try {
        const body = readFileSync(join(DATA, name), 'utf8');
        return { ok: true, status: 200, json: async () => JSON.parse(body) };
      } catch {
        return { ok: false, status: 404, json: async () => { throw new Error('404 ' + name); } };
      }
    });
  });

  const polysOf = (g: { type?: string; coordinates?: unknown } | null) => {
    if (!g) return [] as number[][][][];
    if (g.type === 'Polygon') return [g.coordinates] as number[][][][];
    if (g.type === 'MultiPolygon') return g.coordinates as number[][][][];
    return [];
  };
  function stats(gj: unknown) {
    let feats = 0, verts = 0, rings = 0;
    for (const f of (gj as { features?: { geometry: never }[] })?.features ?? []) {
      feats++;
      for (const poly of polysOf(f.geometry)) for (const r of poly) { rings++; verts += r.length; }
    }
    return { feats, verts, rings };
  }

  it('loads every tier with the expected feature count and a strictly growing vertex ladder', async () => {
    const { loadData } = await import('./data');
    const data = await loadData();

    // 所有请求都必须命中真实文件（404 会被上面的 shim 变成抛错，这里再断言一次更明确）
    expect(requested.length).toBeGreaterThanOrEqual(14);
    expect(requested.some((f) => f.includes('undefined'))).toBe(false);

    const pref = [
      ['ultra 4%', data.ultraGeoJson], ['pro 8%', data.proGeoJson], ['fine 15%', data.geoJson],
      ['plus 40%', data.plusGeoJson], ['lossless 100%', data.losslessGeoJson],
    ] as const;
    let prev = -1;
    for (const [label, gj] of pref) {
      const s = stats(gj);
      expect(s.feats, `${label} 地级面数`).toBe(373);
      expect(s.verts, `${label} 顶点数应多于上一档`).toBeGreaterThan(prev);
      prev = s.verts;
    }

    const prov = [
      ['ultra 4%', data.provincesUltraGeoJson], ['pro 8%', data.provincesProGeoJson],
      ['fine 15%', data.provincesGeoJson], ['plus 40%', data.provincesPlusGeoJson],
      ['lossless 100%', data.provincesRawGeoJson],
    ] as const;
    prev = -1;
    for (const [label, gj] of prov) {
      const s = stats(gj);
      expect(s.feats, `${label} 省级面数`).toBe(35);
      expect(s.verts, `${label} 顶点数应多于上一档`).toBeGreaterThan(prev);
      prev = s.verts;
    }
  });

  it('keeps the legacy alias fields pointing at the same objects', async () => {
    const { loadData } = await import('./data');
    const data = await loadData();
    // 旧测试固件/旧缓存可能引用这两个字段；它们必须与对应档位是同一份数据。
    expect(data.coarseGeoJson).toBe(data.proGeoJson);
    expect(data.provincesCoarseGeoJson).toBe(data.provincesUltraGeoJson);
  });

  it('maps every zoom band to a map name whose data field is actually populated', async () => {
    const { loadData } = await import('./data');
    const { tierOfZoom, chinaMapNameForTier, provinceMapNameForTier } = await import('./map/tiers');
    const data = await loadData();

    // 地图名 → AppData 字段（renderer.registerMap 用的就是这些组合）
    const FIELD: Record<string, keyof typeof data> = {
      'china-ultra': 'ultraGeoJson', 'china-pro': 'proGeoJson', china: 'geoJson',
      'china-plus': 'plusGeoJson', 'china-lossless': 'losslessGeoJson',
      'china-provinces-ultra': 'provincesUltraGeoJson', 'china-provinces-pro': 'provincesProGeoJson',
      'china-provinces': 'provincesGeoJson', 'china-provinces-plus': 'provincesPlusGeoJson',
      'china-provinces-raw': 'provincesRawGeoJson',
    };

    for (const zoom of [0.8, 1, 1.99, 2, 5.99, 6, 9.99, 10, 13.99, 14, 20, 28]) {
      const tier = tierOfZoom(zoom);
      const cn = chinaMapNameForTier(tier);
      const pv = provinceMapNameForTier(tier);
      // 两个地图名都必须有对应的、非空的 AppData 字段 —— 漏一个就是运行时空白地图
      expect(FIELD[cn], `zoom ${zoom} 地级地图名 ${cn} 无对应字段`).toBeTruthy();
      expect(data[FIELD[cn]], `zoom ${zoom} 地级字段 ${FIELD[cn]} 为空`).toBeTruthy();
      expect(FIELD[pv], `zoom ${zoom} 省级地图名 ${pv} 无对应字段`).toBeTruthy();
      expect(data[FIELD[pv]], `zoom ${zoom} 省级字段 ${FIELD[pv]} 为空`).toBeTruthy();
    }
  });

  it('every registered map name in both families resolves to real geometry', async () => {
    const { loadData } = await import('./data');
    const { ALL_CHINA_MAP_NAMES, ALL_PROVINCE_MAP_NAMES } = await import('./map/tiers');
    const data = await loadData();
    const all: Record<string, unknown> = {
      'china-ultra': data.ultraGeoJson, 'china-pro': data.proGeoJson, china: data.geoJson,
      'china-plus': data.plusGeoJson, 'china-lossless': data.losslessGeoJson,
      'china-provinces-ultra': data.provincesUltraGeoJson, 'china-provinces-pro': data.provincesProGeoJson,
      'china-provinces': data.provincesGeoJson, 'china-provinces-plus': data.provincesPlusGeoJson,
      'china-provinces-raw': data.provincesRawGeoJson,
    };
    for (const n of [...ALL_CHINA_MAP_NAMES, ...ALL_PROVINCE_MAP_NAMES]) {
      expect(all[n], `注册地图名 ${n} 没有几何`).toBeTruthy();
      expect((all[n] as { features?: unknown[] }).features?.length).toBeGreaterThan(0);
    }
  });
});
