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

console.log('\n=== 地级无损档（zoom ≥ 14，100% 顶点；靠视口裁剪保证流畅） ===');
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
// === 相邻单位共享顶点（缝隙）检查 ===
// 独立于 scripts/fetch-cn-atlas.mjs 的闸门：直接对**已构建产物**逐档复检，防缝隙回归。
// 历史：装饰面曾单独成文件、不共享顶点 → 全国 42 对相邻 100% 有缝，此检查即为防其回归。
//
// 判据只依赖 units.json 的 neighbors 字段（由管线用 fine 档几何 booleanIntersects 生成），
// **不做任何几何距离/容差判断**。原因：任何「多近才算相邻」的阈值都必然误报 ——
// 实测把「零共享」与「有共享」两组按近邻顶点数或贴合长度排序，两组分布都重叠，找不到干净阈值。
// 典型误报：凉山彝族自治州(513400)↔曲靖市(530300)（几何最近 0.645km，但 cn-atlas 源拓扑里
// 共享 0 条 arc，units.json 里也互不为邻居）、三亚市(460200)↔五指山市(469001)（同理）。
// 而 neighbors 是**结构性**事实，无歧义。
{
  const tierFiles = [['fine', 'china_units.json'], ['coarse', 'china_units_coarse.json'],
    ['ultra', 'china_units_ultra.json'], ['lossless', 'china_units_lossless.json']];
  const meta = load('units.json');
  const byAd = new Map((meta.units ?? []).map((u) => [String(u.adcode), u]));

  for (const [label, name] of tierFiles) {
    if (!fs.existsSync(path.join(DATA, name))) { problems.push('缺失 ' + name); continue; }
    const topo = load(name);
    if (!topo.objects?.china) { problems.push(name + ' 缺 objects.china'); continue; }
    const fc = feature(topo, topo.objects.china);
    const ptSet = new Map();
    for (const f of fc.features ?? []) {
      const ad = String(f.properties.adcode);
      let s = ptSet.get(ad);
      if (!s) { s = new Set(); ptSet.set(ad, s); }
      const walk = (c) => {
        if (!Array.isArray(c)) return;
        if (Array.isArray(c[0]) && typeof c[0][0] === 'number') { for (const p of c) s.add(p[0].toFixed(6) + ',' + p[1].toFixed(6)); return; }
        for (const cc of c) walk(cc);
      };
      walk(f.geometry.coordinates);
    }
    let pairs = 0, zero = 0; const list = [];
    for (const [ad, u] of byAd) {
      const A = ptSet.get(ad);
      if (!A) continue;
      for (const nb of u.neighbors ?? []) {
        const bd = String(nb);
        if (ad >= bd) continue; // 每对只查一次
        const B = ptSet.get(bd);
        if (!B) continue;
        pairs++;
        let shared = false;
        for (const p of A) if (B.has(p)) { shared = true; break; }
        if (!shared) { zero++; list.push(u.name + '(' + ad + ') ↔ ' + (byAd.get(bd)?.name ?? bd) + '(' + bd + ')'); }
      }
    }
    const ok = zero === 0;
    console.log('  ' + label.padEnd(22) + ' 邻接对 ' + String(pairs).padStart(4) + ' 个，零共享 ' + zero + ' ' + (ok ? '✅' : '❌'));
    if (!ok) { problems.push(label + ' 有 ' + zero + ' 对相邻单位零共享顶点（可见缝隙）'); console.log('     ' + list.slice(0, 6).join('\n     ')); }
  }
}

