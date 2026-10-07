import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { feature } from 'topojson-client';

/**
 * 「其他国家一级行政区」题库（`public/data/other/*`）的数据完整性。
 *
 * 为什么需要这一组测试：这份数据是**构建期生成的**（`scripts/fetch-other-admin1.mjs`），
 * 而生成它的源数据（Natural Earth admin-1）实测有若干处错误 —— 编码与几何对不上、
 * 中文名重名、当地语言名字段互相错配。那些错误已经逐条在管线里兜住，但**兜底逻辑本身**
 * 一旦被人顺手改掉（或将来换了源版本），表现是"地图上的名字与地块不符、判题判错"，
 * 而且不会有任何报错。这组测试就是那份"兜底清单"的看门人。
 *
 * 另外两条是**算法性回归**，都对应本轮真实踩过的坑：
 *   · 质心必须落在自己的包围盒内 —— 第一版手写 TopoJSON 展开漏了差分累加，
 *     阿拉斯加的质心算到 (−154.7, 32.5)，纬度偏南 30°；
 *   · 单个单位不能横跨 >200° 经度 —— 跨 180° 经线的楚科奇/阿留申若不"解缠"，
 *     包围盒会铺满整个地球宽度。
 */

const ROOT = process.cwd();
const OTHER = path.join(ROOT, 'public', 'data', 'other');

interface OtherUnit {
  code: string;
  name: string;
  nameLocal: string;
  nameEn: string;
  decorative?: boolean;
  /**
   * 第一版有"飞地小窗"时数据里带这两个字段；用户口径（2026-10 二次确认）改成
   * "不要小窗，飞地直接在主图上点"之后它们应当**消失**。这里保留为可选字段，
   * 专门用来断言"数据里已经没有了"（类型上删掉就没法断言缺省了）。
   */
  inset?: boolean;
  insetGroup?: number;
  center: [number, number];
  bbox: [number, number, number, number];
  area: number;
  neighbors: string[];
}
interface OtherUnitsFile {
  cc: string;
  name: string;
  lang: { id: string; label: string };
  units: OtherUnit[];
}
interface OtherIndex {
  countries: {
    cc: string;
    name: string;
    lang: { id: string; label: string };
    count: number;
    decorativeCount: number;
    bbox: { main: number[] };
  }[];
}

const read = <T>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T;
const index = read<OtherIndex>(path.join(OTHER, 'index.json'));
const load = (cc: string) => read<OtherUnitsFile>(path.join(OTHER, `${cc}.units.json`));
const poolOf = (f: OtherUnitsFile) => f.units.filter((u) => !u.decorative);

/** 与管线同一口径的期望值（改数据管线时这里也要一起改，改不动就说明口径变了）。 */
const EXPECTED = [
  { cc: 'usa', name: '美国', count: 51, decorative: 0, lang: 'en' },
  { cc: 'can', name: '加拿大', count: 13, decorative: 0, lang: 'en' },
  { cc: 'jpn', name: '日本', count: 47, decorative: 0, lang: 'ja' },
  // 俄罗斯：85 个面 = 83 个题池 + 2 个"不考但显示"（克里米亚、塞瓦斯托波尔）
  { cc: 'rus', name: '俄罗斯', count: 83, decorative: 2, lang: 'ru' },
] as const;

describe('other/index.json · 四国清单', () => {
  it('恰好四国，顺序与计数/语言与口径一致', () => {
    expect(index.countries.map((c) => c.cc)).toEqual(EXPECTED.map((e) => e.cc));
    for (const e of EXPECTED) {
      const c = index.countries.find((x) => x.cc === e.cc)!;
      expect({ cc: c.cc, name: c.name, count: c.count, decorative: c.decorativeCount, lang: c.lang.id }).toEqual({
        cc: e.cc, name: e.name, count: e.count, decorative: e.decorative, lang: e.lang,
      });
    }
  });

  /**
   * 主图包围盒 = **全部单位**的并集。
   *
   * 用户口径（2026-10 二次确认）：不要左下角小窗，飞地（阿拉斯加/夏威夷/加里宁格勒）
   * 就在主图上直接点 —— 故它们必须落在主图投影范围内，不能像第一版那样被排除在外。
   * 下面同时断言"飞地确实把包围盒撑出去了"，否则这条口径会悄悄退回旧行为。
   */
  it('主图包围盒 = 全部单位包围盒的并集（含飞地）', () => {
    for (const e of EXPECTED) {
      const units = load(e.cc).units;
      const union = [
        Math.min(...units.map((u) => u.bbox[0])),
        Math.min(...units.map((u) => u.bbox[1])),
        Math.max(...units.map((u) => u.bbox[2])),
        Math.max(...units.map((u) => u.bbox[3])),
      ];
      const main = index.countries.find((c) => c.cc === e.cc)!.bbox.main;
      main.forEach((v, i) => expect(v).toBeCloseTo(union[i], 3));
    }
  });

  it('飞地不再是"小窗"：四个国家都没有 inset 标记、包围盒里也没有分区', () => {
    const idx = read<{ countries: { cc: string; inset?: boolean; bbox: { insets?: unknown[] } }[] }>(
      path.join(OTHER, 'index.json'),
    );
    for (const c of idx.countries) {
      expect(c.inset ?? false, `${c.cc} 不该再有小窗`).toBe(false);
      expect(c.bbox.insets ?? [], `${c.cc} 不该再有包围盒分区`).toEqual([]);
      for (const u of load(c.cc).units) {
        expect(u.inset ?? false, `${c.cc} 的 ${u.code} 不该再标成飞地`).toBe(false);
        expect(u.insetGroup ?? -1, `${c.cc} 的 ${u.code} 不该再有 insetslot`).toBe(-1);
      }
    }
  });
});

