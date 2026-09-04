// 数据管线：从 @surbowl/world-geo-json-zh（Surbowl 世界 GeoJSON，Unlicense 公有领域）拉取世界地图，
// 按 iso_a3 把 feature 分为「答题国」（联合国 193 会员国 + 梵蒂冈 + 巴勒斯坦 = 195）与「装饰面」
// （属地/南极洲/西撒哈拉/伪国等 44 面），计算国家邻接（turf 相交），输出：
//   public/data/world.geojson    全部面（答题国 + 装饰面），供 ECharts registerMap('world')
//   public/data/countries.json   195 答题国元数据表（iso/中文名/全称/中心点/邻接/答题标记）
// 数据源无运行时依赖（冻结入库）；用法：node scripts/fetch-world-data.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { booleanIntersects } from '@turf/boolean-intersects';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'public', 'data');
const SRC_URL = 'https://cdn.jsdelivr.net/npm/@surbowl/world-geo-json-zh@2.1.4/world.zh.json';
const SOURCE_NOTE = 'https://www.npmjs.com/package/@surbowl/world-geo-json-zh (Surbowl, Unlicense / 公有领域)；含台湾/南海诸岛并入中国面，本管线冻结入库、运行时零网络依赖。';

// 装饰面 iso_a3（非答题）：属地/海外领地/南极洲/西撒哈拉/非会员争议区等。
// 答题池 = 数据全部面 − 装饰面 = 195（联合国 193 会员国 + 梵蒂冈 + 巴勒斯坦）。
// 注意：数据中「阿什莫尔和卡捷群岛」误用澳大利亚的 iso_a3=AUS，按名称剔除。
const DECORATIVE_ISO = new Set([
  'ABW', 'AIA', 'ALA', 'ASM', 'ATA', 'ATF', 'BLM', 'BMU', 'COK', 'CUW', 'CXR', 'CYM',
  'ESH', 'FLK', 'FRO', 'GGY', 'GRL', 'GUM', 'HMD', 'IMN', 'IOT', 'JEY', 'MAF', 'MNP',
  'MSR', 'NCL', 'NFK', 'NIU', 'PCN', 'PRI', 'PYF', 'SGS', 'SHN', 'SPM', 'SXM', 'TCA',
  'UMI', 'VGB', 'VIR', 'WLF',
]);
const DECORATIVE_NAME = new Set(['阿什莫尔和卡捷群岛']);
const PSEUDO_ISO = '-99'; // 索马里兰 / 北塞浦路斯 / 锡亚琴冰川（源数据无 iso 码）

// ---------- 工具 ----------
async function fetchJson(url, retries = 3) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (world-data-builder/1.0)' } });
      if (res.ok) return await res.json();
      lastErr = new Error(`HTTP ${res.status}: ${url}`);
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 600 * (i + 1)));
  }
  throw lastErr;
}

function bboxOf(feature) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const walk = (coords) => {
    for (const c of coords) {
      if (typeof c[0] === 'number') {
        if (c[0] < minX) minX = c[0];
        if (c[0] > maxX) maxX = c[0];
        if (c[1] < minY) minY = c[1];
        if (c[1] > maxY) maxY = c[1];
      } else walk(c);
    }
  };
  walk(feature.geometry.coordinates);
  return [minX, minY, maxX, maxY];
}

function featureCenter(feature) {
  const b = bboxOf(feature);
  return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
}

/** 中文名校正表（iso_a3 → 题面中文简称）：仅在源名不合常用/答案口径时使用；正常名不列。 */
const NAME_OVERRIDE = {
  // 源名已尽量用简称；以下为常见口径微调（若有）
};

console.log('[1/4] 下载 Surbowl 世界 GeoJSON ...');
const world = await fetchJson(SRC_URL);
console.log(`  源 feature 数: ${world.features?.length ?? 0}`);

// ---------- 分拣答题国 / 装饰面 ----------
console.log('[2/4] 按 iso_a3 分拣答题国与装饰面 ...');
const countries = []; // { iso, name, fullName, center, neighbors }
const outFeatures = []; // 全量面（答题国 + 装饰面），供 registerMap
const isoName = new Map(); // 数据源内 name 冲突检测用

for (const f of world.features) {
  const p = f.properties ?? {};
  const iso = String(p.iso_a3 ?? '');
  const name = String(p.name ?? '');
  const fullName = String(p.full_name ?? name);
  const isDeco = iso === PSEUDO_ISO || DECORATIVE_ISO.has(iso) || DECORATIVE_NAME.has(name);
  const props = { iso_a3: iso, name, full_name: fullName, decorative: isDeco ? 1 : 0 };
  outFeatures.push({ type: 'Feature', properties: props, geometry: f.geometry });
  if (!isDeco) {
    countries.push({
      iso,
      name: NAME_OVERRIDE[iso] ?? name,
      fullName,
      center: featureCenter(f),
      neighbors: [],
    });
    if (isoName.has(name)) console.warn(`  ⚠ 源名重复: ${name}（${isoName.get(name)} 与 ${iso}）`);
    else isoName.set(name, iso);
  }
}
console.log(`  答题国: ${countries.length} | 装饰面: ${outFeatures.length - countries.length}`);

// ---------- 邻接关系（bbox 预过滤 + turf 相交；答题国之间） ----------
console.log('[3/4] 计算国家邻接（顺序/BFS 扩张用）...');
// 答题国 feature 直接存引用，bbox 按 countries 顺序对齐
const countryFeatures = countries.map((c) => outFeatures.find((f) => f.properties.iso_a3 === c.iso));
const bboxes = countryFeatures.map(bboxOf);
for (let i = 0; i < countries.length; i++) {
  for (let j = i + 1; j < countries.length; j++) {
    const a = bboxes[i];
    const b = bboxes[j];
    if (a[0] > b[2] || b[0] > a[2] || a[1] > b[3] || b[1] > a[3]) continue;
    if (booleanIntersects(countryFeatures[i], countryFeatures[j])) {
      countries[i].neighbors.push(countries[j].iso);
      countries[j].neighbors.push(countries[i].iso);
    }
  }
}

// ---------- 输出 ----------
fs.mkdirSync(OUT_DIR, { recursive: true });
const worldGeoJson = {
  type: 'FeatureCollection',
  features: outFeatures,
  _source: SOURCE_NOTE,
};
fs.writeFileSync(path.join(OUT_DIR, 'world.geojson'), JSON.stringify(worldGeoJson));
fs.writeFileSync(path.join(OUT_DIR, 'countries.json'), JSON.stringify({ countries, sourceNote: SOURCE_NOTE }));

// ---------- 校验报告 ----------
const noNeighbor = countries.filter((c) => c.neighbors.length === 0);
console.log('[4/4] 校验 ...');
console.log(`\n完成：答题国 ${countries.length}（联合国 193 会员国 + 梵蒂冈 + 巴勒斯坦）+ 装饰面 ${outFeatures.length - countries.length}`);
console.log(`无邻接（岛国/飞地，BFS 将回退最近单位）：${noNeighbor.map((c) => c.name).join('、') || '无'}`);
const size = fs.statSync(path.join(OUT_DIR, 'world.geojson')).size;
const csize = fs.statSync(path.join(OUT_DIR, 'countries.json')).size;
console.log(`world.geojson: ${(size / 1024).toFixed(0)} KB | countries.json: ${(csize / 1024).toFixed(0)} KB`);
console.log(`生成前请人工核对 195 国名单（countries.json）与装饰面（world.geojson 中 decorative=1）。`);
