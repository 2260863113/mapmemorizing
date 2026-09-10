// 数据校验：逐个检查每个 feature 的几何有效性（空坐标/退化/bbox 异常/覆盖完整性）
// 用法：node scripts/check-data.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { feature } from 'topojson-client';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'public', 'data');

function load(name) {
  return JSON.parse(fs.readFileSync(path.join(DATA, name), 'utf8'));
}

function geoStats(geometry) {
  if (!geometry || !geometry.coordinates) return { ok: false, reason: '无坐标' };
  let rings = 0;
  let points = 0;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let badRing = 0;
  const walkRing = (coords) => {
    rings++;
    if (!Array.isArray(coords) || coords.length < 4) badRing++;
    for (let i = 0; i < coords.length; i++) {
      const c = coords[i];
      if (!Array.isArray(c) || typeof c[0] !== 'number' || typeof c[1] !== 'number') {
        badRing++;
        return;
      }
      points++;
      if (c[0] < minX) minX = c[0];
      if (c[0] > maxX) maxX = c[0];
      if (c[1] < minY) minY = c[1];
      if (c[1] > maxY) maxY = c[1];
    }
  };
  const walk = (coords) => {
    if (!Array.isArray(coords)) return;
    if (Array.isArray(coords[0]) && typeof coords[0][0] === 'number') walkRing(coords);
    else for (const c of coords) walk(c);
  };
  walk(geometry.coordinates);
  const w = maxX - minX;
  const h = maxY - minY;
  if (!isFinite(w) || w < 1e-9 || h < 1e-9) return { ok: false, reason: '零面积', rings, points };
  return { ok: true, rings, points, w, h, minX, minY, maxX, maxY };
}

const meta = load('units.json');
// 地级 fine 档 TopoJSON → GeoJSON + 装饰面（与运行时 data.ts 同法）
const fineTopo = load('china_units.json');
const fineGeo = feature(fineTopo, fineTopo.objects.china);
const decoGeo = load('china_decorative.geojson');
const geo = { type: 'FeatureCollection', features: [...fineGeo.features, ...(decoGeo.features ?? [])] };
const provGeo = fs.existsSync(path.join(DATA, 'china_provinces.geojson')) ? load('china_provinces.geojson') : null;
const rawTopo = fs.existsSync(path.join(DATA, 'china_units_raw.json')) ? load('china_units_raw.json') : null;
const hkmacGeo = fs.existsSync(path.join(DATA, 'hkmac.geojson')) ? load('hkmac.geojson') : null;
const provRawTopo = fs.existsSync(path.join(DATA, 'china_provinces_raw.json')) ? load('china_provinces_raw.json') : null;

const byAdcode = new Map(meta.units.map((u) => [u.adcode, u]));
const problems = [];

console.log('=== 单位覆盖检查 ===');
const geoAdcodes = new Set(geo.features.map((f) => String(f.properties.adcode)));
for (const u of meta.units) {
  if (!geoAdcodes.has(u.adcode)) problems.push(`缺少几何: ${u.name} (${u.adcode})`);
}
for (const f of geo.features) {
  const adcode = String(f.properties.adcode);
  if (!byAdcode.has(adcode)) problems.push(`GeoJSON 多余 feature: ${f.properties.name} (${adcode})`);
}
console.log(`units.json: ${meta.units.length} 个 | geojson features: ${geo.features.length} | 匹配: ${[...geoAdcodes].filter((a) => byAdcode.has(a)).length}`);

console.log('\n=== 几何有效性检查（逐个） ===');
let bad = 0;
for (const f of geo.features) {
  const st = geoStats(f.geometry);
  if (!st.ok) {
    bad++;
    problems.push(`几何无效: ${f.properties.name} (${f.properties.adcode}) - ${st.reason}`);
  }
}
console.log(`无效几何: ${bad} 个`);

