// 数据管线：从 cn-atlas（shengshixian.com 2023 拓扑干净的行政区划，TopoJSON）生成中国地图数据。
// 产出四档地级 TopoJSON（lossless 100% / fine 15% / coarse 8% / ultra 4%，拓扑保持无缝隙）
// + 省级无损档（TopoJSON，zoom ≥ 10）+ 港澳放大框无压缩面 + 装饰面 GeoJSON + 元数据表。
//
// 最精细档（lossless）不经过 -simplify：卡顿由运行时「视口裁剪」解决，而非降顶点（详见 lossless 段注释）。
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
/** 南海诸岛固定标注点（人工设定，见 [5/6] 处说明）。 */
const NANHAI_CENTER = [112, 16];

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

/** 统计 TopoJSON 的总弧点数（用于对比各档细节规模）。 */
function countVertices(topo) {
  let n = 0;
  for (const arc of topo.arcs ?? []) n += arc.length;
  return n;
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

/**
 * 几何邻接缝隙普查：**不依赖 units.json 的 neighbors 字段**。
 *
 * 为什么需要它：装饰面的 neighbors 字段历史上恒为空数组（它们不参与出题），
 * 于是旧的「按 neighbors 查共享顶点」闸门从未检查过装饰面 ——
 * 这正是全国 42 处装饰面缝隙（新疆兵团 10、海南 15、湖北 4 等）长期没被发现的原因。
 * 本函数直接从几何判定邻接，覆盖全部单位（含装饰面）。
 *
 * 相邻判定：两单位最近顶点距离 ≤ tolKm（0.05° 网格哈希加速，避免 O(n²) 顶点两两比较）。
 * 缝隙判定：判定为相邻但共享顶点数为 0。
 * 同时返回 nearPairs 规模（有多少对顶点互相在容差内），用于区分
 * 「真正的长边界缝隙」（大量顶点邻近却零共享）与「两块分离小岛恰好靠得近」（仅个位数顶点邻近）。
 */
function adjacencySeamStats(geojson, tolKm = 1.0) {
  const CELL = 0.05; // ≈5.5km，保证 3x3 邻域足以覆盖 1km 容差
  const kmPerDegLat = 111.32;
  // 「沿边界相邻」的判据：至少 MIN_NEAR_PTS 个顶点落在对方边界 1km 内。
  //
  // 为什么不是「任意两顶点距离 ≤1km」：那会把**角点相接**误判为相邻。
  // 实例：三亚市(460200) 与 五指山市(469001) 并不接壤（中间隔着保亭/乐东），
  // 二者在 units.json 的邻居表里互不出现，边界最小间距 1.10km；
  // 但各有一个角点相距 0.57km，旧判据据此认定「相邻却零共享顶点」→ 误报缝隙。
  // 真实的相邻（含数字化错开）会让**一整段**边界贴近，产生远多于 3 个的近邻顶点；
  // 角点相接只产生 1~2 个。故要求 ≥3 个，既能排除角点，又能抓住「整段错开」的回归。
  const MIN_NEAR_PTS = 3;
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
  const items = [];
  for (const f of geojson.features ?? []) {
    const pts = toPoints(f);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) {
      if (p[0] < minX) minX = p[0];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] < minY) minY = p[1];
      if (p[1] > maxY) maxY = p[1];
    }
    const grid = new Map();
    for (const p of pts) {
      const k = `${Math.floor(p[0] / CELL)},${Math.floor(p[1] / CELL)}`;
      let arr = grid.get(k);
      if (!arr) { arr = []; grid.set(k, arr); }
      arr.push(p);
    }
    const set = new Set(pts.map((p) => p[0].toFixed(6) + ',' + p[1].toFixed(6)));
    items.push({ ad: String(f.properties.adcode), name: f.properties.name, pts, grid, set, bbox: [minX, minY, maxX, maxY], segGrid: null });
  }

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
  /** 惰性构建线段栅格（同一单位在多对中复用） */
  const segGridOf = (it, coords) => {
    if (it.segGrid) return it.segGrid;
    const g = new Map();
    const push = (seg, key) => {
      let arr = g.get(key);
      if (!arr) { arr = []; g.set(key, arr); }
      arr.push(seg);
    };
    const walkRings = (c) => {
      if (!Array.isArray(c)) return;
      if (Array.isArray(c[0]) && typeof c[0][0] === 'number') {
        for (let i = 0; i < c.length; i++) {
          const a = c[i], b = c[(i + 1) % c.length];
          const seg = [a, b];
          const x0 = Math.floor(Math.min(a[0], b[0]) / CELL), x1 = Math.floor(Math.max(a[0], b[0]) / CELL);
          const y0 = Math.floor(Math.min(a[1], b[1]) / CELL), y1 = Math.floor(Math.max(a[1], b[1]) / CELL);
          if ((x1 - x0 + 1) * (y1 - y0 + 1) > 20000) { push(seg, 'ALL'); continue; }
          for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) push(seg, `${x},${y}`);
        }
        return;
      }
      for (const cc of c) walkRings(cc);
    };
    walkRings(coords);
    it.segGrid = g;
    return g;
  };
  /** A 的顶点中有几个落在 B 边界 tolKm 内（返回 {count, minKm}） */
  const countNearBoundary = (A, B) => {
    const g = segGridOf(B, B.coords);
    let count = 0, minKm = Infinity;
    for (const p of A.pts) {
      const cx = Math.floor(p[0] / CELL), cy = Math.floor(p[1] / CELL);
      let best = Infinity;
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        const arr = g.get(`${cx + dx},${cy + dy}`);
        if (!arr) continue;
        for (const [a, b] of arr) { const d = ptSegKm(p, a, b); if (d < best) best = d; }
      }
      const all = g.get('ALL');
      if (all) for (const [a, b] of all) { const d = ptSegKm(p, a, b); if (d < best) best = d; }
      if (best < minKm) minKm = best;
      if (best <= tolKm) count++;
    }
    return { count, minKm };
  };

  // 保存几何坐标供线段索引使用
  for (let k = 0; k < items.length; k++) items[k].coords = (geojson.features[k] ?? {}).geometry?.coordinates;

  const tolDegPad = tolKm / 100; // 保守外扩，避免 bbox 恰好相邻时被剪掉
  let pairs = 0; let zero = 0; const zeroList = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const A = items[i], B = items[j];
      if (A.bbox[0] - tolDegPad > B.bbox[2] || B.bbox[0] - tolDegPad > A.bbox[2]) continue;
      if (A.bbox[1] - tolDegPad > B.bbox[3] || B.bbox[1] - tolDegPad > A.bbox[3]) continue;
      // 相邻判定：A 的一段边界贴近 B 的边界，或反之
      const fb = countNearBoundary(A, B);
      const fa = countNearBoundary(B, A);
      const near = Math.max(fa.count, fb.count);
      if (near < MIN_NEAR_PTS) continue; // 不相邻（含仅角点相接）
      pairs++;
      let shared = 0;
      for (const p of A.pts) if (B.set.has(p[0].toFixed(6) + ',' + p[1].toFixed(6))) { shared++; }
      if (shared === 0) {
        zero++;
        zeroList.push({
          a: A.name, b: B.name, aad: A.ad, bad: B.ad, near,
          km: Math.min(fa.minKm, fb.minKm),
          minPts: Math.min(A.pts.length, B.pts.length),
        });
      }
    }
  }
  zeroList.sort((x, y) => y.near - x.near);
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

  // 县级装饰面（30 个省直辖县级/兵团城市）也并入核心拓扑组 —— 这是修复缝隙的关键。
  //
  // 历史问题（grill-rounds.log 2026-09-09 缝合）：它们原先作为独立 GeoJSON 在运行期拼接，有两个后果：
  //   1. 与 cn-atlas 边界**不共享顶点**：两个来源各自数字化，相邻边必然错开（实测 42 对相邻 100% 有缝，
  //      最大 0.847km）→ 全国 26 个装饰面周围都有可见裂缝（新疆兵团 10 个、湖北 4 个、海南 15 个等）。
  //   2. 装饰面恒为 100% 不简化，而核心面被简化到 15%/4% → 即使只对 100% 几何 snap，
  //      到了 fine/ultra 档二者仍不可能共享顶点（实测各档均 100% 有缝）。
  // 所以必须「并入同一拓扑组 → snap → 一起 explode → 一起简化」，让相邻边成为共享弧。
  for (const u of decoUnits) {
    if (u.adcode === NANHAI_ADCODE) continue; // 南海已加过
    const f = decoByAdcode.get(u.adcode);
    if (!f) { console.error(`⚠ 装饰面源缺 ${u.adcode} ${u.name}`); process.exit(1); }
    coreFeatures.push({ type: 'Feature', properties: { adcode: u.adcode, name: u.name }, geometry: f.geometry });
  }
  console.log(`  并入核心拓扑组的装饰面: ${decoUnits.length - 1} 个（另加南海诸岛）`);

  console.log('[3/6] 缝合 (snap) + 拓扑保持简化出 fine/coarse/ultra 三档 ...');
  const baseGeoJson = { type: 'FeatureCollection', features: coreFeatures };
  const coreGjFile = path.join(TMP, 'china-core.geojson');
  fs.writeFileSync(coreGjFile, JSON.stringify(baseGeoJson));

  // 缝合：分两步，缺一不可。
  //
  // 第一步 -snap interval=0.01：把邻近顶点吸附到 0.01° 网格（≈1.1km，全国尺度约 1px）。
  // 第二步 -clean gap-width=auto：**在对方边界上插入顶点**，把两个来源的折线切成同一组弧段。
  //
  // 为什么必须有第二步（实测教训）：
  //   -snap 只能合并「本来就靠得近的既有顶点」，**不会把顶点插入对方的边里**。
  //   典型例子：晋城市(257 顶点)↔济源市(23 顶点)，snap 后有 8 个精确重合顶点，
  //   但共享**边**仍是 0 条 —— 两个重合顶点之间，两条折线各走各的，
  //   渲染时中间仍会透出背景色（细白线）。
  //   度量：跨源相邻对「共享 arc」的比例，snap 后仅 16/41 = 39%；
  //   加上 -clean gap-width=auto 后达到 41/41 = 100%（同源对 896/896 = 100%）。
  //   clean 内部的 snapAndCut 会做「求交 → 在交点处切开弧段」，这正是共享弧的来源。
  //
  // 代价（实测，相对只 snap）：
  //   顶点 154447 → 155061（+0.4%）；总面积 −0.0013%；
  //   平均位移 72m；面积变化 >0.1% 的面 43/371，且**全部集中在 30 个装饰面**
  //   （核心面最大仅 1.56%，装饰面最大 27%——因为 DataV 装饰面与 cn-atlas 邻居本来
  //    就**互相重叠**（实测重叠 0.2%~27%），clean 把重叠区判给其中一方，属预期而非失真）。
  const snappedFile = path.join(TMP, 'china-core-snapped.geojson');
  await runCommands(`-i ${coreGjFile} -snap interval=0.01 -clean gap-width=auto -o format=geojson ${snappedFile}`);
  console.log(`  缝合 snap=0.01 + clean: 面数 ${JSON.parse(fs.readFileSync(snappedFile, 'utf8')).features.length}/${coreFeatures.length}`);

  // 关键：先 -explode 把 MultiPolygon 拆成独立 Polygon 再简化。
  // 原因：mapshaper 的 keep-shapes 只保证「整个 feature 不消失」，不保护 MultiPolygon 内部的孤立小环
  // （实测淮北 340600 有个 39.68km² 飞地小环，在 8%/4% 简化下被删除 → 拓扑改写 → 与徐州 320300 的共享弧被拆开
  //   → 0.135° 可见缝隙）。explode 后每个小环都是独立 feature，受 keep-shapes 保护，简化后零共享恢复到 0。
  const explodedFile = path.join(TMP, 'china-core-exploded.geojson');
  await runCommands(`-i ${snappedFile} -explode -o format=geojson ${explodedFile}`);

  // 三档简化 TopoJSON（fine 15% / coarse 8% / ultra 4%）。
  // 注意：zoom ≥ 10 用的最精细档（无压缩，16.9 万顶点）在 fine 之上就地生成，
  // 见下方 losslessTopo（不经过 -simplify，直接由 exploded 拓扑导出）。
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

  // 最精细档 = 无损（无简化）：zoom ≥ 10 时使用。
  // 卡顿问题改由「视口裁剪」解决（见 src/map/cull.ts），而非降顶点：
  // 实测 zrender 每帧对每个 Path 重算 buildPath，开销 ∝ 顶点数，但把不可见的面/线整体
  // 移出绘制列表（ignore=true）可跳过其 buildPath 与绘制，代价 O(1)。
  // 实测（1600x1000，中心广州，标签开，4 轮交错取最小值）每帧拖动成本：
  //   无损 无裁剪 28.2ms → 无损 + 裁剪 13.2ms（2.1x）
  //   对照：压缩 33% + 省界无损 34.6ms（当前线上）、压缩 33% + 省界细档 10.5ms
  // 即裁剪让**无压缩**的无损档优于「压缩 33% 但省界仍无损」的旧方案，且不损失任何精度。
  // 拓扑来源仍是 explode 后的几何，故与各简化档共享同一套弧，天然无缝隙。
  {
    const outFile = path.join(TMP, 'china-lossless.json');
    await runCommands(`-i ${explodedFile} -o format=topojson ${outFile}`);
    const t = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    const objName = Object.keys(t.objects)[0];
    t.objects.china = mergeGeometriesByAdcode(t.objects[objName]);
    delete t.objects[objName];
    tierTopos.lossless = t;
    const v = countVertices(t);
    console.log(`  lossless(100%): arcs=${t.arcs.length} 合并后 features=${t.objects.china.geometries.length} 顶点=${v}`);
  }

  console.log('[4/6] 省级地图（cn-atlas provinces）...');
  // 注：装饰面已并入地级核心拓扑组（见 [3/6]），不再单独输出 china_decorative.geojson。
  // 原先「装饰面单独成文件 + 运行期拼接」是缝隙的根源，该文件与其拼接逻辑一并移除。

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

  // 省级无损档（zoom ≥ 10 用）：无压缩，转 TopoJSON 共享弧压缩（2632KB GeoJSON → 396KB TopoJSON）。
  // 面积小可同步加载，无需像地级 raw 那样异步。
  const provRawTopoFile = path.join(TMP, 'china-provinces-raw-topo.json');
  await runCommands(`-i ${provGjFile} -o format=topojson ${provRawTopoFile}`);
  const provRawTopo = JSON.parse(fs.readFileSync(provRawTopoFile, 'utf8'));
  const provRawObjName = Object.keys(provRawTopo.objects)[0];
  provRawTopo.objects.china = provRawTopo.objects[provRawObjName];
  delete provRawTopo.objects[provRawObjName];
  console.log(`  省级无损档: arcs=${provRawTopo.arcs.length} features=${provRawTopo.objects.china.geometries.length}`);

  console.log('[5/6] 用 fine 档几何重建中心点与邻接 ...');
  const fineTopo = tierTopos.fine;
  const fineGeo = feature(fineTopo, fineTopo.objects.china);
  const fineFeatures = fineGeo.features ?? [];
  const fineById = new Map(fineFeatures.map((f) => [String(f.properties.adcode), f]));

  for (const u of realUnits) {
    const f = fineById.get(u.adcode);
    if (f) u.center = centerOf(f);
  }
  // 装饰面也刷新中心点：它们原先的中心来自旧 DataV 几何，并入拓扑并 snap 后有微小位移，
  // 保持与所用几何一致（标签落点/定位更准）。
  // 例外：南海诸岛**不重算**，固定为人工标注点 [112, 16]。
  // 它是纯装饰（不出题），常规标注点在南海中部；重算会取「面积最大的小岛」→ 实测漂到
  // 122.5,23.5（东海方向），位移 1434km，属明显回归。
  // 注意：本脚本以 units.json 为**输入**（读 allUnits）又把它写回输出，所以这里必须显式赋回
  // 固定值而不是「跳过」—— 否则上一轮被污染的坐标会一直留在文件里。
  for (const u of decoUnits) {
    if (u.adcode === NANHAI_ADCODE) { u.center = NANHAI_CENTER; continue; }
    const f = fineById.get(u.adcode);
    if (f) u.center = centerOf(f);
  }

  // 邻接：真实单位 + 装饰面都算。
  // 装饰面（省直辖县级/兵团城市）在运行期是**可出题的真实单位**（data.ts 只把南海诸岛保留为 decorative），
  // 但历史上它们的 neighbors 恒为空 → 「找相邻单位」类题目把它们排除在候选之外。并入拓扑后它们的邻接已可用，
  // 顺带一并重建（判定与真实单位同一套 booleanIntersects）。
  const nbrUnits = allUnits.filter((u) => u.adcode !== NANHAI_ADCODE && fineById.has(u.adcode));
  for (const u of nbrUnits) u.neighbors = [];
  const bboxes = nbrUnits.map((u) => bboxOf(fineById.get(u.adcode)));
  for (let i = 0; i < nbrUnits.length; i++) {
    for (let j = i + 1; j < nbrUnits.length; j++) {
      const a = bboxes[i], b = bboxes[j];
      if (a[0] > b[2] || b[0] > a[2] || a[1] > b[3] || b[1] > a[3]) continue;
      const fi = fineById.get(nbrUnits[i].adcode);
      const fj = fineById.get(nbrUnits[j].adcode);
      if (!fi || !fj) continue;
      if (booleanIntersects(fi, fj)) {
        nbrUnits[i].neighbors.push(nbrUnits[j].adcode);
        nbrUnits[j].neighbors.push(nbrUnits[i].adcode);
      }
    }
  }
  const noNeighbor = nbrUnits.filter((u) => u.neighbors.length === 0);
  console.log(`  邻接重建：${nbrUnits.length} 个单位（含 ${decoUnits.length - 1} 个装饰面）；无邻接（岛屿/飞地）: ${noNeighbor.map((u) => u.name).join('、') || '无'}`);

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
    // 第二道闸门：几何邻接普查（含装饰面）。旧闸门只查 units.json 的 neighbors，
    // 而装饰面 neighbors 恒为空 → 全国 42 处装饰面缝隙长期漏检。此闸门不依赖该字段。
    const geoSt = adjacencySeamStats(gj);
    // 排除南海诸岛（100000_JD）：它是一组远离大陆的岛礁散点，与任何陆地都不相邻，
    // 其 "缝隙" 是地理距离而非数字化错位，不属于本闸门要拦的问题。
    // 字段名注意：zeroList 的条目是 { a, b, aad, bad, km, near, minPts }，adcode 在 aad/bad 里。
    const realZero = geoSt.zeroList.filter((z) => !String(z.aad).startsWith('100000') && !String(z.bad).startsWith('100000'));
    const ok2 = realZero.length === 0;
    if (!ok || !ok2) gateFail = true;
    console.log(`  ${name}: 邻接表相邻边 ${st.pairs} 对零共享 ${st.zero} ${ok ? '✅' : '❌'}`);
    console.log(`         几何邻接 ${geoSt.pairs} 对，缝隙 ${geoSt.zero}（排除南海 ${geoSt.zero - realZero.length}）${ok2 ? ' ✅' : ' ❌'}`);
    if (!ok2) {
      for (const z of realZero.slice(0, 8)) {
        // near 大 = 长边界错开（真缝隙）；near 很小 = 两块几何恰好靠得近（多为分离小岛）
        console.log(`           ${z.km.toFixed(3)}km 近邻顶点 ${z.near}/${z.minPts}  ${z.a}(${z.aad}) ↔ ${z.b}(${z.bad})`);
      }
    }
  }
  if (gateFail) {
    console.error('FAIL: 存在零共享相邻边（可见缝隙），拒绝输出。检查 -snap/-explode 是否生效。');
    process.exit(1);
  }

  fs.writeFileSync(path.join(OUT_DIR, 'china_units.json'), JSON.stringify({ ...tierTopos.fine, _source: SOURCE_NOTE }));
  fs.writeFileSync(path.join(OUT_DIR, 'china_units_coarse.json'), JSON.stringify({ ...tierTopos.coarse, _source: SOURCE_NOTE }));
  fs.writeFileSync(path.join(OUT_DIR, 'china_units_ultra.json'), JSON.stringify({ ...tierTopos.ultra, _source: SOURCE_NOTE }));
  fs.writeFileSync(path.join(OUT_DIR, 'china_units_lossless.json'), JSON.stringify({ ...tierTopos.lossless, _source: SOURCE_NOTE }));
  fs.writeFileSync(path.join(OUT_DIR, 'china_provinces.geojson'), JSON.stringify(provGeoJsons.fine));
  fs.writeFileSync(path.join(OUT_DIR, 'china_provinces_coarse.geojson'), JSON.stringify(provGeoJsons.coarse));
  fs.writeFileSync(path.join(OUT_DIR, 'china_provinces_raw.json'), JSON.stringify({ ...provRawTopo, _source: SOURCE_NOTE }));
  fs.writeFileSync(path.join(OUT_DIR, 'hkmac.geojson'), JSON.stringify(hkmacGeoJson));
  fs.writeFileSync(path.join(OUT_DIR, 'units.json'), JSON.stringify({ units: allUnits, provinces: meta.provinces }));
  for (const f of ['china_units.json', 'china_units_coarse.json', 'china_units_ultra.json', 'china_units_lossless.json', 'china_provinces.geojson', 'china_provinces_coarse.geojson', 'china_provinces_raw.json', 'hkmac.geojson']) {
    console.log(`  ${f}: ${(fs.statSync(path.join(OUT_DIR, f)).size / 1024).toFixed(0)}KB`);
  }
  // 退役产物：装饰面已并入地级拓扑，运行时不再单独加载。
  const stale = path.join(OUT_DIR, 'china_decorative.geojson');
  if (fs.existsSync(stale)) { fs.unlinkSync(stale); console.log('  已删除退役产物 china_decorative.geojson（装饰面已并入拓扑）'); }
}

run().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
