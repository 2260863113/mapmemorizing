// 生成 public/data/subregions.json：195 个答题国 → 次区域（方位式粗分，不做北亚）。
//
// 口径（见 docs/adr/0004，用户逐条确认）：
//   1. 方位式粗分，不做「北亚」——俄罗斯整体归东欧（避免切割国界几何）。
//   2. 波罗的海三国（爱沙尼亚/拉脱维亚/立陶宛）归北欧。
//   3. 高加索三国（格鲁吉亚/亚美尼亚/阿塞拜疆）、塞浦路斯、土耳其归西亚。
//   4. 「土耳其/塞浦路斯归西亚」意味着二者的大洲归属必须从欧洲改为亚洲，否则
//      「次区域 ⊆ 大洲」这条不变量会被破坏（西亚会同时挂在亚洲行与欧洲行下）。
//      本脚本随 subregions.json 一并把 countries.json 的 continent 修正为 AS，
//      并同步修正 scripts/fetch-world-data.mjs 的 CONTINENT_OF 表，保证管线可重跑。
//
// 断言（任一失败即中止，不产出文件）：
//   A. 195 个 iso 恰好全覆盖，无遗漏、无多余、无重复。
//   B. 每个次区域非空。
//   C. 每个大洲内「其次区域成员并集」恰好等于该大洲的全部国家（次区域 ⊆ 大洲）。
//   D. 洲际成员数守恒（50 洲前缀与 countries.json 的 continent 分布一致）。
//   E. 次区域总数与元数据条数一致。
//
// 用法：node scripts/build-subregions.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COUNTRIES = path.join(ROOT, 'public', 'data', 'countries.json');
const OUT = path.join(ROOT, 'public', 'data', 'subregions.json');
const WORLD_PIPELINE = path.join(ROOT, 'scripts', 'fetch-world-data.mjs');

/** 次区域元数据：id / 中文名 / 短名 / 所属大洲。顺序即 UI 展示顺序。 */
const SUBREGIONS = [
  // 亚洲
  { id: 'EAS', name: '东亚', continent: 'AS' },
  { id: 'SEA', name: '东南亚', continent: 'AS' },
  { id: 'SAS', name: '南亚', continent: 'AS' },
  { id: 'WAS', name: '西亚', continent: 'AS' },
  { id: 'CAS', name: '中亚', continent: 'AS' },
  // 欧洲
  { id: 'NEU', name: '北欧', continent: 'EU' },
  { id: 'WEU', name: '西欧', continent: 'EU' },
  { id: 'CEU', name: '中欧', continent: 'EU' },
  { id: 'EEU', name: '东欧', continent: 'EU' },
  { id: 'SEU', name: '南欧', continent: 'EU' },
  // 非洲
  { id: 'NAF', name: '北非', continent: 'AF' },
  { id: 'WAF', name: '西非', continent: 'AF' },
  { id: 'MAF', name: '中非', continent: 'AF' },
  { id: 'EAF', name: '东非', continent: 'AF' },
  { id: 'SAF', name: '南部非洲', continent: 'AF' },
  // 北美
  { id: 'NAM', name: '北美', continent: 'NA' },
  { id: 'CAM', name: '中美', continent: 'NA' },
  { id: 'CAR', name: '加勒比', continent: 'NA' },
  // 南美（单一分区 → UI 不显示次区域行，但映射仍需存在）
  { id: 'SAM', name: '南美', continent: 'SA' },
  // 大洋洲
  { id: 'ANZ', name: '澳新', continent: 'OC' },
  { id: 'MEL', name: '美拉尼西亚', continent: 'OC' },
  { id: 'MIC', name: '密克罗尼西亚', continent: 'OC' },
  { id: 'POL', name: '波利尼西亚', continent: 'OC' },
];