describe.each(EXPECTED)('$name（$cc）· 题池与几何', (e) => {
  const file = load(e.cc);
  const pool = poolOf(file);
  // TopoJSON 的解析结果结构很宽（arcs/transform/objects），用最小形状断言即可 ——
  // 这里只关心"每个几何面带的是哪个编码"，所以只声明用得到的字段。
  const topo = read<{ objects: Record<string, unknown> }>(path.join(OTHER, `${e.cc}.topojson`));
  const geoCodes = (
    feature(topo as never, topo.objects[e.cc] as never) as unknown as { features: { properties: { code: string } }[] }
  ).features
    .map((f) => f.properties.code)
    .sort();

  it('几何面的编码集合与元数据逐字一致（少一个面就是地图与题池对不上）', () => {
    expect(geoCodes).toEqual(file.units.map((u) => u.code).sort());
  });

  it('题池数量与非题池数量', () => {
    expect(pool.length).toBe(e.count);
    expect(file.units.length - pool.length).toBe(e.decorative);
  });

  it('编码唯一且形如 XX-YYY；每个单位都有中文名与当地语言名', () => {
    const codes = file.units.map((u) => u.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const u of file.units) {
      expect(u.code).toMatch(/^[A-Z]{2}-[A-Z0-9]{1,3}$/);
      expect(u.name.trim().length).toBeGreaterThan(0);
      expect(u.nameLocal.trim().length).toBeGreaterThan(0);
    }
  });

  it('题池内的中文名与当地名都唯一（重名 = 两道题答案一样，判题无法区分）', () => {
    for (const key of ['name', 'nameLocal'] as const) {
      const names = pool.map((u) => u[key]);
      expect(new Set(names).size, `${key} 有重复：${names.filter((v, i) => names.indexOf(v) !== i).join(', ')}`).toBe(names.length);
    }
  });

  it('相邻关系对称、不自指、指向的编码都存在', () => {
    const byCode = new Map(file.units.map((u) => [u.code, u]));
    for (const u of file.units) {
      for (const n of u.neighbors) {
        expect(n).not.toBe(u.code);
        expect(byCode.has(n), `${u.code} 的邻居 ${n} 不存在`).toBe(true);
        expect(byCode.get(n)!.neighbors, `${u.code}→${n} 不对称`).toContain(u.code);
      }
    }
  });

  it('质心落在自己的包围盒内（防"手写 TopoJSON 展开漏差分累加"这类坐标错）', () => {
    for (const u of file.units) {
      const [minX, minY, maxX, maxY] = u.bbox;
      expect(u.center[0], `${u.code} 经度出界`).toBeGreaterThanOrEqual(minX - 1e-6);
      expect(u.center[0], `${u.code} 经度出界`).toBeLessThanOrEqual(maxX + 1e-6);
      expect(u.center[1], `${u.code} 纬度出界`).toBeGreaterThanOrEqual(minY - 1e-6);
      expect(u.center[1], `${u.code} 纬度出界`).toBeLessThanOrEqual(maxY + 1e-6);
    }
  });

  it('没有单位横跨 >200° 经度（跨 180° 经线的必须已"解缠"）', () => {
    for (const u of file.units) {
      expect(u.bbox[2] - u.bbox[0], `${u.code} 经度跨度异常`).toBeLessThan(200);
    }
  });

  it('恰好一个单位面积最大且为正；每个单位都分到了正面积', () => {
    for (const u of file.units) expect(u.area).toBeGreaterThan(0);
  });
});

