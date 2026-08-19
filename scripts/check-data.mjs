// 数据校验：逐个检查每个 feature 的几何有效性（空坐标/退化/bbox 异常/覆盖完整性）
// 用法：node scripts/check-data.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
const geo = load('china_units.geojson');
const provGeo = fs.existsSync(path.join(DATA, 'china_provinces.geojson')) ? load('china_provinces.geojson') : null;

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

console.log('\n=== 问题汇总 ===');
console.log(problems.length ? problems.join('\n') : '无问题 ✅');
