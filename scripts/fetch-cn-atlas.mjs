// 数据管线：从 cn-atlas（shengshixian.com 2023 拓扑干净的行政区划，TopoJSON）生成中国地图数据。
// 产出三档简化 TopoJSON（fine 15% / coarse 8% / ultra 4%，拓扑保持无缝隙）+ 无压缩 raw 档（zoom ≥ 10）
// + 港澳放大框无压缩面 + 装饰面 GeoJSON + 元数据表。
//
// 背景（grill-rounds.log 2026-09-09 换源）：阿里 DataV 逐面数字化导致相邻边 32.7% 零共享 → 缝隙；
// cn-atlas 用共享弧（TopoJSON），相邻边 0.1% 零共享，且 adcode 与现有 units.json 对齐 370/371。
//
// 分层：
//   - 340 个真实地级单位（+南海诸岛）来自 cn-atlas，进 mapshaper 拓扑简化，产出 fine/coarse 两档 TopoJSON
//   - 30 个省直辖县级/兵团城市装饰面（cn-atlas 无地级粒度）+ 南海诸岛，来自现有 DataV，单独保留为 GeoJSON
//     装饰面不参与拓扑简化/邻接，渲染时拼接（它们周边可能有局部缝，可接受）
//
// 用法：node scripts/fetch-cn-atlas.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { feature } from 'topojson-client';
import { booleanIntersects } from '@turf/boolean-intersects';
import mapshaper from 'mapshaper';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'public', 'data');
const SRC_URL = 'https://unpkg.com/cn-atlas/cn-atlas.json';
const SOURCE_NOTE = 'https://github.com/BarbarossaWang/cn-atlas (shengshixian.com 2023 shp → mapshaper 简化 → TopoJSON；台湾/港澳整体单位、南海诸岛与县级装饰面保留自 DataV)。';
const TMP = path.join(ROOT, '.cnatlas-tmp');
const NANHAI_ADCODE = '100000_JD';

const { runCommands } = mapshaper;

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'cn-atlas-builder/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return await res.json();
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

function pointInRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function pointInPolygon(p, polygons) {
  for (const poly of polygons) {
    if (!pointInRing(p, poly[0])) continue;
    if (poly.slice(1).every((hole) => !pointInRing(p, hole))) return true;
  }
  return false;
}

function ringsOfGeometry(g) {
  if (g.type === 'Polygon') return [g.coordinates];
  if (g.type === 'MultiPolygon') return g.coordinates;
  return [];
}

/**
 * 把 explode 产生的同 adcode 多个 TopoJSON geometry 合并回单个 MultiPolygon geometry。
 * ECharts parseGeoJson 对每个 feature 建一个 region 且不合并同名 feature，
 * 因此必须先按 adcode 合并，否则同一地级市只有一块面被着色/命中。
 */
function mergeGeometriesByAdcode(obj) {
  const byAd = new Map();
  for (const g of obj.geometries ?? []) {
    const ad = String(g.properties?.adcode ?? g.id);
    if (!byAd.has(ad)) {
      byAd.set(ad, { type: 'MultiPolygon', arcs: [], id: g.id, properties: g.properties });
    }
    const tgt = byAd.get(ad);
    if (g.type === 'Polygon') tgt.arcs.push(g.arcs);
    else if (g.type === 'MultiPolygon') tgt.arcs.push(...g.arcs);
  }
  const geometries = [...byAd.values()].map((g) => (g.arcs.length === 1 ? { ...g, type: 'Polygon', arcs: g.arcs[0] } : g));
  return { type: 'GeometryCollection', geometries };
}

