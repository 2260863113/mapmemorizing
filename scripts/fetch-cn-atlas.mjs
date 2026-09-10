// 数据管线：从 cn-atlas（shengshixian.com 2023 拓扑干净的行政区划，TopoJSON）生成中国地图数据。
// 产出四档地级 TopoJSON（lossless 100% / fine 15% / coarse 8% / ultra 4%，拓扑保持无缝隙）
// + 省级无损档（TopoJSON，zoom ≥ 14）+ 港澳放大框无压缩面 + 元数据表。
//
// 单一来源：全部 372 个 cn-atlas prefectures 面（地级 + 县级/兵团市，本来就在同一套弧拓扑里），
// 只额外补入 cn-atlas 没有的南海诸岛装饰面。不做 -snap/-clean 缝合（原因见 [2/6] 段注释）。
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
const SOURCE_NOTE = 'https://github.com/BarbarossaWang/cn-atlas (shengshixian.com 2023 shp → mapshaper 简化 → TopoJSON；全部 372 个地级/县级面单一来源，仅南海诸岛保留自 DataV)。';
const TMP = path.join(ROOT, '.cnatlas-tmp');
const NANHAI_ADCODE = '100000_JD';
/** 南海诸岛固定标注点（人工设定，见 [5/6] 处说明）。 */
const NANHAI_CENTER = [112, 16];

/**
 * cn-atlas 补入本项目、但 units.json 里原先没有的两个兵团市。
 *
 * 它们是 cn-atlas 的 prefectures 面（已从塔城地区/哈密市挖出），只是历史上的白名单没列。
 * 不补进来，被挖走的那块地就**无人认领** → 地级视图露白（用户报的「塔城左边空了一大块」）。
 * 名称/所属省/类型仍需与其它单位口径一致，故在此显式声明。
 */
const NEW_COUNTY_UNITS = [
  { adcode: '659011', name: '新星市', shortName: '新星市', province: '新疆维吾尔自治区', provinceAdcode: '650000', decorative: true },
  { adcode: '659012', name: '白杨市', shortName: '白杨市', province: '新疆维吾尔自治区', provinceAdcode: '650000', decorative: true },
];

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
/**
 * 从源 TopoJSON 直接读出「真相邻」配对 —— 即共享 ≥1 条 arc 的两个面。
 *
 * 这是**不依赖任何几何容差**的基线：TopoJSON 的 arc 共享是结构性的，
 * 共享就一定是同一段边界，不存在「靠得近但不相邻」的歧义。
 * 产物必须保持这个不变式：源里共享弧的两单位，各简化档里也必须仍共享顶点。
 */
function sourceAdjacentPairs(topo) {
  const geoms = (topo.objects.prefectures.geometries ?? []).filter((g) => g.properties?.id != null);
  const arcIds = (geom) => {
    const s = new Set();
    const walk = (n) => {
      if (typeof n === 'number') { s.add(n < 0 ? ~n : n); return; }
      if (Array.isArray(n)) { for (const x of n) walk(x); return; }
      if (n && n.arcs) walk(n.arcs);
      if (n && n.geometries) walk(n.geometries);
    };
    walk(geom);
    return s;
  };
  const byArc = new Map();
  for (const g of geoms) {
    const ad = String(g.properties.id);
    for (const a of arcIds(g)) {
      let arr = byArc.get(a);
      if (!arr) { arr = []; byArc.set(a, arr); }
      arr.push(ad);
    }
  }
  const pairs = new Set();
  for (const [, ids] of byArc) {
    if (ids.length < 2) continue;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        pairs.add(ids[i] < ids[j] ? ids[i] + '|' + ids[j] : ids[j] + '|' + ids[i]);
      }
    }
  }
  return pairs;
}

/**
 * 闸门：源里共享 arc 的每一对，在产物里必须仍共享 ≥1 个顶点。
 *
 * 为什么不再用「几何邻近 + 共享顶点」（2026-09 第三次修正）：
 * 那条路需要一个「多近才算相邻」的容差，而实测**找不到干净阈值** ——
 * 无论取顶点计数还是贴合长度，「零共享」与「有共享」两组都会重叠，于是必然误报：
 *   凉山彝族自治州(513400) ↔ 曲靖市(530300)：几何最近 0.645km，但源拓扑里**共享 0 条 arc**
 *     （units.json 邻接表里二者也互不出现）→ 是角点相接，不是接缝。
 *   三亚市(460200) ↔ 五指山市(469001)：同理，源里共享 0 条 arc。
 * 改用源拓扑的 arc 共享做基线后，判据是**确定性**的：源里 970 对相邻，产物里就必须 970 对全部共享顶点。
 */
