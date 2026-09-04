// 数据管线：从阿里云 DataV.GeoAtlas 下载全国地级行政区边界，
// 合并为单个 GeoJSON + 元数据表（含 BFS 邻接）+ 省界图层 + 省直辖县级填充面（补齐地图空白）。
// 用法：node scripts/build-data.mjs [--no-simplify] [--tolerance=0.003]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { booleanIntersects } from '@turf/boolean-intersects';
import { simplify } from '@turf/simplify';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'public', 'data');
const BASE = 'https://geo.datav.aliyun.com/areas_v3/bound/';

// ---------- 规范化规则（单一事实源：src/normalize-rules.json，与 src/matcher.ts 共用） ----------
const RULES = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'normalize-rules.json'), 'utf8'));
const ETHNIC_WORDS = RULES.ethnicWords;
const ETHNIC_RE = new RegExp(`(?:${ETHNIC_WORDS.join('|')})(?:族)?(?=自治)`, 'g');
const SUFFIXES = RULES.suffixes;

// [adcode, 名称, 是否整体单位（京沪津渝港澳台，无地级层）]
const PROVINCES = [
  ['110000', '北京市', 1], ['120000', '天津市', 1], ['130000', '河北省', 0], ['140000', '山西省', 0],
  ['150000', '内蒙古自治区', 0], ['210000', '辽宁省', 0], ['220000', '吉林省', 0], ['230000', '黑龙江省', 0],
  ['310000', '上海市', 1], ['320000', '江苏省', 0], ['330000', '浙江省', 0], ['340000', '安徽省', 0],
  ['350000', '福建省', 0], ['360000', '江西省', 0], ['370000', '山东省', 0], ['410000', '河南省', 0],
  ['420000', '湖北省', 0], ['430000', '湖南省', 0], ['440000', '广东省', 0], ['450000', '广西壮族自治区', 0],
  ['460000', '海南省', 0], ['500000', '重庆市', 1], ['510000', '四川省', 0], ['520000', '贵州省', 0],
  ['530000', '云南省', 0], ['540000', '西藏自治区', 0], ['610000', '陕西省', 0], ['620000', '甘肃省', 0],
  ['630000', '青海省', 0], ['640000', '宁夏回族自治区', 0], ['650000', '新疆维吾尔自治区', 0],
  ['710000', '台湾省', 1], ['810000', '香港特别行政区', 1], ['820000', '澳门特别行政区', 1],
];

const SPECIAL_SHORT = {
  '110000': '北京', '120000': '天津', '310000': '上海', '500000': '重庆',
  '710000': '台湾', '810000': '香港', '820000': '澳门',
};

// ---------- 规范化（与 src/matcher.ts 保持同步） ----------
function normalize(raw) {
  let s = String(raw).trim().toLowerCase();
  let prev = '';
  while (s !== prev) {
    prev = s;
    s = s.replace(ETHNIC_RE, '');
  }
  prev = '';
  while (s !== prev) {
    prev = s;
    for (const suf of SUFFIXES) {
      if (s.endsWith(suf)) {
        s = s.slice(0, -suf.length);
        break;
      }
    }
  }
  return s;
}

// ---------- 工具 ----------
async function fetchJson(url, retries = 3) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (DataV-builder/1.0)' } });
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

// 保守简化：小面（岛屿/小县级）跳过；简化结果退化（无坐标/零面积）时回退原始
function safeSimplify(feature, tolerance) {
  const b = bboxOf(feature);
  const span = Math.max(b[2] - b[0], b[3] - b[1]);
  if (span < 0.2) return feature;
  try {
    const out = simplify(feature, { tolerance, highQuality: false });
    if (!out || !out.geometry || !out.geometry.coordinates) return feature;
    const nb = bboxOf(out);
    if (nb[2] - nb[0] < 1e-9 || nb[3] - nb[1] < 1e-9) return feature;
    return out;
  } catch {
    return feature;
  }
}