/** 相邻单位共享顶点统计（缝隙闸门：真实相邻单位必须共享 ≥1 顶点）。 */
function mergeFeaturesByAdcode(geojson) {
  const byAd = new Map();
  const order = [];
  for (const f of geojson.features ?? []) {
    const ad = String(f.properties?.adcode ?? f.properties?.id ?? '');
    if (!byAd.has(ad)) { byAd.set(ad, { type: 'Feature', properties: f.properties, geometry: { type: 'MultiPolygon', coordinates: [] } }); order.push(ad); }
    const tgt = byAd.get(ad);
    if (f.geometry.type === 'Polygon') tgt.geometry.coordinates.push(f.geometry.coordinates);
    else if (f.geometry.type === 'MultiPolygon') tgt.geometry.coordinates.push(...f.geometry.coordinates);
  }
  const features = order.map((ad) => {
    const f = byAd.get(ad);
    if (f.geometry.coordinates.length === 1) return { ...f, geometry: { type: 'Polygon', coordinates: f.geometry.coordinates[0] } };
    return f;
  });
  return { type: 'FeatureCollection', features };
}

function sharedVertexStats(geojson, units) {
  const feats = new Map(geojson.features.map((f) => [String(f.properties.adcode), f]));
  const pset = (f) => {
    const s = new Set();
    const walk = (c) => {
      if (!Array.isArray(c)) return;
      if (Array.isArray(c[0]) && typeof c[0][0] === 'number') {
        for (const [x, y] of c) s.add(x.toFixed(6) + ',' + y.toFixed(6));
        return;
      }
      for (const cc of c) walk(cc);
    };
    walk(f.geometry.coordinates);
    return s;
  };
  let pairs = 0; let zero = 0; const zeroList = [];
  const cache = new Map();
  const getSet = (ad) => {
    if (!cache.has(ad)) {
      const f = feats.get(ad);
      cache.set(ad, f ? pset(f) : null);
    }
    return cache.get(ad);
  };
  for (const u of units) {
    if (u.decorative) continue;
    const pa = getSet(u.adcode);
    if (!pa) continue;
    for (const nb of u.neighbors) {
      const pb = getSet(nb);
      if (!pb) continue;
      pairs++;
      let s = 0;
      for (const p of pa) if (pb.has(p)) { s = 1; break; }
      if (!s) { zero++; zeroList.push(`${u.name}<->${units.find((x) => x.adcode === nb)?.name ?? nb}`); }
    }
  }
  return { pairs, zero, zeroList };
}

function centerOf(feature) {
  const polys = ringsOfGeometry(feature.geometry);
  let best = null; let bestArea = -1;
  for (const poly of polys) {
    const outer = poly[0];
    let a2 = 0, cx = 0, cy = 0;
    for (let i = 0; i < outer.length; i++) {
      const [x0, y0] = outer[i];
      const [x1, y1] = outer[(i + 1) % outer.length];
      const cross = x0 * y1 - x1 * y0;
      a2 += cross; cx += (x0 + x1) * cross; cy += (y0 + y1) * cross;
    }
    const area = Math.abs(a2) / 2;
    if (area > bestArea) { bestArea = area; best = [cx / (3 * a2), cy / (3 * a2)]; }
  }
  if (!best) return [104.5, 35];
  if (pointInPolygon(best, polys)) return best;
  const [minX, minY, maxX, maxY] = bboxOf(feature);
  const c = [(minX + maxX) / 2, (minY + maxY) / 2];
  if (pointInPolygon(c, polys)) return c;
  for (const poly of polys) for (const p of poly[0]) if (pointInPolygon(p, polys)) return p;
  return best;
}