console.log('\n=== 极小区域（可能简化过度，重点怀疑对象） ===');
const tiny = [];
for (const f of geo.features) {
  const st = geoStats(f.geometry);
  if (st.ok && Math.min(st.w, st.h) < 0.05) tiny.push(`${f.properties.name} (${f.properties.adcode}) ${st.w.toFixed(4)}x${st.h.toFixed(4)}° rings=${st.rings}`);
}
console.log(tiny.length ? tiny.join('\n') : '无');

console.log('\n=== 省份覆盖 ===');
const byProv = new Map();
for (const u of meta.units) {
  if (u.decorative) continue;
  const list = byProv.get(u.province) ?? [];
  list.push(u.name);
  byProv.set(u.province, list);
}
for (const [p, list] of byProv) console.log(`${p}: ${list.join('、')}`);

console.log('\n=== 省界文件 ===');
if (provGeo) {
  console.log(`china_provinces.geojson: ${provGeo.features.length} 个 feature`);
  let pbad = 0;
  for (const f of provGeo.features) {
    const st = geoStats(f.geometry);
    if (!st.ok) {
      pbad++;
      problems.push(`省界几何无效: ${f.properties.name} - ${st.reason}`);
    }
  }
  console.log(`无效省界: ${pbad}`);
} else {
  console.log('（尚未生成）');
}

console.log('\n=== 无压缩 raw 档 ===');
if (rawTopo && rawTopo.objects?.china) {
  const rawGeo = feature(rawTopo, rawTopo.objects.china);
  console.log(`china_units_raw.json: ${rawGeo.features.length} 个 feature`);
  let rbad = 0;
  for (const f of rawGeo.features) {
    const st = geoStats(f.geometry);
    if (!st.ok) { rbad++; problems.push(`raw 几何无效: ${f.properties.name} (${f.properties.adcode}) - ${st.reason}`); }
  }
  console.log(`无效 raw 几何: ${rbad}`);
} else {
  problems.push('缺失 china_units_raw.json 或 objects.china');
}

console.log('\n=== 省级无损档 ===');
if (provRawTopo && provRawTopo.objects?.china) {
  const provRawGeo = feature(provRawTopo, provRawTopo.objects.china);
  console.log(`china_provinces_raw.json: ${provRawGeo.features.length} 个 feature`);
  const adcodes = new Set(provRawGeo.features.map((f) => String(f.properties.adcode)));
  if (adcodes.size !== provRawGeo.features.length) problems.push('省级无损档 adcode 有重复');
  let prbad = 0;
  for (const f of provRawGeo.features) {
    const st = geoStats(f.geometry);
    if (!st.ok) { prbad++; problems.push(`省级无损几何无效: ${f.properties.name} (${f.properties.adcode}) - ${st.reason}`); }
  }
  console.log(`无效省级无损几何: ${prbad}`);
} else {
  problems.push('缺失 china_provinces_raw.json 或 objects.china');
}

console.log('\n=== 港澳放大框无压缩面 ===');
if (hkmacGeo && hkmacGeo.features) {
  const adcodes = hkmacGeo.features.map((f) => String(f.properties.adcode)).sort();
  console.log(`hkmac.geojson: ${hkmacGeo.features.length} 个 feature，adcodes=[${adcodes.join(', ')}]`);
  if (!['440000', '810000', '820000'].every((a) => adcodes.includes(a))) {
    problems.push(`港澳放大框缺面: 需要 440000/810000/820000，实际 [${adcodes.join(', ')}]`);
  }
  let hbad = 0;
  for (const f of hkmacGeo.features) {
    const st = geoStats(f.geometry);
    if (!st.ok) { hbad++; problems.push(`港澳放大框几何无效: ${f.properties.name} (${f.properties.adcode}) - ${st.reason}`); }
  }
  console.log(`无效港澳放大框几何: ${hbad}`);
} else {
  problems.push('缺失 hkmac.geojson');
}

console.log('\n=== 问题汇总 ===');
console.log(problems.length ? problems.join('\n') : '无问题 ✅');