// ---------- 下载与合并 ----------
console.log('[1/5] 下载全国省界（含港澳台、南海诸岛）...');
const national = await fetchJson(BASE + '100000_full.json');
const nationalByAdcode = new Map(national.features.map((f) => [String(f.properties.adcode), f]));

const features = [];
const units = [];
const pendingCounty = []; // 非地级 6 位候选（区县 或 省直辖县级）

console.log('[2/5] 下载各省地级边界...');
for (const [adcode, pname, special] of PROVINCES) {
  if (special) {
    let feat = nationalByAdcode.get(adcode);
    if (!feat) {
      const j = await fetchJson(BASE + adcode + '.json');
      feat = j.features[0];
    }
    if (!feat) {
      console.warn(`  ⚠ 缺少 ${pname} 的省界，跳过`);
      continue;
    }
    const short = SPECIAL_SHORT[adcode];
    features.push({ type: 'Feature', properties: { adcode, name: short }, geometry: feat.geometry });
    units.push({
      adcode, name: short, shortName: short, province: pname, provinceAdcode: adcode,
      center: feat.properties.center || feat.properties.centroid || [104.5, 35], neighbors: [],
    });
    console.log(`  [整体单位] ${short}`);
  } else {
    const j = await fetchJson(BASE + adcode + '_full.json');
    let n = 0;
    for (const child of j.features) {
      const c = String(child.properties.adcode);
      if (!/^\d{6}$/.test(c) || c === adcode) continue;
      if (c.endsWith('00')) {
        // 地级单位（adcode 末两位 00）
        const name = String(child.properties.name);
        features.push({ type: 'Feature', properties: { adcode: c, name }, geometry: child.geometry });
        units.push({
          adcode: c, name, shortName: normalize(name) || name, province: pname, provinceAdcode: adcode,
          center: child.properties.center || child.properties.centroid || [104.5, 35], neighbors: [],
        });
        n++;
      } else {
        pendingCounty.push({
          adcode: c, name: String(child.properties.name), province: pname, provinceAdcode: adcode, feature: child,
        });
      }
    }
    console.log(`  ${pname}: ${n} 个地级单位`);
  }
}

// 省直辖县级单位：adcode 前 4 位不属于任何地级 → 不隶属任何地级市（如海南直辖县、仙桃、济源、兵团城市），
// 作为独立可交互单位补齐地图空白，并参与匹配/统计/测试。
console.log('[3/5] 分拣省直辖县级单位...');
const cityPrefixes = new Set(units.filter((u) => !u.decorative).map((u) => u.adcode.slice(0, 4)));
let countyN = 0;
for (const c of pendingCounty) {
  if (cityPrefixes.has(c.adcode.slice(0, 4))) continue; // 属于某地级市（普通区县），不需要
  units.push({
    adcode: c.adcode, name: c.name, shortName: normalize(c.name) || c.name, province: c.province, provinceAdcode: c.provinceAdcode,
    center: c.feature.properties.center || c.feature.properties.centroid || [104.5, 35], neighbors: [],
  });
  features.push({ type: 'Feature', properties: { adcode: c.adcode, name: c.name }, geometry: c.feature.geometry });
  countyN++;
}
console.log(`  省直辖县级单位: ${countyN} 个（${pendingCounty.length} 个县级候选中分拣）`);

// 南海诸岛（装饰性）
const nanhai = national.features.find((f) => String(f.properties.adcode) === '100000_JD');
if (nanhai) {
  units.push({
    adcode: '100000_JD', name: '南海诸岛', shortName: '南海诸岛', province: '海南省', provinceAdcode: '460000',
    center: nanhai.properties.center || [112, 16], neighbors: [], decorative: true,
  });
  features.push({ type: 'Feature', properties: { adcode: '100000_JD', name: '南海诸岛' }, geometry: nanhai.geometry });
  console.log('  [装饰] 南海诸岛');
}

