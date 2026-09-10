// 数据管线：从 cn-atlas（shengshixian.com 2023 拓扑干净的行政区划，TopoJSON）生成中国地图数据。
// 产出双档 TopoJSON（fine 15% / coarse 8% 拓扑保持简化，无缝隙）+ 装饰面 GeoJSON + 元数据表。
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

  // 现有 GeoJSON：抽取装饰面几何（县级装饰 + 南海）
  const curGeo = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'china_units.geojson'), 'utf8'));
  const curByAdcode = new Map(curGeo.features.map((f) => [String(f.properties.adcode), f]));

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
  const nanhai = curByAdcode.get(NANHAI_ADCODE);
  if (!nanhai) { console.error('⚠ 现有数据缺南海诸岛'); process.exit(1); }
  coreFeatures.push({ type: 'Feature', properties: { adcode: NANHAI_ADCODE, name: '南海诸岛' }, geometry: nanhai.geometry });

  console.log('[3/6] 生成 base TopoJSON 并拓扑保持简化出 fine/coarse 两档 ...');
  const baseGeoJson = { type: 'FeatureCollection', features: coreFeatures };
  fs.writeFileSync(path.join(TMP, 'china-core.geojson'), JSON.stringify(baseGeoJson));
  const baseTopoFile = path.join(TMP, 'china-core-topo.json');
  await runCommands(`-i ${path.join(TMP, 'china-core.geojson')} -o format=topojson ${baseTopoFile}`);

  const tiers = [['fine', 15], ['coarse', 8]];
  const tierTopos = {};
  for (const [name, pct] of tiers) {
    const outFile = path.join(TMP, `china-${name}.json`);
    await runCommands(`-i ${baseTopoFile} -simplify visvalingam keep-shapes ${pct}% -o format=topojson ${outFile}`);
    const t = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    // 固定 object 名为 'china'，renderer 运行时按此名转 GeoJSON
    const objName = Object.keys(t.objects)[0];
    if (objName !== 'china') { t.objects.china = t.objects[objName]; delete t.objects[objName]; }
    tierTopos[name] = t;
    console.log(`  ${name}(${pct}%): arcs=${t.arcs.length} object=china`);
  }

  console.log('[4/6] 装饰面单独保存 + 省级地图（cn-atlas provinces）...');
  const decoFeatures = decoUnits
    .filter((u) => u.adcode !== NANHAI_ADCODE) // 南海已进 core
    .map((u) => {
      const f = curByAdcode.get(u.adcode);
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

  // 省级也拓扑保持简化（省界粗线每帧重绘，简化以减重；单档 15%）
  const provGjFile = path.join(TMP, 'china-provinces.geojson');
  fs.writeFileSync(provGjFile, JSON.stringify(provGeoJsonRaw));
  const provOutFile = path.join(TMP, 'china-provinces-simple.geojson');
  await runCommands(`-i ${provGjFile} -simplify visvalingam keep-shapes 15% -o format=geojson ${provOutFile}`);
  const provGeoJson = JSON.parse(fs.readFileSync(provOutFile, 'utf8'));
  console.log(`  省级面: ${provGeoJson.features.length} 个（简化后）`);

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

  console.log('[6/6] 输出 ...');
  fs.writeFileSync(path.join(OUT_DIR, 'china_units.json'), JSON.stringify({ ...tierTopos.fine, _source: SOURCE_NOTE }));
  fs.writeFileSync(path.join(OUT_DIR, 'china_units_coarse.json'), JSON.stringify({ ...tierTopos.coarse, _source: SOURCE_NOTE }));
  fs.writeFileSync(path.join(OUT_DIR, 'china_decorative.geojson'), JSON.stringify(decoGeoJson));
  fs.writeFileSync(path.join(OUT_DIR, 'china_provinces.geojson'), JSON.stringify(provGeoJson));
  fs.writeFileSync(path.join(OUT_DIR, 'units.json'), JSON.stringify({ units: allUnits, provinces: meta.provinces }));
  console.log(`  china_units.json: ${(fs.statSync(path.join(OUT_DIR, 'china_units.json')).size / 1024).toFixed(0)}KB`);
  console.log(`  china_units_coarse.json: ${(fs.statSync(path.join(OUT_DIR, 'china_units_coarse.json')).size / 1024).toFixed(0)}KB`);
  console.log(`  china_decorative.geojson: ${(fs.statSync(path.join(OUT_DIR, 'china_decorative.geojson')).size / 1024).toFixed(0)}KB`);
  console.log(`  china_provinces.geojson: ${(fs.statSync(path.join(OUT_DIR, 'china_provinces.geojson')).size / 1024).toFixed(0)}KB`);
}

run().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