/** iso_a3 → 次区域 id（195 条，逐条人工审定）。 */
const BY_ISO = {
  // ===== 亚洲 AS（48：含土耳其/塞浦路斯，见顶部口径 4）=====
  // 东亚 5
  CHN: 'EAS', JPN: 'EAS', KOR: 'EAS', PRK: 'EAS', MNG: 'EAS',
  // 东南亚 11
  VNM: 'SEA', THA: 'SEA', SGP: 'SEA', PHL: 'SEA', MYS: 'SEA', LAO: 'SEA',
  IDN: 'SEA', KHM: 'SEA', MMR: 'SEA', BRN: 'SEA', TLS: 'SEA',
  // 南亚 8
  LKA: 'SAS', PAK: 'SAS', NPL: 'SAS', MDV: 'SAS', IND: 'SAS', BTN: 'SAS',
  BGD: 'SAS', AFG: 'SAS',
  // 西亚 19
  YEM: 'WAS', ARE: 'WAS', SYR: 'WAS', SAU: 'WAS', QAT: 'WAS', OMN: 'WAS',
  LBN: 'WAS', KWT: 'WAS', JOR: 'WAS', ISR: 'WAS', PSE: 'WAS', IRQ: 'WAS',
  IRN: 'WAS', GEO: 'WAS', BHR: 'WAS', AZE: 'WAS', ARM: 'WAS', TUR: 'WAS',
  CYP: 'WAS',
  // 中亚 5
  UZB: 'CAS', TKM: 'CAS', TJK: 'CAS', KGZ: 'CAS', KAZ: 'CAS',

  // ===== 欧洲 EU（44：移除土耳其/塞浦路斯）=====
  // 北欧 8（含波罗的海三国，见顶部口径 2）
  SWE: 'NEU', NOR: 'NEU', FIN: 'NEU', ISL: 'NEU', DNK: 'NEU', EST: 'NEU',
  LVA: 'NEU', LTU: 'NEU',
  // 西欧 7
  GBR: 'WEU', NLD: 'WEU', IRL: 'WEU', FRA: 'WEU', BEL: 'WEU', LUX: 'WEU',
  MCO: 'WEU',
  // 中欧 9
  DEU: 'CEU', CHE: 'CEU', AUT: 'CEU', POL: 'CEU', CZE: 'CEU', SVK: 'CEU',
  HUN: 'CEU', SVN: 'CEU', LIE: 'CEU',
  // 东欧 6（俄罗斯整体归东欧，不拆北亚）
  RUS: 'EEU', UKR: 'EEU', BLR: 'EEU', MDA: 'EEU', ROU: 'EEU', BGR: 'EEU',
  // 南欧 14
  ESP: 'SEU', PRT: 'SEU', ITA: 'SEU', GRC: 'SEU', MLT: 'SEU', AND: 'SEU',
  SMR: 'SEU', VAT: 'SEU', SRB: 'SEU', HRV: 'SEU', BIH: 'SEU', MNE: 'SEU',
  MKD: 'SEU', ALB: 'SEU',

  // ===== 非洲 AF（54）=====
  // 北非 6
  DZA: 'NAF', EGY: 'NAF', LBY: 'NAF', MAR: 'NAF', SDN: 'NAF', TUN: 'NAF',
  // 西非 16
  BEN: 'WAF', BFA: 'WAF', CPV: 'WAF', CIV: 'WAF', GMB: 'WAF', GHA: 'WAF',
  GIN: 'WAF', GNB: 'WAF', LBR: 'WAF', MLI: 'WAF', MRT: 'WAF', NER: 'WAF',
  NGA: 'WAF', SEN: 'WAF', SLE: 'WAF', TGO: 'WAF',
  // 中非 9
  AGO: 'MAF', CMR: 'MAF', CAF: 'MAF', TCD: 'MAF', COG: 'MAF', COD: 'MAF',
  GNQ: 'MAF', GAB: 'MAF', STP: 'MAF',
  // 东非 18
  BDI: 'EAF', COM: 'EAF', DJI: 'EAF', ERI: 'EAF', ETH: 'EAF', KEN: 'EAF',
  MDG: 'EAF', MWI: 'EAF', MUS: 'EAF', MOZ: 'EAF', RWA: 'EAF', SYC: 'EAF',
  SOM: 'EAF', SSD: 'EAF', TZA: 'EAF', UGA: 'EAF', ZMB: 'EAF', ZWE: 'EAF',
  // 南部非洲 5
  BWA: 'SAF', LSO: 'SAF', NAM: 'SAF', ZAF: 'SAF', SWZ: 'SAF',

  // ===== 北美 NA（23）=====
  // 北美 2
  USA: 'NAM', CAN: 'NAM',
  // 中美 8
  MEX: 'CAM', GTM: 'CAM', BLZ: 'CAM', SLV: 'CAM', HND: 'CAM', NIC: 'CAM',
  CRI: 'CAM', PAN: 'CAM',
  // 加勒比 13
  CUB: 'CAR', JAM: 'CAR', HTI: 'CAR', DOM: 'CAR', TTO: 'CAR', BRB: 'CAR',
  BHS: 'CAR', GRD: 'CAR', LCA: 'CAR', VCT: 'CAR', KNA: 'CAR', ATG: 'CAR',
  DMA: 'CAR',

  // ===== 南美 SA（12，单一分区）=====
  VEN: 'SAM', URY: 'SAM', SUR: 'SAM', PER: 'SAM', PRY: 'SAM', GUY: 'SAM',
  ECU: 'SAM', COL: 'SAM', CHL: 'SAM', BRA: 'SAM', BOL: 'SAM', ARG: 'SAM',

  // ===== 大洋洲 OC（14）=====
  // 澳新 2
  AUS: 'ANZ', NZL: 'ANZ',
  // 美拉尼西亚 4
  PNG: 'MEL', SLB: 'MEL', VUT: 'MEL', FJI: 'MEL',
  // 密克罗尼西亚 5
  FSM: 'MIC', MHL: 'MIC', PLW: 'MIC', NRU: 'MIC', KIR: 'MIC',
  // 波利尼西亚 3
  TUV: 'POL', WSM: 'POL', TON: 'POL',
};