function groundTruthSeamStats(geojson, srcPairs) {
  const byAd = new Map();
  for (const f of geojson.features ?? []) {
    const ad = String(f.properties.adcode);
    let s = byAd.get(ad);
    if (!s) { s = new Set(); byAd.set(ad, s); }
    const walk = (c) => {
      if (!Array.isArray(c)) return;
      if (Array.isArray(c[0]) && typeof c[0][0] === 'number') { for (const p of c) s.add(p[0].toFixed(6) + ',' + p[1].toFixed(6)); return; }
      for (const cc of c) walk(cc);
    };
    walk(f.geometry.coordinates);
  }
  const missing = [];
  for (const key of srcPairs) {
    const [a, b] = key.split('|');
    const A = byAd.get(a), B = byAd.get(b);
    if (!A || !B) { missing.push({ a, b, why: '产物缺面' }); continue; }
    let shared = false;
    for (const p of A) if (B.has(p)) { shared = true; break; }
    if (!shared) missing.push({ a, b, why: '零共享顶点' });
  }
  return { total: srcPairs.size, ok: srcPairs.size - missing.length, missing };
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
  // 补齐 units.json 里缺失的两个兵团市（cn-atlas 有面、我们没登记）。
  // 必须在算 realUnits/decoUnits 之前插入，否则 [5/6] 重建邻接/中心点时它们不在名单里。
  const knownAds = new Set(allUnits.map((u) => String(u.adcode)));
  for (const nu of NEW_COUNTY_UNITS) {
    if (!knownAds.has(nu.adcode)) {
      allUnits.push({ ...nu, center: [0, 0], neighbors: [] });
      console.log(`  补齐缺失单位: ${nu.adcode} ${nu.name}（cn-atlas 有面，units.json 原先没有）`);
    }
  }
  const realUnits = allUnits.filter((u) => !u.decorative); // 340 真实地级
  const decoUnits = allUnits.filter((u) => u.decorative); // 33 装饰（32 县级 + 南海）
  /** adcode → 中文名，用于给 cn-atlas 面命名（源里是拼音 name + 中文「地名」）。 */
  const NAME_BY_ADCODE = new Map(allUnits.map((u) => [String(u.adcode), u.name]));

  // 装饰面源（构建期输入，已提交）：省直辖县级/兵团城市 + 南海诸岛。
  // cn-atlas **自带**这些县级面（见下方 NEW_COUNTY），但历史上我们只取了 341 个真实地级面，
  // 于是县级地带留空，改用 DataV 补 —— 这正是「新疆坑洞 / 塔城空白」的根源。现仅保留南海诸岛。
  const decoSrc = JSON.parse(fs.readFileSync(path.join(ROOT, 'data-src', 'datav-decorative.geojson'), 'utf8'));
  const decoByAdcode = new Map(decoSrc.features.map((f) => [String(f.properties.adcode), f]));
  const nanhai = decoByAdcode.get(NANHAI_ADCODE);
  if (!nanhai) { console.error('⚠ 装饰面源缺南海诸岛 (data-src/datav-decorative.geojson)'); process.exit(1); }

  // cn-atlas prefectures/provinces → GeoJSON
  const prefs = feature(topo, topo.objects.prefectures);
  const prefsById = new Map(prefs.features.map((f) => [String(f.properties.id), f]));
  const provs = feature(topo, topo.objects.provinces);
  const provsById = new Map(provs.features.map((f) => [String(f.properties.id), f]));

  // ─────────────────────────────────────────────────────────────────────────────
  // 几何选取策略（2026-09 第二次修正，务必读懂再改）
  //
  // 事实链：
  //   1. cn-atlas `prefectures` 有 **372** 面，其中含 32 个县级/兵团单位
  //      （海南 15 个直辖县、湖北仙桃/潜江/天门/神农架、河南济源、新疆兵团 12 个）。
  //      这些县级面是**从相邻地级面上挖下来的**，所以地级面在相应位置留有内环（洞）。
  //   2. 历史实现只取 341 个「真实地级」面，把那 32 个县级面丢掉，改用阿里 DataV 补。
  //      但 DataV 与 cn-atlas 是**两个独立来源**，覆盖范围对不上：
  //        · cn-atlas 有、DataV 没有 → **白杨市 659012（2023 年设立，2550km²）、
  //          新星市 659011（2021 年设立，593km²）**。它们已从塔城地区/哈密市挖走，
  //          我们却没补回来 → 塔城西侧 1147km²、哈密 561km² 的空白（用户报的「塔城左边空了」）。
  //        · 反过来 DataV 有、cn-atlas 挖的位置不同 → 铁门关市 cn-atlas 2029km² vs DataV 551km²。
  //   3. 为把两个来源缝起来，上一轮加了 `-snap + -clean`。实测（见 ver-route-compare.mjs）：
  //        · `-clean` 会把相邻面互相重叠的部分**判给一方并给对方挖洞**
  //          → 全国内环从 46 个暴增到 125 个，其中 27 个洞**没有任何面填充**（合计 4677km²），
  //            专挑沿海小岛下手（儋州/宁波/茂名/湛江/宁德/惠州/漳州/泉州/大连各被咬掉一块）。
  //          实验对照：只喂 341 个真实面、不加 DataV，-clean 仍造出 12 个洞 → 洞是 -clean 造的。
  //
  // 结论：**两个来源混合本身就是病根，缝它只会制造新病**。改为「单一来源」：
  //   直接采用 cn-atlas 的全部 372 个面（地级 + 县级，本来就在同一套弧拓扑里），
  //   不做 `-snap`、不做 `-clean`。只剩南海诸岛仍需从 DataV 补（cn-atlas 无此面，
  //   但它在远离大陆的南海，不与任何陆地相邻，不会产生接缝）。
  //
  // 实测收益（ver-route-compare.mjs / ver-route2-detail.mjs / ver-hole-fill.mjs）：
  //   内环 125 → 46（全部被相邻面填满，0 个真空，栅格严检）；
  //   省-地真空 11928 → 7186km²（剩下的绝大多数是省级面含南海海域主张，非陆地空白）；
  //   相邻对共享弧 970（与源一致），且经 explode + 简化 + 合并后**仍是 970** → 无缝无洞同时成立。
  //
  // 注意：源里 372 面 = 我们需要的 371 个 adcode + 白杨 659012 + 新星 659011，
  //   即源的 adcode 集合与本项目**完全对齐**（另有南海诸岛 100000_JD 是唯一的外部补充）。
  //   所以这里按 adcode 直接全取，并于下方补齐 units.json 缺的两个兵团市。
  // ─────────────────────────────────────────────────────────────────────────────
  const coreFeatures = [];
  const PREFS = prefs.features.filter((f) => f.properties.id != null);
  for (const f of PREFS) {
    const ad = String(f.properties.id);
    const name = NAME_BY_ADCODE.get(ad) ?? String(f.properties['地名'] ?? f.properties.name);
    coreFeatures.push({ type: 'Feature', properties: { adcode: ad, name }, geometry: f.geometry });
  }
  console.log(`  cn-atlas prefectures 全部取用: ${coreFeatures.length} 面（地级 + 县级，同源同拓扑）`);
  // 南海诸岛（cn-atlas 无此面）单独补入核心拓扑组，让 mapshaper 一并拓扑化。
  coreFeatures.push({ type: 'Feature', properties: { adcode: NANHAI_ADCODE, name: '南海诸岛' }, geometry: nanhai.geometry });
  console.log(`  另补南海诸岛 1 面（cn-atlas 无；远离大陆，不产生接缝）`);

  console.log('[3/6] 拓扑保持简化出 ultra/pro/fine/plus 四档 ...');
  const baseGeoJson = { type: 'FeatureCollection', features: coreFeatures };
  const coreGjFile = path.join(TMP, 'china-core.geojson');
  fs.writeFileSync(coreGjFile, JSON.stringify(baseGeoJson));

  // 不再做 -snap / -clean。
  //
  // 上一轮曾用 `-snap interval=0.01 -clean gap-width=auto` 去缝「cn-atlas 地级面 ↔ DataV 县级面」，
  // 当时换来「跨源相邻对共享弧 39% → 100%」，但**代价是造出大量新洞**，且这些洞没有任何面填充：
  //
  //   实测（exp-clean-holes.mjs，只喂 341 个 cn-atlas 真实面、完全不含 DataV）：
  //     原样          → 22 个面有内环，共 46 个
  //     只 snap 0.01  → 22 个面有内环，共 45 个
  //     snap + clean  → **81 个面有内环，共 119 个**，且沿海 9 个单位各被咬掉一块
  //   即洞是 `-clean` 自己造的，与 DataV 无关：它把相邻面互相重叠的部分判给一方、给对方留洞。
  //
  // 现在既然改回**单一来源**（cn-atlas 372 面本来就在同一套弧拓扑里，天然共享弧），
  // 就完全不需要缝合，也就不会造洞。实测经 explode + 简化 + 合并后共享弧配对仍为 970（与源一致）。
  const snappedFile = coreGjFile; // 直通：不再改写几何
  console.log(`  单一来源，不做 snap/clean: 面数 ${coreFeatures.length}`);

  // 关键：先 -explode 把 MultiPolygon 拆成独立 Polygon 再简化。
  // 原因：mapshaper 的 keep-shapes 只保证「整个 feature 不消失」，不保护 MultiPolygon 内部的孤立小环
  // （实测淮北 340600 有个 39.68km² 飞地小环，在 8%/4% 简化下被删除 → 拓扑改写 → 与徐州 320300 的共享弧被拆开
  //   → 0.135° 可见缝隙）。explode 后每个小环都是独立 feature，受 keep-shapes 保护，简化后零共享恢复到 0。
  const explodedFile = path.join(TMP, 'china-core-exploded.geojson');
  await runCommands(`-i ${snappedFile} -explode -o format=geojson ${explodedFile}`);

  // 四档简化 TopoJSON。精细度阶梯（顶点保留比例）：
  //   ultra 4%  →  pro 8%  →  fine 15%  →  plus 40%  →  lossless 100%（下方单独生成）
  // pro 取 8%：位于 ultra(4%) 与 fine(15%) 之间（几何中点 √(4×15)≈7.7）；
  // plus 取 40%：位于 fine(15%) 与 lossless(100%) 之间（几何中点 √(15×100)≈38.7）。
  // 注意 pro 8% 与本项目历史上已弃用的 coarse 8% 是**同一个比例**，故 pro 的产物
  // 同时写一份到 china_units_coarse.json，保证旧缓存里的老 bundle 仍能取到该文件。
  // 注意：zoom ≥ 14 用的最精细档（无压缩，约 9.7 万顶点）在下方单独生成，
  // 见下方 losslessTopo（不经过 -simplify，直接由 exploded 拓扑导出）。
  const tiers = [['ultra', 4], ['pro', 8], ['fine', 15], ['plus', 40]];
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
  // 历史文件名兼容：coarse 8% 与 pro 8% 内容完全相同，直接复用同一份拓扑。
  tierTopos.coarse = tierTopos.pro;

  // 最精细档 = 无损（无简化）：zoom ≥ 14 时使用。
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

  // 省级也拓扑保持简化（省界粗线每帧重绘，简化以减重），四档，与地级精细度阶梯对齐：
  //   ultra 4% (<2) / pro 8% (2~6) / fine 15% (6~10) / plus 40% (10~14)；lossless 走下方 raw 档。
  // 同地级：先 -explode 保护 MultiPolygon 内部小环（如沿海岛屿），简化后按 adcode 合并回来。
  //
  // **存 TopoJSON 而非 GeoJSON**（本次修正）：省级面与地级面一样是拓扑相邻的，共享弧压缩收益极大。
  // 实测同顶点数下 TopoJSON 比 GeoJSON 小 78%~84%（plus 40%: 1087KB → 174KB），
  // 且 plus 档若存 GeoJSON 会比**100% 的无损档 TopoJSON（396KB）还大 2.7 倍**，明显不合理。
  // 运行期由 data.ts 的 topoToGeoJson() 统一转回 GeoJSON，下游（renderer/inset）无需改动。
  const provGjFile = path.join(TMP, 'china-provinces.geojson');
  fs.writeFileSync(provGjFile, JSON.stringify(provGeoJsonRaw));
  const provExploded = path.join(TMP, 'china-provinces-exploded.geojson');
  await runCommands(`-i ${provGjFile} -explode -o format=geojson ${provExploded}`);
  const provTiers = [['ultra', 4], ['pro', 8], ['fine', 15], ['plus', 40]];
  const provTopos = {};
  for (const [name, pct] of provTiers) {
    const outFile = path.join(TMP, `china-provinces-out-${name}.json`);
    await runCommands(`-i ${provExploded} -simplify visvalingam keep-shapes ${pct}% -o format=topojson ${outFile}`);
    const t = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    const objName = Object.keys(t.objects)[0];
    t.objects.china = mergeGeometriesByAdcode(t.objects[objName]);
    delete t.objects[objName];
    t._source = SOURCE_NOTE;
    provTopos[name] = t;
    console.log(`  省级面 ${name}(${pct}%): arcs=${t.arcs.length} features=${t.objects.china.geometries.length}`);
  }
  // 历史文件名兼容：省级 coarse 4% 与 ultra 4% 内容完全相同（旧 bundle 会请求 china_provinces_coarse.geojson）。
  provTopos.coarse = provTopos.ultra;

  // 省级无损档（zoom ≥ 14 用）：无压缩，转 TopoJSON 共享弧压缩（2632KB GeoJSON → 396KB TopoJSON）。
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
  // 装饰面中心点也刷新：现在它们的几何来自 cn-atlas（不再是 DataV），中心必须与所用几何一致。
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
  // 闸门：以**源拓扑的 arc 共享**为基线（确定性、无容差），逐档验证产物保持该不变式。
  // 两道：
  //   ① 邻接表闸门（原有）：units.json 里互为邻居的对，必须共享 ≥1 顶点；
  //   ② 源拓扑闸门（本次新增）：源里共享 ≥1 arc 的 970 对，在各档里必须仍共享 ≥1 顶点。
  //      它不依赖 units.json 的 neighbors 字段（该字段由本脚本自己生成，自证无意义），
  //      也不依赖任何几何容差（旧的距离判据在「零共享 vs 有共享」两组间分布重叠，必然误报）。
  const srcPairs = sourceAdjacentPairs(topo);
  console.log(`  源拓扑真相邻（共享 ≥1 arc）: ${srcPairs.size} 对`);
  const tierStats = {};
  let gateFail = false;
  // 只闸门**唯一**档位：coarse 是 pro 的别名（同一份拓扑对象），重复检查无意义。
  const seenTier = new Set();
  for (const [name, topo] of Object.entries(tierTopos)) {
    if (seenTier.has(topo)) continue;
    seenTier.add(topo);
    const gj = feature(topo, topo.objects.china);
    const st = sharedVertexStats(gj, allUnits);
    tierStats[name] = st;
    const ok = st.zero === 0;
    const gt = groundTruthSeamStats(gj, srcPairs);
    const ok2 = gt.missing.length === 0;
    if (!ok || !ok2) gateFail = true;
    console.log(`  ${name}: 邻接表相邻边 ${st.pairs} 对零共享 ${st.zero} ${ok ? '✅' : '❌'}`);
    console.log(`         源拓扑 ${gt.total} 对相邻，保持共享顶点 ${gt.ok} 对，断裂 ${gt.missing.length} ${ok2 ? '✅' : '❌'}`);
    if (!ok2) {
      for (const m of gt.missing.slice(0, 8)) {
        const nm = (ad) => NAME_BY_ADCODE.get(ad) ?? ad;
        console.log(`           ${nm(m.a)}(${m.a}) ↔ ${nm(m.b)}(${m.b})  ${m.why}`);
      }
    }
  }
  if (gateFail) {
    console.error('FAIL: 相邻边零共享（可见缝隙），拒绝输出。检查白名单面是否齐全、-explode 是否生效。');
    process.exit(1);
  }

  // ── 地级五档 ──────────────────────────────────────────────────────────────
  // 精细度阶梯：ultra 4% < pro 8% < fine 15% < plus 40% < lossless 100%
  fs.writeFileSync(path.join(OUT_DIR, 'china_units_ultra.json'), JSON.stringify({ ...tierTopos.ultra, _source: SOURCE_NOTE }));
  fs.writeFileSync(path.join(OUT_DIR, 'china_units_pro.json'), JSON.stringify({ ...tierTopos.pro, _source: SOURCE_NOTE }));
  fs.writeFileSync(path.join(OUT_DIR, 'china_units.json'), JSON.stringify({ ...tierTopos.fine, _source: SOURCE_NOTE }));
  fs.writeFileSync(path.join(OUT_DIR, 'china_units_plus.json'), JSON.stringify({ ...tierTopos.plus, _source: SOURCE_NOTE }));
  fs.writeFileSync(path.join(OUT_DIR, 'china_units_lossless.json'), JSON.stringify({ ...tierTopos.lossless, _source: SOURCE_NOTE }));
  // 历史文件名（旧缓存里的老 bundle 仍会请求这两个文件；内容与 pro 8% / ultra 4% 完全相同）
  fs.writeFileSync(path.join(OUT_DIR, 'china_units_coarse.json'), JSON.stringify({ ...tierTopos.coarse, _source: SOURCE_NOTE }));
  // ── 省级五档（TopoJSON；运行期 topoToGeoJson 转回 GeoJSON）──────────────────
  // 命名与地级对称：无后缀 = fine 15%，其余带档位后缀。
  fs.writeFileSync(path.join(OUT_DIR, 'china_provinces_ultra.json'), JSON.stringify(provTopos.ultra));
  fs.writeFileSync(path.join(OUT_DIR, 'china_provinces_pro.json'), JSON.stringify(provTopos.pro));
  fs.writeFileSync(path.join(OUT_DIR, 'china_provinces.json'), JSON.stringify(provTopos.fine));
  fs.writeFileSync(path.join(OUT_DIR, 'china_provinces_plus.json'), JSON.stringify(provTopos.plus));
  fs.writeFileSync(path.join(OUT_DIR, 'china_provinces_raw.json'), JSON.stringify({ ...provRawTopo, _source: SOURCE_NOTE }));
  // ── 历史文件名（仅服务「旧缓存 index.html → 旧 hash bundle」）─────────────────
  // 旧 bundle 会请求这两个 GeoJSON 文件名。保留它们可让缓存未过期的用户仍能正常加载，
  // 代价是 658KB 冗余静态资源；新 bundle 一律只读上面的 TopoJSON。
  fs.writeFileSync(path.join(OUT_DIR, 'china_provinces.geojson'), JSON.stringify({ type: 'FeatureCollection', features: feature(provTopos.fine, provTopos.fine.objects.china).features }));
  fs.writeFileSync(path.join(OUT_DIR, 'china_provinces_coarse.geojson'), JSON.stringify({ type: 'FeatureCollection', features: feature(provTopos.ultra, provTopos.ultra.objects.china).features }));
  fs.writeFileSync(path.join(OUT_DIR, 'hkmac.geojson'), JSON.stringify(hkmacGeoJson));
  fs.writeFileSync(path.join(OUT_DIR, 'units.json'), JSON.stringify({ units: allUnits, provinces: meta.provinces }));
  for (const f of ['china_units.json', 'china_units_ultra.json', 'china_units_pro.json', 'china_units_plus.json', 'china_units_lossless.json', 'china_provinces.json', 'china_provinces_ultra.json', 'china_provinces_pro.json', 'china_provinces_plus.json', 'china_provinces_raw.json', 'hkmac.geojson']) {
    console.log(`  ${f}: ${(fs.statSync(path.join(OUT_DIR, f)).size / 1024).toFixed(0)}KB`);
  }
  // 退役产物清理。
  //   1) china_decorative.geojson：装饰面已并入地级拓扑，运行时不再单独加载。
  //   2) china_provinces_{ultra,pro,plus}.geojson：省级各档曾短暂以 GeoJSON 输出，现改回 TopoJSON
  //      （同顶点数下小 78%~84%，plus 档 1087KB → 174KB）。旧文件留着只会浪费带宽，删掉。
  //      注意 china_provinces.geojson 与 china_provinces_coarse.geojson **不删**：它们是
  //      历史文件名，仍由本脚本写入，服务「旧 index.html + 旧 hash bundle」的缓存用户。
  const stale = ['china_decorative.geojson', 'china_provinces_ultra.geojson', 'china_provinces_pro.geojson', 'china_provinces_plus.geojson'];
  for (const f of stale) {
    const p = path.join(OUT_DIR, f);
    if (fs.existsSync(p)) { fs.unlinkSync(p); console.log(`  已删除退役产物 ${f}`); }
  }
}

run().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