describe('源数据兜底清单（改了兜底就必须同时改这些断言）', () => {
  const rus = load('rus');
  const jpn = load('jpn');
  const usa = load('usa');
  const unit = (f: OtherUnitsFile, code: string) => f.units.find((u) => u.code === code)!;

  it('莫斯科市与莫斯科州的**编码与几何**必须对得上（源数据里两者是互换的）', () => {
    const city = unit(rus, 'RU-MOW');
    const oblast = unit(rus, 'RU-MOS');
    expect(city.name).toBe('莫斯科');
    expect(city.nameLocal).toBe('Москва');
    expect(oblast.name).toBe('莫斯科州');
    expect(oblast.nameLocal).toBe('Московская область');
    // 几何佐证：州比市大得多，且市的包围盒完整落在州之内（这正是"编码是否配对了几何"的判据）
    expect(oblast.area).toBeGreaterThan(city.area * 5);
    expect(city.bbox[0]).toBeGreaterThan(oblast.bbox[0]);
    expect(city.bbox[2]).toBeLessThan(oblast.bbox[2]);
  });

  it('两个"字段各错一条"的俄罗斯单位取了另一个字段的正确值', () => {
    expect(unit(rus, 'RU-ARK').nameLocal).toBe('Архангельская область'); // 源 name_local 错配成沃洛格达州
    expect(unit(rus, 'RU-ALT').nameLocal).toBe('Алтайский край');         // 源 name_ru 错配成阿尔泰共和国
  });

  it('中文名兜底仍然生效（重名/繁体/缺后缀）', () => {
    expect(unit(rus, 'RU-ALT').name).toBe('阿尔泰边疆区');
    expect(unit(rus, 'RU-KAM').name).toBe('堪察加边疆区'); // 源里是繁体「堪察加邊疆區」
    expect(unit(rus, 'RU-IRK').name).toBe('伊尔库茨克州'); // 源里是繁体「伊爾庫茨克州」
    expect(unit(jpn, 'JP-13').name).toBe('东京都');        // 源里只写「东京」
  });

  it('俄罗斯：两条争议地区在库里但**不进题池**（不考但显示）', () => {
    for (const code of ['UA-40', 'UA-43']) {
      const u = unit(rus, code);
      expect(u.decorative).toBe(true);
      expect(u.name.length).toBeGreaterThan(0);
    }
    expect(rus.units.filter((u) => u.decorative).map((u) => u.code)).toEqual(['UA-40', 'UA-43']);
    // 这两块彼此相邻（同在克里米亚半岛上），但都**不与任何俄罗斯联邦主体相邻**（中间隔着乌克兰）——
    // 所以它们既进不了题池，也不该出现在任何题池单位的邻居里。
    expect(unit(rus, 'UA-43').neighbors).toEqual(['UA-40']);
    expect(unit(rus, 'UA-40').neighbors).toEqual(['UA-43']);
    const poolNeighborSeen = poolOf(rus).flatMap((u) => u.neighbors);
    expect(poolNeighborSeen).not.toContain('UA-40');
    expect(poolNeighborSeen).not.toContain('UA-43');
  });

  it('孤立单位正是那几块飞地/离岛（它们留在主图里，直接可点）', () => {
    // 没有邻居的题池单位 = 岛屿/飞地：美国(阿拉斯加/夏威夷)、加拿大(爱德华王子岛)、日本(北海道/冲绳)、俄罗斯(加里宁格勒/萨哈林)
    const isolated = (f: OtherUnitsFile) => poolOf(f).filter((u) => u.neighbors.length === 0).map((u) => u.code).sort();
    expect(isolated(usa)).toEqual(['US-AK', 'US-HI']);
    expect(isolated(load('can'))).toEqual(['CA-PE']);
    expect(isolated(jpn)).toEqual(['JP-01', 'JP-47']);
    expect(isolated(rus)).toEqual(['RU-KGD', 'RU-SAK']);
  });

  it('解缠后的经度确实超出 ±180（楚科奇/阿拉斯加），且都在自家包围盒里', () => {
    expect(unit(rus, 'RU-CHU').bbox[2]).toBeGreaterThan(180);
    expect(unit(usa, 'US-AK').bbox[0]).toBeLessThan(-180);
    // 解缠是"整体平移"，纬度不受影响
    expect(unit(usa, 'US-AK').center[1]).toBeGreaterThan(50);
    expect(unit(usa, 'US-AK').center[1]).toBeLessThan(72);
  });
});
