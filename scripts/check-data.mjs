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
// 地级 fine 档 TopoJSON → GeoJSON。装饰面（省直辖县级/兵团城市）已并入该拓扑组，
// 不再有单独的 china_decorative.geojson（2026-09-09 缝合改造）。
const fineTopo = load('china_units.json');
const fineGeo = feature(fineTopo, fineTopo.objects.china);
const geo = { type: 'FeatureCollection', features: [...fineGeo.features] };
if (fs.existsSync(path.join(DATA, 'china_decorative.geojson'))) {
  problems.push('检测到已退役的 china_decorative.geojson（装饰面应已并入 china_units*.json），请删除');
}
const provGeo = fs.existsSync(path.join(DATA, 'china_provinces.geojson')) ? load('china_provinces.geojson') : null;
const losslessTopo = fs.existsSync(path.join(DATA, 'china_units_lossless.json')) ? load('china_units_lossless.json') : null;
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

console.log('\n=== 地级无损档（zoom ≥ 10，100% 顶点；靠视口裁剪保证流畅） ===');
if (losslessTopo && losslessTopo.objects?.china) {
  const losslessGeo = feature(losslessTopo, losslessTopo.objects.china);
  console.log(`china_units_lossless.json: ${losslessGeo.features.length} 个 feature`);
  let rbad = 0;
  for (const f of losslessGeo.features) {
    const st = geoStats(f.geometry);
    if (!st.ok) { rbad++; problems.push(`无损档几何无效: ${f.properties.name} (${f.properties.adcode}) - ${st.reason}`); }
  }
  console.log(`无效无损档几何: ${rbad}`);
} else {
  problems.push('缺失 china_units_lossless.json 或 objects.china');
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

console.log('\n=== 相邻单位共享顶点（缝隙）检查 ===');
// 独立于 scripts/fetch-cn-atlas.mjs 的闸门：这里直接对**已构建产物**逐档复检，
// 防止有人手工改数据 / 跑错脚本导致缝隙回归。
// 历史：装饰面曾单独成文件、不共享顶点 → 全国 42 对相邻 100% 有缝，此检查即为防其回归。
//
// 相邻判定必须是「沿边界相邻」，不能是「任意两顶点距离 ≤1km」：
// 后者会把**角点相接**误判为相邻。实例：三亚市(460200) 与 五指山市(469001) 并不接壤
// （中间隔着保亭/乐东，units.json 里二者互不为邻居），边界最小间距 1.10km，
// 但各有一个角点相距 0.57km → 旧判据报「相邻却零共享顶点」的假缝隙。
// 真实相邻（含数字化错开）会让**一整段**边界贴近，产生远多于 3 个近邻顶点；
// 角点相接只产生 1~2 个。故要求 ≥3 个顶点落在对方**边界**（点到线段，非点到点）1km 内。
{
  const CELL = 0.05;
  const TOL_KM = 1.0;
  const MIN_NEAR_PTS = 3;
  const kmPerDegLat = 111.32;
  const toPoints = (f) => {
    const out = [];
    const walk = (c) => {
      if (!Array.isArray(c)) return;
      if (Array.isArray(c[0]) && typeof c[0][0] === 'number') { for (const p of c) out.push(p); return; }
      for (const cc of c) walk(cc);
    };
    walk(f.geometry.coordinates);
    return out;
  };
  /** 点到线段的最近距离（km） */
  const ptSegKm = (p, a, b) => {
    const kx = kmPerDegLat * Math.cos((p[1] * Math.PI) / 180);
    const px = p[0] * kx, py = p[1] * kmPerDegLat;
    const ax = a[0] * kx, ay = a[1] * kmPerDegLat;
    const bx = b[0] * kx, by = b[1] * kmPerDegLat;
    const dx = bx - ax, dy = by - ay;
    const l2 = dx * dx + dy * dy;
    let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  };
  const checkTier = (label, fc) => {
    const items = fc.features.map((f) => {
      const pts = toPoints(f);
      const grid = new Map();
      for (const p of pts) {
        const k = `${Math.floor(p[0] / CELL)},${Math.floor(p[1] / CELL)}`;
        let arr = grid.get(k); if (!arr) { arr = []; grid.set(k, arr); }
        arr.push(p);
      }
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of pts) { if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0]; if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1]; }
      return { ad: String(f.properties.adcode), name: f.properties.name, pts, grid,
        set: new Set(pts.map((p) => p[0].toFixed(6) + ',' + p[1].toFixed(6))), bbox: [minX, minY, maxX, maxY],
        coords: f.geometry.coordinates, segGrid: null };
    });
    /** 惰性构建线段栅格 */
    const segGridOf = (it) => {
      if (it.segGrid) return it.segGrid;
      const g = new Map();
      const push = (seg, key) => { let a = g.get(key); if (!a) { a = []; g.set(key, a); } a.push(seg); };
      const walkRings = (c) => {
        if (!Array.isArray(c)) return;
        if (Array.isArray(c[0]) && typeof c[0][0] === 'number') {
          for (let i = 0; i < c.length; i++) {
            const a = c[i], b = c[(i + 1) % c.length];
            const x0 = Math.floor(Math.min(a[0], b[0]) / CELL), x1 = Math.floor(Math.max(a[0], b[0]) / CELL);
            const y0 = Math.floor(Math.min(a[1], b[1]) / CELL), y1 = Math.floor(Math.max(a[1], b[1]) / CELL);
            if ((x1 - x0 + 1) * (y1 - y0 + 1) > 20000) { push([a, b], 'ALL'); continue; }
            for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) push([a, b], `${x},${y}`);
          }
          return;
        }
        for (const cc of c) walkRings(cc);
      };
      walkRings(it.coords);
      it.segGrid = g;
      return g;
    };
    /** A 的顶点中落在 B 边界 TOL_KM 内的个数 */
    const countNear = (A, B) => {
      const g = segGridOf(B);
      let count = 0, minKm = Infinity;
      for (const p of A.pts) {
        const cx = Math.floor(p[0] / CELL), cy = Math.floor(p[1] / CELL);
        let best = Infinity;
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
          const arr = g.get(`${cx + dx},${cy + dy}`); if (!arr) continue;
          for (const [a, b] of arr) { const d = ptSegKm(p, a, b); if (d < best) best = d; }
        }
        const all = g.get('ALL');
        if (all) for (const [a, b] of all) { const d = ptSegKm(p, a, b); if (d < best) best = d; }
        if (best < minKm) minKm = best;
        if (best <= TOL_KM) count++;
      }
      return { count, minKm };
    };
    let pairs = 0, zero = 0; const list = [];
    for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
      const A = items[i], B = items[j];
      if (A.bbox[0] - 0.01 > B.bbox[2] || B.bbox[0] - 0.01 > A.bbox[2]) continue;
      if (A.bbox[1] - 0.01 > B.bbox[3] || B.bbox[1] - 0.01 > A.bbox[3]) continue;
      const fb = countNear(A, B), fa = countNear(B, A);
      const near = Math.max(fa.count, fb.count);
      if (near < MIN_NEAR_PTS) continue; // 不相邻（含仅角点相接）
      pairs++;
      let shared = 0;
      for (const p of A.pts) if (B.set.has(p[0].toFixed(6) + ',' + p[1].toFixed(6))) { shared++; break; }
      if (shared === 0) { zero++; list.push(`${A.name}(${A.ad}) ↔ ${B.name}(${B.ad}) ${Math.min(fa.minKm, fb.minKm).toFixed(3)}km 近邻顶点 ${near}`); }
    }
    const ok = zero === 0;
    console.log(`  ${label.padEnd(22)} 相邻 ${String(pairs).padStart(4)} 对，缝隙 ${zero} ${ok ? '✅' : '❌'}`);
    if (!ok) { problems.push(`${label} 存在 ${zero} 处相邻缝隙（可见裂缝）`); console.log('     ' + list.slice(0, 5).join('\n     ')); }
  };
  // 逐档检查全部地级产物（装饰面已在内）
  for (const [label, name] of [['fine', 'china_units.json'], ['coarse', 'china_units_coarse.json'],
    ['ultra', 'china_units_ultra.json'], ['lossless', 'china_units_lossless.json']]) {
    if (!fs.existsSync(path.join(DATA, name))) { problems.push(`缺失 ${name}`); continue; }
    const topo = load(name);
    if (!topo.objects?.china) { problems.push(`${name} 缺 objects.china`); continue; }
    const fc = feature(topo, topo.objects.china);
    checkTier(label, fc);
  }
}

console.log('\n=== 问题汇总 ===');
console.log(problems.length ? problems.join('\n') : '无问题 ✅');