/** 口径 4：这两个国家的大洲归属需从欧洲修正为亚洲，使「次区域 ⊆ 大洲」成立。 */
const CONTINENT_FIX = { TUR: 'AS', CYP: 'AS' };

// ==================== 校验 ====================

function fail(msg) {
  console.error('✗ ' + msg);
  process.exit(1);
}

const countriesRaw = JSON.parse(fs.readFileSync(COUNTRIES, 'utf8'));
const countries = countriesRaw.countries;
const meta = new Map(SUBREGIONS.map((s) => [s.id, s]));
if (meta.size !== SUBREGIONS.length) fail('次区域元数据存在重复 id');

const isoSet = new Set(countries.map((c) => c.iso));
const mapped = Object.keys(BY_ISO);

// 断言 A：全覆盖、无多余、无重复
const dupes = mapped.filter((iso, i) => mapped.indexOf(iso) !== i);
if (dupes.length) fail('BY_ISO 存在重复键：' + dupes.join(','));
const missing = [...isoSet].filter((iso) => !(iso in BY_ISO));
if (missing.length) fail(`BY_ISO 遗漏 ${missing.length} 个答题国：` + missing.join(','));
const extra = mapped.filter((iso) => !isoSet.has(iso));
if (extra.length) fail('BY_ISO 含非答题国：' + extra.join(','));
if (mapped.length !== 195) fail(`BY_ISO 应为 195 条，实际 ${mapped.length}`);

// 断言 A2：次区域 id 均已在元数据中声明
for (const iso of mapped) {
  if (!meta.has(BY_ISO[iso])) fail(`${iso} 指向未声明的次区域 ${BY_ISO[iso]}`);
}

// 应用大洲修正并复核断言 C / D
const continentOf = new Map(countries.map((c) => [c.iso, CONTINENT_FIX[c.iso] ?? c.continent]));
const targetCount = countries.length;

/** 断言 B：每个次区域非空。 */
const counts = new Map(SUBREGIONS.map((s) => [s.id, 0]));
for (const iso of mapped) counts.set(BY_ISO[iso], counts.get(BY_ISO[iso]) + 1);
for (const s of SUBREGIONS) {
  if (counts.get(s.id) === 0) fail(`次区域 ${s.id}（${s.name}）为空`);
}

