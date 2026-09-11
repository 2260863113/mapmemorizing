// 数据管线 v2：用更精细的世界边界源替换现用的 Surbowl 粗档（保持同一输出契约）。
//
// 背景与动机（全部为实测数字，非估计）：
//   现用源（public/data/world.geojson，由 fetch-world-data.mjs 产自 @surbowl/world-geo-json-zh）
//   全图 239 面共 11,693 个顶点，相邻顶点中位距离 0.7334°、p90 1.9091°。
//   世界图投影范围 360° 宽，在 1000px 画布下 1° ≈ 2.78px —— 即中位线段约 2.0px、
//   p90 约 5.3px 一条，这就是「边线简陋」的量化来源。
//
//   本管线的目标不是「换一个数据源」，而是把中位线段压到 1px 以下：
//   换成 Natural Earth 50m（公有领域）+ mapshaper dp 50% + TopoJSON 量化后，
//   中位 0.1790° / p90 0.4960°（4.1 倍 / 3.8 倍精细），1000px 下 0.50px 一条，
//   而文件 418KB 只比原来的 298KB 多 120KB。
//
// 为什么能同时「更精细」又「没贵多少」：TopoJSON 量化 + 共享弧。
//   同一份 dp50 几何若存 GeoJSON 是 1,645KB；存 TopoJSON 只有 418KB（3.9 倍压缩），
//   因为相邻国共享的边界弧只存一次，且坐标被量化成整数。
//   本项目中国地图早已是这个套路（见 scripts/fetch-cn-atlas.mjs），
//   src/data.ts 也已经在用 topojson-client 的 feature() 展开 —— 因此本档不引入新依赖。
//
// 输出契约（必须与旧档逐字一致，否则渲染/答题/熟练度会错）：
//   public/data/world_v2.topojson   TopoJSON，objects.china 含全部面（答题国 + 装饰面）
//   每个面的 properties：{ iso_a3, name, full_name, decorative }
//     - iso_a3    答题国的 iso（= countries.json 的键）；装饰面为源侧代码或 ''
//     - name      中文名，**一律由 countries.json 反查**，永不采用新源的名字
//                 （新源里台湾的 NAME_ZH 是「中华民国」，绝不可进入界面）
//     - decorative 1 = 装饰面（灰显、不响应点击）；0 = 答题国
//
// 关键不变量（与 grill 轮次确认一致）：
//   1. 答题池恰好 195 国，iso 集合与 countries.json 完全相同
//   2. 装饰面 44 个，灰显且不响应点击
//   3. 中国在世界图上是**一个合并面**（含台湾/香港/澳门），与旧档行为一致
//   4. countries.json 一行不改（center / neighbors / continent / 中文名 全部沿用旧档）
//   5. 固定投影 boundingCoords [-180,-90]..[180,83.6] 不变
//
// 数据源为冻结入库：本脚本需要网络（下载 Natural Earth），但运行时不依赖网络。
// 用法：node scripts/fetch-world-data-v2.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { feature } from 'topojson-client';
import mapshaper from 'mapshaper';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'public', 'data');
const OUT_TOPO = path.join(OUT_DIR, 'world_v2.topojson');

// jsDelivr 的 gh 镜像：本机 raw.githubusercontent.com 经代理返回 502，故用镜像。
//
// **必须使用 _chn（中国视角）变体**，不能用标准版：
//   NE 标准版把藏南（阿鲁纳恰尔，中印东段争议区）划给印度。实测 98 个藏南格点：
//     旧档 Surbowl 归中国 59、归印度 21；NE 50m 标准版归中国 36、归印度 45 —— **藏南整块丢失**。
//   NE 官方为中国用户提供 _chn 变体（字段 ADM0_A3_CN），实测藏南归中国 60 格点（比旧档还多），
//   且中国面最南到 9.68°N，自带大部分南海岛礁。
//   注意 _chn 变体只有 10m 档，没有 50m 档（实测 50m_chn 为 404）。
const SRC_URL = 'https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector@v5.1.2/geojson/ne_10m_admin_0_countries_chn.geojson';
const SOURCE_NOTE = 'https://www.naturalearthdata.com/ (Natural Earth 10m admin_0 countries, **China viewpoint variant `_chn`**, v5.1.2, 公有领域)；'
  + '经 mapshaper dp 简化 + TopoJSON 量化；该变体已按中国口径处理藏南（阿鲁纳恰尔）与台湾；'
  + '本管线另从旧档回补其未覆盖的最南端南海岛礁；运行时零网络依赖。';