// ---------- 邻接关系（仅真实单位；bbox 预过滤 + turf 相交检测） ----------
console.log('[4/5] 计算邻接关系（BFS 扩张用）...');
const bboxes = features.map(bboxOf);
for (let i = 0; i < units.length; i++) {
  if (units[i].decorative) continue;
  for (let j = i + 1; j < units.length; j++) {
    if (units[j].decorative) continue;
    const a = bboxes[i];
    const b = bboxes[j];
    if (a[0] > b[2] || b[0] > a[2] || a[1] > b[3] || b[1] > a[3]) continue;
    if (booleanIntersects(features[i], features[j])) {
      units[i].neighbors.push(units[j].adcode);
      units[j].neighbors.push(units[i].adcode);
    }
  }
}

// ---------- 几何简化（可选，小面跳过 + 退化回退） ----------
const useSimplify = !process.argv.includes('--no-simplify');
const toleranceArg = process.argv.find((a) => a.startsWith('--tolerance='));
const tolerance = toleranceArg ? Number(toleranceArg.split('=')[1]) : 0.003;
if (useSimplify) {
  console.log(`[简化] tolerance=${tolerance}（跨度 < 0.2° 的面跳过）`);
  for (const f of features) {
    f.geometry = safeSimplify(f, tolerance).geometry;
  }
}

// ---------- 省界图层（粗线显示用） ----------
console.log('[5/5] 生成省界图层...');
const provFeatures = [];
for (const [adcode, pname] of PROVINCES) {
  const feat = nationalByAdcode.get(adcode);
  if (!feat) {
    console.warn(`  ⚠ 省界缺失: ${pname}`);
    continue;
  }
  provFeatures.push({ type: 'Feature', properties: { adcode, name: pname }, geometry: safeSimplify(feat, tolerance).geometry });
}
if (nanhai) {
  provFeatures.push({ type: 'Feature', properties: { adcode: '100000_JD', name: '南海诸岛' }, geometry: safeSimplify(nanhai, tolerance).geometry });
}
console.log(`  省界: ${provFeatures.length} 个 feature`);

// ---------- 输出 ----------
fs.mkdirSync(OUT_DIR, { recursive: true });
const provinces = PROVINCES.map(([adcode, name]) => {
  const feat = nationalByAdcode.get(adcode);
  return { adcode, name, center: (feat && (feat.properties.center || feat.properties.centroid)) || [104.5, 35] };
});
fs.writeFileSync(path.join(OUT_DIR, 'units.json'), JSON.stringify({ units, provinces }));
fs.writeFileSync(path.join(OUT_DIR, 'china_units.geojson'), JSON.stringify({ type: 'FeatureCollection', features }));
fs.writeFileSync(path.join(OUT_DIR, 'china_provinces.geojson'), JSON.stringify({ type: 'FeatureCollection', features: provFeatures }));

// 校验报告
const realUnits = units.filter((u) => !u.decorative);
const noNeighbor = realUnits.filter((u) => u.neighbors.length === 0);
const byShort = new Map();
for (const u of realUnits) {
  if (byShort.has(u.shortName)) console.warn(`  ⚠ 简写冲突: ${byShort.get(u.shortName)} 与 ${u.name} 同为「${u.shortName}」`);
  else byShort.set(u.shortName, u.name);
}
const size = fs.statSync(path.join(OUT_DIR, 'china_units.geojson')).size;
const provSize = fs.statSync(path.join(OUT_DIR, 'china_provinces.geojson')).size;
console.log(`\n完成：${realUnits.length} 个记忆单位 + ${units.length - realUnits.length} 个装饰面（省直辖县级 + 南海诸岛）`);
console.log(`无邻接（岛屿/飞地，BFS 将回退最近单位）：${noNeighbor.map((u) => u.name).join('、') || '无'}`);
console.log(`china_units.geojson: ${(size / 1024 / 1024).toFixed(2)} MB | china_provinces.geojson: ${(provSize / 1024 / 1024).toFixed(2)} MB`);