/** 断言 C + D：每个大洲内次区域成员并集 = 该洲全部国家；洲际总数守恒。 */
let total = 0;
for (const continent of ['AS', 'EU', 'AF', 'NA', 'SA', 'OC']) {
  const membersOfContinent = [...continentOf.entries()]
    .filter(([, c]) => c === continent)
    .map(([iso]) => iso)
    .sort();
  const subs = SUBREGIONS.filter((s) => s.continent === continent);
  const union = new Set();
  for (const s of subs) for (const iso of mapped) if (BY_ISO[iso] === s.id) union.add(iso);
  const unionSorted = [...union].sort();
  if (unionSorted.join(',') !== membersOfContinent.join(',')) {
    const onlyInContinent = membersOfContinent.filter((x) => !union.has(x));
    const onlyInSubs = unionSorted.filter((x) => !continentOf.has(x) || continentOf.get(x) !== continent);
    fail(
      `断言 C 失败：${continent} 的次区域并集 ≠ 该洲成员。` +
        ` 仅属洲: [${onlyInContinent.join(',')}] 仅属次区域: [${onlyInSubs.join(',')}]`,
    );
  }
  total += membersOfContinent.length;
  console.log(`  ${continent}: ${membersOfContinent.length} 国 / ${subs.length} 个次区域`);
}
if (total !== targetCount) fail(`洲际总数 ${total} ≠ ${targetCount}`);

// 断言 E：元数据条数
if (SUBREGIONS.length !== counts.size) fail('次区域元数据条数与映射不一致');

// ==================== 产出 ====================

const out = {
  subregions: SUBREGIONS.map((s) => ({ ...s, count: counts.get(s.id) })),
  byIso: Object.fromEntries(mapped.slice().sort().map((iso) => [iso, BY_ISO[iso]])),
  sourceNote:
    '方位式粗分（不做北亚，俄罗斯整体归东欧）；波罗的海三国归北欧；高加索三国/塞浦路斯/土耳其归西亚。' +
    '由 scripts/build-subregions.mjs 生成，195 条全覆盖并带「次区域 ⊆ 大洲」断言（见 docs/adr/0004）。',
};
fs.writeFileSync(OUT, JSON.stringify(out, null, 0) + '\n', 'utf8');
console.log(`✓ 写出 ${path.relative(ROOT, OUT)}：${SUBREGIONS.length} 个次区域，${mapped.length} 条映射`);

/** 断言 C 依赖 countries.json 的大洲归属；把口径 4 的修正落回数据源与管线。 */
let changed = 0;
for (const c of countries) {
  const want = CONTINENT_FIX[c.iso];
  if (want && c.continent !== want) {
    console.log(`  continent 修正：${c.iso} ${c.name} ${c.continent} → ${want}`);
    c.continent = want;
    changed += 1;
  }
}
if (changed) {
  fs.writeFileSync(COUNTRIES, JSON.stringify(countriesRaw, null, 0) + '\n', 'utf8');
  console.log(`✓ 修正 countries.json 的 ${changed} 条 continent`);
}

/** 同步管线表，保证 node scripts/fetch-world-data.mjs 重跑不会回退该修正。 */
let pipe = fs.readFileSync(WORLD_PIPELINE, 'utf8');
let pipeChanged = 0;
for (const [iso, want] of Object.entries(CONTINENT_FIX)) {
  // 管线里键是裸标识符（CYP: 'EU',），不是带引号的字符串键
  const re = new RegExp(`(\\b${iso}\\s*:\\s*')EU(')`);
  if (re.test(pipe)) {
    pipe = pipe.replace(re, `$1${want}$2`);
    pipeChanged += 1;
  }
}
if (pipeChanged) {
  fs.writeFileSync(WORLD_PIPELINE, pipe, 'utf8');
  console.log(`✓ 同步 fetch-world-data.mjs 的 CONTINENT_OF（${pipeChanged} 条）`);
}