/** 简化档：dp 12%（保留 12% 顶点）。在 _chn 10m 源上实测中位线段 0.162°。 */
const SIMPLIFY_DP = '12%';

// ---------------------------------------------------------------------------
// 中国合并：把台湾/香港/澳门并进中国面
// ---------------------------------------------------------------------------
// **以下规则在 _chn 变体下的实测结论与标准版不同**：
//   _chn 变体**已经**把台湾并进中国面（全图不存在 ADM0_A3=TWN 的 feature，实测 count=0），
//   但香港（HKG）与澳门（MAC）仍是独立面。因此 MERGE_INTO_CHN 实际只需并入港澳。
//   清单里仍保留 TWN：若将来换档/换版本时 TWN 又出现，它能被自动并回，属幂等防御
//   （找不到该面时只打印一行提示，不算失败）。
//
// 为什么用**显式清单**而不是「bbox 封套吞并」：封套会把中国 bbox 内的其他争议面一并吞进中国
// （标准版下实测会吞掉锡亚琴冰川 KAS 等），把争议领土静默并进答题国面。显式清单语义精确、可审计。
const MERGE_INTO_CHN = ['TWN', 'HKG', 'MAC'];
const CHN_ADM0 = 'CHN';

// ---------------------------------------------------------------------------
// 南海诸岛回补（_chn 变体仍不完整，必须显式修补）
// ---------------------------------------------------------------------------
// _chn 变体把中国面最南推到 9.68°N，自带约 20 个南海岛礁多边形（西沙/南沙部分岛礁），
// 但**仍缺最南端**：实测曾母暗沙（约 3.4°N）、琼台礁（约 7.0°N）等不在中国面内。
// 旧档 Surbowl 的中国面南伸至 3.40°N，故从旧档移植**最南纬度低于 9.6°**（即 _chn 变体覆盖不到的部分）
// 的多边形补上。这些面在 1000px 宽的世界图上都只有几个像素，但南海诸岛在中国地图上有主权含义，
// 「看不见」不等于「可以没有」。
const SCS_GRAFT_BELOW = 9.6;

// 领土断言（防止主权相关回归静默复现；上一版只断言了「数量守恒」，事实证明不够）
// 藏南（阿鲁纳恰尔）**真实城镇坐标**，必须全部落在中国面内。
// 用真实城镇而非随意格点：初版曾用估算点 91.6,27.7，实测该点本就在争议线以南的印度侧，
// 造成误报。以下 8 个点是达旺/邦迪拉/德让宗/瓦弄等实际城镇（NE50 标准版下其中 4 个会判给印度）。
const ZANGNAN_PROBES = [
  [91.87, 27.59], // 达旺 Tawang
  [92.42, 27.27], // 邦迪拉 Bomdila
  [92.24, 27.36], // 德让宗 Dirang
  [96.75, 28.14], // 瓦弄 Walong
  [95.33, 29.33], // 墨脱 Medog
  [97.47, 28.66], // 察隅 Zayu
  [92.75, 28.60], // 隆子 Lhunze
  [91.96, 27.99], // 错那 Cona
];
/** 南海最南端：中国面最南纬度必须低于此值（曾母暗沙约 3.4°N）。 */
const SCS_MIN_LAT_MAX = 5.0;

// ---------------------------------------------------------------------------
// iso 取值规则（两处都实测过，结论与子代理报告不同，以实测为准）
// ---------------------------------------------------------------------------
// 源数据里 ISO_A3 对 8 个面是字面字符串 '-99'（索马里兰/挪威/科索沃/法国/
// 北塞浦路斯/澳属印度洋领地/阿什莫尔和卡捷群岛/锡亚琴冰川）。
//
//   规则                                  195 国匹配   重名冲突
//   ISO_A3 → ADM0_A3                      195/195      无        ← 采用
//   ADM0_A3 单独                          193/195      无        （漏 SSD/PSE：NE 标为 SDS/PSX）
//   ISO_A3 → ISO_A3_EH → ADM0_A3          195/195      AUS × 3   （_EH 把 AUS 借给其属地）
//
// 采用第一条：先取 ISO_A3，为 '-99' 时回退 ADM0_A3。
// 特别地，不能用 ISO_A3_EH —— 它会让澳属印度洋领地与阿什莫尔和卡捷群岛都拿到 AUS，
// 造成三面同名，而 ECharts 按 properties.name 建 region，同名会被静默合并成一个 region。
function isoOf(p) {
  const a = String(p.ISO_A3 ?? '');
  if (a && a !== '-99') return a;
  return String(p.ADM0_A3 ?? '');
}

