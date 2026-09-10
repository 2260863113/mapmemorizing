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

/**
 * 大洲归属表（iso_a3 → six-continent 口径：AS 亚洲 / EU 欧洲 / AF 非洲 / NA 北美洲 / SA 南美洲 / OC 大洋洲）。
 * 不含南极洲（无答题国）。口径按地理教科书写法：
 *   - 俄罗斯/土耳其/塞浦路斯/格鲁吉亚/亚美尼亚/阿塞拜疆 → 欧洲（俄土跨洲，按国际惯例归欧洲）；
 *   - 埃及 → 非洲（跨亚非，主体在非洲）；哈萨克斯坦 → 亚洲；
 *   - 巴拿马 → 北美洲（跨南北美，按地峡主流归北美）；
 *   - 特立尼达和多巴哥/加勒比诸岛 → 北美洲；
 *   - 巴勒斯坦/以色列/约旦等中东 → 亚洲；印度尼西亚/东帝汶 → 亚洲；巴布亚新几内亚 → 大洋洲。
 * 统计：AF 54 + AS 46 + EU 46 + NA 23 + SA 12 + OC 14 = 195。
 */
const CONTINENT_OF = {
  // ===== 亚洲（46）=====
  AFG: 'AS', BHR: 'AS', BGD: 'AS', BTN: 'AS', BRN: 'AS', KHM: 'AS', CHN: 'AS', IND: 'AS',
  IDN: 'AS', IRN: 'AS', IRQ: 'AS', ISR: 'AS', JPN: 'AS', JOR: 'AS', KAZ: 'AS', KWT: 'AS',
  KGZ: 'AS', LAO: 'AS', LBN: 'AS', MYS: 'AS', MDV: 'AS', MNG: 'AS', MMR: 'AS', NPL: 'AS',
  PRK: 'AS', OMN: 'AS', PAK: 'AS', PSE: 'AS', PHL: 'AS', QAT: 'AS', SAU: 'AS', SGP: 'AS',
  KOR: 'AS', LKA: 'AS', SYR: 'AS', TJK: 'AS', THA: 'AS', TLS: 'AS', TKM: 'AS', ARE: 'AS',
  UZB: 'AS', VNM: 'AS', YEM: 'AS', ARM: 'AS', AZE: 'AS', GEO: 'AS',
  // ===== 欧洲（46）=====
  ALB: 'EU', AND: 'EU', AUT: 'EU', BLR: 'EU', BEL: 'EU', BIH: 'EU', BGR: 'EU', HRV: 'EU',
  CYP: 'EU', CZE: 'EU', DNK: 'EU', EST: 'EU', FIN: 'EU', FRA: 'EU', DEU: 'EU', GRC: 'EU',
  HUN: 'EU', ISL: 'EU', IRL: 'EU', ITA: 'EU', LVA: 'EU', LIE: 'EU', LTU: 'EU', LUX: 'EU',
  MLT: 'EU', MDA: 'EU', MCO: 'EU', MNE: 'EU', NLD: 'EU', MKD: 'EU', NOR: 'EU', POL: 'EU',
  PRT: 'EU', ROU: 'EU', RUS: 'EU', SMR: 'EU', SRB: 'EU', SVK: 'EU', SVN: 'EU', ESP: 'EU',
  SWE: 'EU', CHE: 'EU', TUR: 'EU', UKR: 'EU', GBR: 'EU', VAT: 'EU',
  // ===== 非洲（54）=====
  DZA: 'AF', AGO: 'AF', BEN: 'AF', BWA: 'AF', BFA: 'AF', BDI: 'AF', CPV: 'AF', CMR: 'AF',
  CAF: 'AF', TCD: 'AF', COM: 'AF', COG: 'AF', COD: 'AF', CIV: 'AF', DJI: 'AF', EGY: 'AF',
  GNQ: 'AF', ERI: 'AF', SWZ: 'AF', ETH: 'AF', GAB: 'AF', GMB: 'AF', GHA: 'AF', GIN: 'AF',
  GNB: 'AF', KEN: 'AF', LSO: 'AF', LBR: 'AF', LBY: 'AF', MDG: 'AF', MWI: 'AF', MLI: 'AF',
  MRT: 'AF', MUS: 'AF', MAR: 'AF', MOZ: 'AF', NAM: 'AF', NER: 'AF', NGA: 'AF', RWA: 'AF',
  STP: 'AF', SEN: 'AF', SYC: 'AF', SLE: 'AF', SOM: 'AF', ZAF: 'AF', SSD: 'AF', SDN: 'AF',
  TZA: 'AF', TGO: 'AF', TUN: 'AF', UGA: 'AF', ZMB: 'AF', ZWE: 'AF',
  // ===== 北美洲（23）=====
  ATG: 'NA', BHS: 'NA', BRB: 'NA', BLZ: 'NA', CAN: 'NA', CRI: 'NA', CUB: 'NA', DMA: 'NA',
  DOM: 'NA', SLV: 'NA', GRD: 'NA', GTM: 'NA', HTI: 'NA', HND: 'NA', JAM: 'NA', MEX: 'NA',
  NIC: 'NA', PAN: 'NA', KNA: 'NA', LCA: 'NA', VCT: 'NA', TTO: 'NA', USA: 'NA',
  // ===== 南美洲（12）=====
  ARG: 'SA', BOL: 'SA', BRA: 'SA', CHL: 'SA', COL: 'SA', ECU: 'SA', GUY: 'SA', PRY: 'SA',
  PER: 'SA', SUR: 'SA', URY: 'SA', VEN: 'SA',
  // ===== 大洋洲（14）=====
  AUS: 'OC', FJI: 'OC', KIR: 'OC', MHL: 'OC', FSM: 'OC', NRU: 'OC', NZL: 'OC', PLW: 'OC',
  PNG: 'OC', WSM: 'OC', SLB: 'OC', TON: 'OC', TUV: 'OC', VUT: 'OC',
};

/** 大洲中文名（校验报告用）。 */
const CONTINENT_LABEL = { AS: '亚洲', EU: '欧洲', AF: '非洲', NA: '北美洲', SA: '南美洲', OC: '大洋洲' };

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
      continent: CONTINENT_OF[iso] ?? 'AS',
    });
    if (!CONTINENT_OF[iso]) console.warn(`  ⚠ 缺大洲归属: ${name} (${iso})，已回退亚洲`);
    if (isoName.has(name)) console.warn(`  ⚠ 源名重复: ${name}（${isoName.get(name)} 与 ${iso}）`);
    else isoName.set(name, iso);
  }
}
console.log(`  答题国: ${countries.length} | 装饰面: ${outFeatures.length - countries.length}`);
// 大洲分布校验（口径：AF 54 + AS 48 + EU 44 + NA 23 + SA 12 + OC 14 = 195）
{
  const dist = {};
  for (const c of countries) dist[c.continent] = (dist[c.continent] ?? 0) + 1;
  const parts = Object.entries(dist).map(([k, v]) => `${CONTINENT_LABEL[k] ?? k} ${v}`);
  console.log(`  大洲分布: ${parts.join(' | ')}`);
  const total = Object.values(dist).reduce((a, b) => a + b, 0);
  if (total !== countries.length) console.warn(`  ⚠ 大洲分布合计 ${total} ≠ 答题国 ${countries.length}`);
}

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