async function run() {
  fs.mkdirSync(TMP, { recursive: true });
  console.log('[1/6] 下载 cn-atlas TopoJSON ...');
  const topo = await fetchJson(SRC_URL);
  console.log(`  objects: ${Object.keys(topo.objects).join(', ')} | arcs=${topo.arcs.length}`);

  console.log('[2/6] 对齐现有 units 口径 ...');
  const meta = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'units.json'), 'utf8'));
  const allUnits = meta.units;
  const realUnits = allUnits.filter((u) => !u.decorative); // 340 真实地级
  const decoUnits = allUnits.filter((u) => u.decorative); // 31 装饰（含南海）

  // 装饰面源（构建期输入，已提交）：30 个省直辖县级/兵团城市 + 南海诸岛（cn-atlas 无此粒度）
  const decoSrc = JSON.parse(fs.readFileSync(path.join(ROOT, 'data-src', 'datav-decorative.geojson'), 'utf8'));
  const decoByAdcode = new Map(decoSrc.features.map((f) => [String(f.properties.adcode), f]));

  // cn-atlas prefectures/provinces → GeoJSON
  const prefs = feature(topo, topo.objects.prefectures);
  const prefsById = new Map(prefs.features.map((f) => [String(f.properties.id), f]));
  const provs = feature(topo, topo.objects.provinces);
  const provsById = new Map(provs.features.map((f) => [String(f.properties.id), f]));

  // 真实单位几何：cn-atlas（按白名单）+ 南海诸岛（cn-atlas 无，从现有取）
  const coreFeatures = [];
  let hit = 0; const miss = [];
  for (const u of realUnits) {
    const f = prefsById.get(u.adcode);
    if (!f) { miss.push(u.adcode); continue; }
    hit++;
    coreFeatures.push({ type: 'Feature', properties: { adcode: u.adcode, name: u.name }, geometry: f.geometry });
  }
  console.log(`  真实单位命中: ${hit}/${realUnits.length}${miss.length ? ' 缺:' + miss.join(',') : ''}`);
  // 南海诸岛（装饰但属于核心拓扑组，单独加进 core，让 mapshaper 一并拓扑化以贴近周边）
  const nanhai = decoByAdcode.get(NANHAI_ADCODE);
  if (!nanhai) { console.error('⚠ 装饰面源缺南海诸岛 (data-src/datav-decorative.geojson)'); process.exit(1); }
  coreFeatures.push({ type: 'Feature', properties: { adcode: NANHAI_ADCODE, name: '南海诸岛' }, geometry: nanhai.geometry });

  console.log('[3/6] 拓扑保持简化出 fine/coarse/ultra 三档 ...');
  const baseGeoJson = { type: 'FeatureCollection', features: coreFeatures };
  const coreGjFile = path.join(TMP, 'china-core.geojson');
  fs.writeFileSync(coreGjFile, JSON.stringify(baseGeoJson));

  // 关键：先 -explode 把 MultiPolygon 拆成独立 Polygon 再简化。
  // 原因：mapshaper 的 keep-shapes 只保证「整个 feature 不消失」，不保护 MultiPolygon 内部的孤立小环
  // （实测淮北 340600 有个 39.68km² 飞地小环，在 8%/4% 简化下被删除 → 拓扑改写 → 与徐州 320300 的共享弧被拆开
  //   → 0.135° 可见缝隙）。explode 后每个小环都是独立 feature，受 keep-shapes 保护，简化后零共享恢复到 0。
  const explodedFile = path.join(TMP, 'china-core-exploded.geojson');
  await runCommands(`-i ${coreGjFile} -explode -o format=geojson ${explodedFile}`);

  const tiers = [['fine', 15], ['coarse', 8], ['ultra', 4]];
  const tierTopos = {};
  for (const [name, pct] of tiers) {
    const outFile = path.join(TMP, `china-${name}.json`);
    await runCommands(`-i ${explodedFile} -simplify visvalingam keep-shapes ${pct}% -o format=topojson ${outFile}`);
    const t = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    // explode 产生的同 adcode 多 feature 需按 adcode 合并回 MultiPolygon：
    // ECharts parseGeoJson 按 feature 逐个建 region（不合并同名），不合并会导致同一地级市只有一块被着色。
    const objName = Object.keys(t.objects)[0];
    t.objects.china = mergeGeometriesByAdcode(t.objects[objName]);
    delete t.objects[objName];
    tierTopos[name] = t;
    console.log(`  ${name}(${pct}%): arcs=${t.arcs.length} 合并后 features=${t.objects.china.geometries.length}`);
  }

  // raw 档：无压缩（zoom ≥ 10 用），保留 cn-atlas 原始几何，不 simplify。
  // 体积约 1.3MB，运行期**异步加载**（首屏用 fine 15% 渲染，后台拉 raw，放大到 ≥10 时切换）。
  // 未 explode：core 里每 adcode 恰一个 feature（无 MultiPolygon 拆分），故无需按 adcode 合并。
  {
    const rawOutFile = path.join(TMP, 'china-raw.json');
    await runCommands(`-i ${coreGjFile} -o format=topojson ${rawOutFile}`);
    const rawTopo = JSON.parse(fs.readFileSync(rawOutFile, 'utf8'));
    const rawObjName = Object.keys(rawTopo.objects)[0];
    rawTopo.objects.china = rawTopo.objects[rawObjName];
    delete rawTopo.objects[rawObjName];
    tierTopos.raw = rawTopo;
    console.log(`  raw(无压缩): arcs=${rawTopo.arcs.length} features=${rawTopo.objects.china.geometries.length}`);
  }

  console.log('[4/6] 装饰面单独保存 + 省级地图（cn-atlas provinces）...');
  const decoFeatures = decoUnits
    .filter((u) => u.adcode !== NANHAI_ADCODE) // 南海已进 core
    .map((u) => {
      const f = decoByAdcode.get(u.adcode);
      return f ? { type: 'Feature', properties: { adcode: u.adcode, name: u.name }, geometry: f.geometry } : null;
    })
    .filter(Boolean);
  const decoGeoJson = { type: 'FeatureCollection', features: decoFeatures, _source: 'DataV decorative counties (not in cn-atlas prefecture level)' };
  console.log(`  装饰面: ${decoFeatures.length} 个`);

  // 省级地图：cn-atlas provinces（34 面）+ 南海装饰面，字段映射 adcode/name(中文)
  const provFeatures = [];
  for (const p of meta.provinces) {
    const f = provsById.get(p.adcode);
    if (!f) { console.warn(`  ⚠ 省级缺 ${p.adcode} ${p.name}`); continue; }
    provFeatures.push({ type: 'Feature', properties: { adcode: p.adcode, name: p.name }, geometry: f.geometry });
  }
  provFeatures.push({ type: 'Feature', properties: { adcode: NANHAI_ADCODE, name: '南海诸岛' }, geometry: nanhai.geometry });
  const provGeoJsonRaw = { type: 'FeatureCollection', features: provFeatures };

  // 港澳放大框：始终用**无压缩原始**几何（不简化），从省级原始几何抽取 广东(440000) + 香港(810000) + 澳门(820000)。
  // 三面合计仅 ~12KB，运行期同步加载即可。
  const hkmacFeatures = provFeatures.filter((f) => ['440000', '810000', '820000'].includes(String(f.properties.adcode)));
  const hkmacGeoJson = { type: 'FeatureCollection', features: hkmacFeatures };
  console.log(`  港澳放大框无压缩面: ${hkmacFeatures.length} 个`);

  // 省级也拓扑保持简化（省界粗线每帧重绘，简化以减重），两档：
  //   fine 15%（省级地图视图 / zoom ≥ 5）、coarse 4%（地级视图下的省界粗线，zoom < 5）
  // 同地级：先 -explode 保护 MultiPolygon 内部小环（如沿海岛屿），简化后按 adcode 合并回来。
  const provGjFile = path.join(TMP, 'china-provinces.geojson');
  fs.writeFileSync(provGjFile, JSON.stringify(provGeoJsonRaw));
  const provExploded = path.join(TMP, 'china-provinces-exploded.geojson');
  await runCommands(`-i ${provGjFile} -explode -o format=geojson ${provExploded}`);
  const provTiers = [['fine', 15], ['coarse', 4]];
  const provGeoJsons = {};
  for (const [name, pct] of provTiers) {
    const outFile = path.join(TMP, `china-provinces-out-${name}.geojson`);
    await runCommands(`-i ${provExploded} -simplify visvalingam keep-shapes ${pct}% -o format=geojson ${outFile}`);
    provGeoJsons[name] = mergeFeaturesByAdcode(JSON.parse(fs.readFileSync(outFile, 'utf8')));
    console.log(`  省级面 ${name}(${pct}%): ${provGeoJsons[name].features.length} 个`);
  }

  console.log('[5/6] 用 fine 档几何重建中心点与邻接 ...');
  const fineTopo = tierTopos.fine;
  const fineGeo = feature(fineTopo, fineTopo.objects.china);
  const fineFeatures = fineGeo.features ?? [];
  const fineById = new Map(fineFeatures.map((f) => [String(f.properties.adcode), f]));

  for (const u of realUnits) {
    const f = fineById.get(u.adcode);
    if (f) u.center = centerOf(f);
  }

  for (const u of realUnits) u.neighbors = [];
  const bboxes = realUnits.map((u) => bboxOf(fineById.get(u.adcode) ?? nanhai));
  for (let i = 0; i < realUnits.length; i++) {
    for (let j = i + 1; j < realUnits.length; j++) {
      const a = bboxes[i], b = bboxes[j];
      if (a[0] > b[2] || b[0] > a[2] || a[1] > b[3] || b[1] > a[3]) continue;
      const fi = fineById.get(realUnits[i].adcode);
      const fj = fineById.get(realUnits[j].adcode);
      if (!fi || !fj) continue;
      if (booleanIntersects(fi, fj)) {
        realUnits[i].neighbors.push(realUnits[j].adcode);
        realUnits[j].neighbors.push(realUnits[i].adcode);
      }
    }
  }
  const noNeighbor = realUnits.filter((u) => u.neighbors.length === 0);
  console.log(`  无邻接（岛屿/飞地）: ${noNeighbor.map((u) => u.name).join('、') || '无'}`);

  console.log('[6/6] 缝隙闸门 + 输出 ...');
  // 闸门：每档展开成 GeoJSON 后，真实相邻单位必须共享 ≥1 顶点（零共享 = 可见缝隙）。
  // 历史教训：keep-shapes 不保护 MultiPolygon 内部小环，未 explode 时 coarse/ultra 档淮北 340600
  // 的飞地小环被删 → 与徐州 320300 产生 0.135° 缝隙，故此处作为硬性闸门。
  const tierStats = {};
  let gateFail = false;
  for (const [name, topo] of Object.entries(tierTopos)) {
    const gj = feature(topo, topo.objects.china);
    const st = sharedVertexStats(gj, allUnits);
    tierStats[name] = st;
    const ok = st.zero === 0;
    if (!ok) gateFail = true;
    console.log(`  ${name}: 相邻边 ${st.pairs} 对，零共享 ${st.zero} ${ok ? '✅' : '❌ ' + st.zeroList.slice(0, 5).join(', ')}`);
  }
  if (gateFail) {
    console.error('FAIL: 存在零共享相邻边（可见缝隙），拒绝输出。检查 -explode 是否生效。');
    process.exit(1);
  }

  fs.writeFileSync(path.join(OUT_DIR, 'china_units.json'), JSON.stringify({ ...tierTopos.fine, _source: SOURCE_NOTE }));
  fs.writeFileSync(path.join(OUT_DIR, 'china_units_coarse.json'), JSON.stringify({ ...tierTopos.coarse, _source: SOURCE_NOTE }));
  fs.writeFileSync(path.join(OUT_DIR, 'china_units_ultra.json'), JSON.stringify({ ...tierTopos.ultra, _source: SOURCE_NOTE }));
  fs.writeFileSync(path.join(OUT_DIR, 'china_units_raw.json'), JSON.stringify({ ...tierTopos.raw, _source: SOURCE_NOTE }));
  fs.writeFileSync(path.join(OUT_DIR, 'china_decorative.geojson'), JSON.stringify(decoGeoJson));
  fs.writeFileSync(path.join(OUT_DIR, 'china_provinces.geojson'), JSON.stringify(provGeoJsons.fine));
  fs.writeFileSync(path.join(OUT_DIR, 'china_provinces_coarse.geojson'), JSON.stringify(provGeoJsons.coarse));
  fs.writeFileSync(path.join(OUT_DIR, 'hkmac.geojson'), JSON.stringify(hkmacGeoJson));
  fs.writeFileSync(path.join(OUT_DIR, 'units.json'), JSON.stringify({ units: allUnits, provinces: meta.provinces }));
  for (const f of ['china_units.json', 'china_units_coarse.json', 'china_units_ultra.json', 'china_units_raw.json', 'china_decorative.geojson', 'china_provinces.geojson', 'china_provinces_coarse.geojson', 'hkmac.geojson']) {
    console.log(`  ${f}: ${(fs.statSync(path.join(OUT_DIR, f)).size / 1024).toFixed(0)}KB`);
  }
}

run().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