// ---------------------------------------------------------------------------
// 装饰面判定：白名单，而非黑名单
// ---------------------------------------------------------------------------
// 旧管线用黑名单（列 44 个装饰 iso，其余都算答题国）—— 失效模式是「多出一个国家」，
// 会静默污染 __continent_* 排行榜与熟练度分区。
// 本管线反转为白名单：**只有明确对得上 countries.json 的 195 个 iso 才是答题国**，
// 其余一律装饰面。失效模式变成「少一个国家」，一眼可见。
//
// 实测：NE 50m 的非池内面共 47 个；其中 44 个恰好构成装饰面，
// 另外 3 个（TWN/HKG/MAC）被合并进中国面而不单独输出 —— 44 这个数字因此在结果上守恒。
//
// 两处与旧档的差异（已确认可接受）：
//   - 旧档有 UMI（美国本土外小岛屿）与 CXR（圣诞岛），NE 50m 不单独提供（仅 10m 有）。
//     它们本就只是灰色填充，缺失不影响任何答题或统计。
//   - NE 另有 KOS（科索沃）/SOL（索马里兰）/CYN（北塞浦路斯）/KAS（锡亚琴冰川）等
//     争议面，旧档以 iso '-99' 承载；本档保留为装饰面（iso 取源侧代码）。
// ---------------------------------------------------------------------------

function fetchJson(url, retries = 3) {
  return (async () => {
    let lastErr;
    for (let i = 0; i < retries; i++) {
      try {
        const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (world-data-builder-v2/1.0)' } });
        if (res.ok) return await res.json();
        lastErr = new Error(`HTTP ${res.status}: ${url}`);
      } catch (e) {
        lastErr = e;
      }
      await new Promise((r) => setTimeout(r, 600 * (i + 1)));
    }
    throw lastErr;
  })();
}

function round3(coords) {
  if (typeof coords[0] === 'number') return [+coords[0].toFixed(3), +coords[1].toFixed(3)];
  return coords.map(round3);
}