console.log('\n=== 空洞检查（多边形内环是否被相邻面填满）===');
// 背景：cn-atlas 的 prefectures 里，地级面在县级/兵团市处**留有内环**（洞），
// 由对应的县级面填入。若我们漏掉某个县级面，洞就无人填 → 地级视图露白
// （2026-09 实测：漏了白杨市 659012 / 新星市 659011 → 塔城西侧 1147km²、哈密 561km² 空白）。
// 另一类洞来自 `-clean` 缝合：它把相邻面重叠部分判给一方、给对方留洞，
// 实测一次造出 79 个新洞且全部无人填（沿海 9 市各被咬掉一块）—— 该步骤已废弃。
// 本检查即防这两类回归：**任何一个内环，都必须被别的面盖住**。
{
  const CELL = 0.004; // ≈440m
  const polysOf = (g) => (!g ? [] : g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : []);
  const holesOfGeom = (g) => { const o = []; for (const poly of polysOf(g)) for (let i = 1; i < poly.length; i++) o.push(poly[i]); return o; };
  const ringAreaKm2 = (c) => {
    const R = 6378.137, rad = (d) => (d * Math.PI) / 180;
    let t = 0;
    for (let i = 0; i < c.length; i++) {
      const p1 = c[i], p2 = c[(i + 1) % c.length];
      t += rad(p2[0] - p1[0]) * (2 + Math.sin(rad(p1[1])) + Math.sin(rad(p2[1])));
    }
    return Math.abs((t * R * R) / 2);
  };
  /** 在给定小 bbox 内栅格化几何 */
  const rasterIn = (g, bbox, W, H) => {
    const m = new Uint8Array(W * H);
    for (const poly of polysOf(g)) {
      for (let ri = 0; ri < poly.length; ri++) {
        const r = poly[ri];
        let minY = Infinity, maxY = -Infinity;
        for (const p of r) { if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1]; }
        if (maxY < bbox[1] || minY > bbox[3]) continue;
        const gy0 = Math.max(0, Math.floor((minY - bbox[1]) / CELL)), gy1 = Math.min(H - 1, Math.ceil((maxY - bbox[1]) / CELL));
        for (let gy = gy0; gy <= gy1; gy++) {
          const yc = bbox[1] + (gy + 0.5) * CELL; const xs = [];
          for (let i = 0; i < r.length; i++) {
            const a = r[i], b = r[(i + 1) % r.length];
            if ((a[1] > yc) !== (b[1] > yc)) xs.push(a[0] + ((yc - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
          }
          if (xs.length < 2) continue; xs.sort((p, q) => p - q);
          for (let k = 0; k + 1 < xs.length; k += 2) {
            const gx0 = Math.max(0, Math.floor((xs[k] - bbox[0]) / CELL)), gx1 = Math.min(W - 1, Math.ceil((xs[k + 1] - bbox[0]) / CELL));
            for (let gx = gx0; gx <= gx1; gx++) m[gy * W + gx] = 1;
          }
        }
      }
    }
    return m;
  };
  for (const [label, file] of [['fine', 'china_units.json'], ['coarse', 'china_units_coarse.json'], ['ultra', 'china_units_ultra.json'], ['lossless', 'china_units_lossless.json']]) {
    const topo = load(file);
    const obj = topo?.objects?.china;
    if (!obj) continue;
    const gj = feature(topo, obj);
    const feats = gj.features ?? [];
    let holeCount = 0; const unfilled = [];
    for (const f of feats) {
      for (const h of holesOfGeom(f.geometry)) {
        holeCount++;
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const p of h) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; }
        const pad = 0.01;
        const bbox = [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
        const W = Math.max(2, Math.ceil((bbox[2] - bbox[0]) / CELL)), H = Math.max(2, Math.ceil((bbox[3] - bbox[1]) / CELL));
        if (W * H > 3e7) continue; // 超大洞跳过（避免内存爆）
        const hm = rasterIn({ type: 'Polygon', coordinates: [h] }, bbox, W, H);
        const om = new Uint8Array(W * H);
        for (const o of feats) {
          if (String(o.properties.adcode) === String(f.properties.adcode)) continue;
          const omi = rasterIn(o.geometry, bbox, W, H);
          for (let i = 0; i < om.length; i++) if (omi[i]) om[i] = 1;
        }
        let hn = 0, unc = 0;
        for (let i = 0; i < hm.length; i++) { if (!hm[i]) continue; hn++; if (!om[i]) unc++; }
        if (hn > 0 && unc / hn > 0.05) {
          const kk = (CELL * 111.32) * (CELL * 111.32 * Math.cos((((y0 + y1) / 2) * Math.PI) / 180));
          unfilled.push(`${f.properties.name}(${f.properties.adcode}) 洞 ${ringAreaKm2(h).toFixed(0)}km² 中 ${(unc * kk).toFixed(0)}km² 无面覆盖 @ ${((x0 + x1) / 2).toFixed(3)},${((y0 + y1) / 2).toFixed(3)}`);
        }
      }
    }
    const ok = unfilled.length === 0;
    console.log(`  ${label.padEnd(22)} 内环 ${String(holeCount).padStart(3)} 个，无人填 ${unfilled.length} ${ok ? '✅' : '❌'}`);
    if (!ok) { problems.push(`${label} 有 ${unfilled.length} 个空洞无人覆盖（露白）`); console.log('     ' + unfilled.slice(0, 6).join('\n     ')); }
  }
}

console.log('\n=== 问题汇总 ===');
console.log(problems.length ? problems.join('\n') : '无问题 ✅');