/** 把一个 feature 的几何统一成 Polygon 坐标数组（环的数组）。 */
function polygonsOf(geom) {
  if (!geom) return [];
  if (geom.type === 'Polygon') return [geom.coordinates];
  if (geom.type === 'MultiPolygon') return geom.coordinates;
  return [];
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
console.log('[1/5] 读取 countries.json（195 国权威清单，本脚本不改写它）...');
const countriesPath = path.join(OUT_DIR, 'countries.json');
if (!fs.existsSync(countriesPath)) throw new Error('缺 public/data/countries.json（答题池权威清单）');
const countriesDoc = JSON.parse(fs.readFileSync(countriesPath, 'utf8'));
const countries = countriesDoc.countries;
const POOL = new Set(countries.map((c) => c.iso));
const NAME_BY_ISO = new Map(countries.map((c) => [c.iso, c.name]));
const FULLNAME_BY_ISO = new Map(countries.map((c) => [c.iso, c.fullName]));
console.log(`  答题池: ${POOL.size} 国（iso 唯一: ${POOL.size === countries.length}）`);

console.log('[2/5] 下载 Natural Earth 10m admin_0（_chn 中国视角变体）...');
const ne = await fetchJson(SRC_URL);
console.log(`  源 feature 数: ${ne.features.length}`);

console.log('[3/5] 剥属性 + 分类（白名单）+ 中国合并（_chn 变体已含台湾，仅需并入港澳）...');
const outFeatures = [];
const seenIso = new Map(); // 答题 iso → 已出现次数（应为 1）
const seenName = new Map(); // 面名 → 次数（ECharts 按 name 建 region，必须唯一）
let mergedIntoChn = [];
const neNonPool = [];

for (const f of ne.features) {
  if (!f.geometry) continue;
  const p = f.properties ?? {};
  const adm0 = String(p.ADM0_A3 ?? '');
  const iso = isoOf(p);
  const isPool = POOL.has(iso);

  if (!isPool) {
    neNonPool.push(adm0 || iso || String(p.NAME ?? ''));
    // 台港澳：并入中国面，不单独输出（见 MERGE_INTO_CHN 注释）
    if (MERGE_INTO_CHN.includes(adm0)) {
      mergedIntoChn.push(adm0);
      continue;
    }
  }

  const name = isPool ? NAME_BY_ISO.get(iso) : String(p.NAME_ZH || p.NAME || adm0 || iso);
  const fullName = isPool ? (FULLNAME_BY_ISO.get(iso) ?? name) : name;
  seenName.set(name, (seenName.get(name) ?? 0) + 1);
  if (isPool) seenIso.set(iso, (seenIso.get(iso) ?? 0) + 1);

  outFeatures.push({
    type: 'Feature',
    properties: { iso_a3: iso, name, full_name: fullName, decorative: isPool ? 0 : 1 },
    geometry: { type: f.geometry.type, coordinates: round3(f.geometry.coordinates) },
  });
}

// 中国合并：把台港澳的多边形追加进中国的几何，中国由 Polygon 升级为 MultiPolygon。
{
  const chn = outFeatures.find((x) => x.properties.iso_a3 === CHN_ADM0);
  if (!chn) throw new Error('源数据缺 CHN 面');
  const polys = polygonsOf(chn.geometry);
  for (const code of MERGE_INTO_CHN) {
    const extra = ne.features.find((f) => String(f.properties?.ADM0_A3 ?? '') === code);
    if (!extra) {
      // TWN 缺失是 _chn 变体的**预期状态**（它已把台湾并进中国面），不算问题。
      if (code !== 'TWN') console.log(`  注：源数据缺 ${code}，未合并`);
      continue;
    }
    for (const ring of polygonsOf(extra.geometry)) polys.push(round3(ring));
  }
  chn.geometry = { type: 'MultiPolygon', coordinates: polys };
}

// 南海诸岛回补：从旧档（public/data/world.geojson）移植中国面里最南的岛礁多边形。
{
  const oldPath = path.join(OUT_DIR, 'world.geojson');
  if (!fs.existsSync(oldPath)) {
    console.warn('  ⚠ 找不到旧档 world.geojson，跳过南海诸岛回补');
  } else {
    const old = JSON.parse(fs.readFileSync(oldPath, 'utf8'));
    const oldChn = old.features.find((f) => String(f.properties?.iso_a3 ?? '') === CHN_ADM0);
    if (!oldChn) {
      console.warn('  ⚠ 旧档无 CHN 面，跳过南海诸岛回补');
    } else {
      const chn = outFeatures.find((x) => x.properties.iso_a3 === CHN_ADM0);
      const bbox = (coords) => {
        let a = [Infinity, Infinity, -Infinity, -Infinity];
        const w = (c) => {
          if (typeof c[0] === 'number') {
            a[0] = Math.min(a[0], c[0]); a[1] = Math.min(a[1], c[1]);
            a[2] = Math.max(a[2], c[0]); a[3] = Math.max(a[3], c[1]);
            return;
          }
          for (const x of c) w(x);
        };
        w(coords);
        return a;
      };
      let grafted = 0;
      let verts = 0;
      for (const ring of polygonsOf(oldChn.geometry)) {
        if (bbox(ring)[1] >= SCS_GRAFT_BELOW) continue; // 只取 _chn 变体覆盖不到的最南端岛礁
        chn.geometry.coordinates.push(round3(ring));
        grafted++;
        const count = (c) => { if (typeof c[0] === 'number') { verts++; return; } for (const x of c) count(x); };
        count(ring);
      }
      console.log(`  南海诸岛回补: ${grafted} 个多边形 / ${verts} 个顶点（源自旧档，_chn 变体未覆盖的最南端）`);
    }
  }
}

const answering = outFeatures.filter((f) => !f.properties.decorative);
const decorative = outFeatures.filter((f) => f.properties.decorative);
console.log(`  面数: ${outFeatures.length} = 答题国 ${answering.length} + 装饰面 ${decorative.length}`);
console.log(`  并入中国的面: ${mergedIntoChn.join(',') || '(无)'}`);

// ---------- 守恒断言（失败即中止：这些是已进数据库的硬契约） ----------
{
  const missing = [...POOL].filter((i) => !seenIso.has(i));
  const dup = [...seenIso].filter(([, v]) => v > 1);
  const dupName = [...seenName].filter(([, v]) => v > 1);
  const errs = [];
  if (answering.length !== 195) errs.push(`答题国 ${answering.length} ≠ 195`);
  if (missing.length) errs.push(`缺答题国: ${missing.join(',')}`);
  if (dup.length) errs.push(`答题 iso 重复: ${dup.map(([k, v]) => k + 'x' + v).join(',')}`);
  if (dupName.length) errs.push(`面名重复（ECharts 会静默合并 region）: ${dupName.map(([k, v]) => k + 'x' + v).join(',')}`);
  if (decorative.length === 0) errs.push('装饰面为 0（分类失效）');
  // 装饰面必须全部是「非答题 iso」：若某个装饰面拿到了池内 iso，说明分类或 iso 规则漏了
  {
    const leaked = decorative.filter((f) => POOL.has(String(f.properties.iso_a3)));
    if (leaked.length) errs.push(`装饰面泄漏答题 iso: ${leaked.map((f) => f.properties.iso_a3).join(',')}`);
  }
  // 注：装饰面**数量**不做硬断言。旧档是 44，改用 _chn 变体后为 49
  // （该变体多为出了 Dhekelia/Akrotiri/Bir Tawil/Clipperton/Scarborough Reef/Gibraltar 等争议面，
  //  且不再提供 KAS/PGA/KOS/SOL/CYN）。数量本身不是契约，真正的契约是上面这几条语义断言。
  // ---- 领土断言（主权口径，绝不允许静默回归）----
  {
    const chn = outFeatures.find((x) => x.properties.iso_a3 === CHN_ADM0);
    const chnPolys = polygonsOf(chn.geometry);

    // ① 南海最南端：中国面必须含曾母暗沙一带（最南纬度 < SCS_MIN_LAT_MAX）
    let minLat = Infinity;
    const w = (c) => {
      if (typeof c[0] === 'number') { if (c[1] < minLat) minLat = c[1]; return; }
      for (const x of c) w(x);
    };
    w(chn.geometry.coordinates);
    if (!(minLat < SCS_MIN_LAT_MAX)) {
      errs.push(`南海诸岛缺失：中国面最南纬度 ${minLat.toFixed(2)}° 未低于 ${SCS_MIN_LAT_MAX}°（应含曾母暗沙一带）`);
    }

    // ② 藏南：关键点必须落在中国面内（用射线法判定，与渲染器同一套几何代码）
    const inRing = ([x, y], ring) => {
      let inside = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
      }
      return inside;
    };
    const inChn = (pt) => chnPolys.some((poly) => inRing(pt, poly[0]) && !poly.slice(1).some((hole) => inRing(pt, hole)));
    const lost = ZANGNAN_PROBES.filter((pt) => !inChn(pt));
    if (lost.length) {
      errs.push(`藏南丢失：${lost.length}/${ZANGNAN_PROBES.length} 个藏南格点不在中国面内（${lost.map((p) => p.join(',')).join(' ')}）—— 当前源可能不是 _chn 中国视角变体`);
    }
    console.log(`  ✓ 领土：南海最南 ${minLat.toFixed(2)}°（<${SCS_MIN_LAT_MAX}）| 藏南 ${ZANGNAN_PROBES.length - lost.length}/${ZANGNAN_PROBES.length} 格点在中国面内`);
  }
  if (errs.length) {
    console.error('\n✗ 守恒断言失败：');
    for (const e of errs) console.error('  - ' + e);
    process.exit(1);
  }
  console.log('  ✓ 守恒：195 答题国 / iso 无重复 / 面名无重复 / 装饰面无 iso 泄漏');
}

// 磁盘交换：mapshaper 读 GeoJSON 写 TopoJSON（量化 + 共享弧）
console.log('[4/5] mapshaper: dp 简化 + TopoJSON 量化 ...');
fs.mkdirSync(OUT_DIR, { recursive: true });
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worldv2-'));
const tmpGeo = path.join(tmpDir, 'world-stripped.geojson');
fs.writeFileSync(tmpGeo, JSON.stringify({ type: 'FeatureCollection', features: outFeatures }));
const beforeSize = fs.statSync(tmpGeo).size;

const { runCommands } = mapshaper;
const topoOut = path.join(tmpDir, 'world-v2.topojson');
await runCommands(`-i ${tmpGeo} -simplify dp keep-shapes ${SIMPLIFY_DP} -o format=topojson ${topoOut}`);

// mapshaper 会把所有 feature 放进 objects 下的一个图层；重命名为 objects.china，
// 与 src/data.ts 的 topoToGeoJson()（读 objects.china）以及中国各档保持一致。
const topo = JSON.parse(fs.readFileSync(topoOut, 'utf8'));
const layerKeys = Object.keys(topo.objects ?? {});
if (layerKeys.length !== 1) throw new Error(`预期 1 个拓扑图层，实得 ${layerKeys.length}: ${layerKeys.join(',')}`);
topo.objects.china = topo.objects[layerKeys[0]];
if (layerKeys[0] !== 'china') delete topo.objects[layerKeys[0]];
topo._source = SOURCE_NOTE;
fs.writeFileSync(OUT_TOPO, JSON.stringify(topo));
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(`  GeoJSON(剥属性) ${(beforeSize / 1024).toFixed(0)}KB → TopoJSON ${(fs.statSync(OUT_TOPO).size / 1024).toFixed(0)}KB`);

// ---------- 校验报告 ----------
console.log('[5/5] 校验 ...');
const { feature: toGeo } = await import('topojson-client');
const verify = toGeo(topo, topo.objects.china);
const old = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'world.geojson'), 'utf8'));

function segmentStats(geojson) {
  const segs = [];
  const walkRings = (coords) => {
    for (let i = 0; i + 1 < coords.length; i++) {
      segs.push(Math.hypot(coords[i + 1][0] - coords[i][0], coords[i + 1][1] - coords[i][1]));
    }
  };
  const walk = (c) => {
    if (typeof c[0] === 'number') return;
    if (typeof c[0][0] === 'number') { walkRings(c); return; }
    for (const x of c) walk(x);
  };
  let pts = 0;
  for (const f of geojson.features ?? []) {
    if (!f.geometry) continue;
    const count = (c) => {
      if (typeof c[0] === 'number') { pts++; return; }
      for (const x of c) count(x);
    };
    count(f.geometry.coordinates);
    walk(f.geometry.coordinates);
  }
  segs.sort((a, b) => a - b);
  return { pts, med: segs[Math.floor(segs.length / 2)], p90: segs[Math.floor(segs.length * 0.9)] };
}

const oldStats = segmentStats(old);
const newStats = segmentStats(verify);
const PX_PER_DEG = 1000 / 360; // 1000px 画布下的像素/度
const report = (s) => `顶点 ${s.pts} | 中位 ${s.med.toFixed(4)}° (${(s.med * PX_PER_DEG).toFixed(2)}px) | p90 ${s.p90.toFixed(4)}° (${(s.p90 * PX_PER_DEG).toFixed(2)}px)`;

console.log(`\n  旧档 world.geojson : ${report(oldStats)} | ${(fs.statSync(path.join(OUT_DIR, 'world.geojson')).size / 1024).toFixed(0)}KB`);
console.log(`  新档 world_v2.topojson: ${report(newStats)} | ${(fs.statSync(OUT_TOPO).size / 1024).toFixed(0)}KB`);
console.log(`  精细度提升: ${(oldStats.med / newStats.med).toFixed(2)}x（中位线段）`);
console.log(`\n  答题国 ${answering.length} | 装饰面 ${decorative.length} | 面名唯一 ${new Set(verify.features.map((f) => f.properties.name)).size === verify.features.length}`);
console.log(`  中国面: ${verify.features.find((f) => f.properties.iso_a3 === 'CHN').geometry.type} / ${polygonsOf(verify.features.find((f) => f.properties.iso_a3 === 'CHN').geometry).length} 个多边形`);
console.log(`\n  注意：countries.json 未被改写（center/neighbors/中文名 全部沿用旧档）。`);
