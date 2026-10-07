// 「其他国家一级行政区」题库的数据管线（2026-10）。
//
// ## 这是什么
//
// 输入/点击模式的「其他」分段要考**美国 / 加拿大 / 日本 / 俄罗斯**的一级行政区
// （对应中国的省级）。本脚本把 Natural Earth 的 admin-1（一级行政区）数据切成四份入库：
//
//   public/data/other/index.json          四国清单 + 语言 + 计数（启动时加载，很小）
//   public/data/other/<cc>.topojson       该国全部一级行政区几何（**按需加载**，切到才拉）
//   public/data/other/<cc>.units.json     该国的题池元数据（名称/相邻/质心/面积/飞地/不考标记）
//
// ## 为什么单独一套数据，而不是塞进现有的世界/中国档
//
// 现有三档粒度（世界=194 国、省级=34 省、地级=373 市）各自有自己的一套投影、题池、
// 相邻关系与熟练度分区。一级行政区是**第四类几何**：它是"某个国家内部的省级"，既要按国家
// 单独投影（否则一个州的面积/位置毫无意义），又要有自己的一套相邻关系（顺序出题要用）。
// 塞进世界档会让"世界图"的概念被污染（世界图是国与国，不是国内部）。
//
// ## 数据源与口径
//
//   Natural Earth 10m admin_1_states_provinces（公有领域，v5.1.2）—— 与现有世界图同源同版本。
//   **不做 _chn 变体**：那份是国家级主权的中国视角变体，对"他国内部行政区"没有对应物；
//   本档只取 USA/CAN/JPN/RUS 四国的面，中国的面一条都不取，故不涉及中国领土口径。
//
//   为什么不用 50m 档（只有 657KB，更省）：**实测 50m 档完全没有日本**（JPN=0 个面），
//   且 50m 是为全球视野简化的，单独一个国家铺满一屏时边线明显发毛。
//   10m 档 38.8MB 只需下载一次，简化后每国几百 KB。
//
//   下载：raw.githubusercontent.com（实测可用）。**jsDelivr 对本文件返回 429**（大文件限流），
//   官方后备是 https://naciscdn.org/naturalearth/10m/cultural/ne_10m_admin_1_states_provinces.zip
//   （14.9MB，实测 200，含 shapefile，mapshaper 可直接读）。
//
// ## 已知的源数据问题（都在下面的兜底表里逐条修掉，不再依赖人工记忆）
//
//   1. **RU-X01~**：一条属性全空（无名称/无 iso）的垃圾面，直接丢弃。
//   2. **中文重名**：NE 把 RU-AL（阿尔泰共和国）与 RU-ALT（阿尔泰边疆区）都写成「阿尔泰共和国」，
//      题池里重名会让判题无法区分 —— 必须在库里唯一。
//   3. **中文名互换**：RU-MOW（莫斯科市）被写成「莫斯科州」、RU-MOS（莫斯科州）被写成「莫斯科」。
//   4. **繁体残留**：RU-KAM「堪察加邊疆區」、RU-IRK「伊爾庫茨克州」。
//   5. **缺后缀**：JP-13 只写「东京」（其余 46 个都带 县/府/都/道）。
//   6. **当地语言名缺失**：日本 1 条、俄罗斯 5 条（含两条争议地区），按 name_ru / name_ja 兜底。
//
// ## 用法（需要网络；运行时不依赖网络）
//
//   node scripts/fetch-other-admin1.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import mapshaper from 'mapshaper';
import { feature as toFeature } from 'topojson-client';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'public', 'data', 'other');
const SRC_URL =
  'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_10m_admin_1_states_provinces.geojson';
const SOURCE_NOTE =
  'Natural Earth v5.1.2 admin_1_states_provinces（10m，公有领域，https://www.naturalearthdata.com/）；'
  + '仅取 USA/CAN/JPN/RUS 四国一级行政区，经 mapshaper dp 简化 + TopoJSON 量化；'
  + '中文名取源数据 name_zh 并修正其中 5 处错误（重名/互换/繁体，见脚本兜底表）；'
  + '当地语言名：美加=英语 name，日本=name_local||name_ja，俄罗斯=name_local||name_ru；运行时零网络依赖。';

/**
 * 四国配置。
 *
 * `lang` 是"当地语言"这一档的标识与按钮文案（用户口径：美国加拿大英语、日本日语、俄罗斯俄语）。
 * 用户口径（2026-10 二次确认）：**不要左下角小窗**，飞地也直接在主图上点。
 * 故 `insetGroups` 一律为空 —— 主图包围盒取**全部单位**的并集（含阿拉斯加/夏威夷/加里宁格勒），
 * 这样它们就在主图的投影范围内、可以直接点到。保留这个配置项是因为"哪些算飞地"仍是数据事实，
 * 将来若要恢复小窗只需在此填回清单。
 */
const COUNTRIES = [
  {
    cc: 'usa', a3: 'USA', name: '美国', lang: { id: 'en', label: '英语' },
    simplify: '30%', insetGroups: [],
  },
  {
    cc: 'can', a3: 'CAN', name: '加拿大', lang: { id: 'en', label: '英语' },
    simplify: '30%', insetGroups: [],
  },
  {
    cc: 'jpn', a3: 'JPN', name: '日本', lang: { id: 'ja', label: '日语' },
    simplify: '45%', insetGroups: [],
  },
  {
    cc: 'rus', a3: 'RUS', name: '俄罗斯', lang: { id: 'ru', label: '俄语' },
    simplify: '22%', insetGroups: [],
  },
];

/** 中文名兜底：源数据里明确错误的条目（键为 iso_3166_2）。每条都注明为什么。 */
const ZH_OVERRIDES = {
  'RU-ALT': '阿尔泰边疆区', // 源里与 RU-AL（阿尔泰共和国）重名
  'RU-KAM': '堪察加边疆区', // 源里是繁体「堪察加邊疆區」
  'RU-IRK': '伊尔库茨克州', // 源里是繁体「伊爾庫茨克州」
  'JP-13': '东京都',        // 其余 46 个都带 县/府/都/道，只有它缺
};

/**
 * **编码互换**：源数据里 `iso_3166_2` 与几何对不上的条目（键 = 源编码，值 = 正确编码）。
 *
 * 实测：NE 的 `RU-MOW` 那块几何是**莫斯科州**（name=Moskovskaya，包围盒 35.2–40.2°E，是大块），
 * 而 `RU-MOS` 那块才是**莫斯科市**（name=Moskva，包围盒 36.9–37.9°E，是小块）——
 * 与 ISO 3166-2:RU 恰好相反（ISO：MOW=市、MOS=州）。
 *
 * 为什么必须换编码而不是只改名字：编码是这道题的**身份**（深浅链接、错题清单、后续统计都按它走），
 * 名字只是显示。只改名字的结果是"大块州几何挂着『莫斯科』、小块市几何挂着『莫斯科州』"——
 * 地图与答案全反。第一版就是这么改的，靠"州/市的包围盒与名字对不上"才发现。
 *
 * 两个键**同时**映射（读的都是原始值），所以互换安全。
 */
const CODE_SWAP = {
  'RU-MOW': 'RU-MOS',
  'RU-MOS': 'RU-MOW',
};

/**
 * 当地语言名兜底（键为**最终**编码）。
 *
 * 实测源数据里 `name_ru` 与 `name_local` **各有一条是错的**，而且正确值都在"另一个字段"里：
 *   · RU-ARK：`name_local` 被写成「Вологодская область」（沃洛格达州的名字），
 *             `name_ru` 是对的（Архангельская область）；
 *   · RU-ALT：`name_ru` 被写成「Республика Алтай」（阿尔泰共和国的名字），
 *             `name_local` 是对的（Алтайский край）。
 * 所以没法"统一优先某个字段"——只能逐条钉住。**每条都要写清来源**，
 * 下一个人才知道这不是随手抄的，而是取自另一个字段的正确值。
 */
const LOCAL_OVERRIDES = {
  'RU-ARK': 'Архангельская область', // 取自 name_ru（name_local 错配成沃洛格达州）
  'RU-ALT': 'Алтайский край',        // 取自 name_local（name_ru 错配成阿尔泰共和国）
};

/**
 * 不考但显示的面（用户口径：争议地区"不考但显示"）。
 * 它们在题池之外，但几何照画（灰显、不可点、不判题），与现有"装饰面"同一套处理。
 */
const DECORATIVE = ['UA-40', 'UA-43'];

/**
 * 直接丢弃的面：**属性全空的合成残留**。
 *
 * `RU-X01~` 在源数据里没有任何名称（name / name_zh / name_local 全为 null）、没有 type_en，
 * 只有一个合成编码 —— 是一条无名多边形残留，进题池就是一道无解的题。
 * 用显式编码清单而不是"名字为空就丢"：后者会连将来可能出现的、确实缺名字但**有**身份的面一起吞掉；
 * 脚本会把它连同包围盒一起打印出来，便于审计"丢的到底是什么"（本轮实测它在俄罗斯境内、
 * 与任何联邦主体都不相接，确属残留）。
 */
const DROP_CODES = ['RU-X01~'];

// ---------------------------------------------------------------------------
// 下载（带缓存：38.8MB，只在首次或缓存缺失时拉）
// ---------------------------------------------------------------------------
async function loadSource() {
  const cache = path.join(os.tmpdir(), 'ne-admin1', 'admin1-10m.geojson');
  if (fs.existsSync(cache) && fs.statSync(cache).size > 1_000_000) {
    console.log(`[1/6] 用缓存 ${cache}`);
    return JSON.parse(fs.readFileSync(cache, 'utf8'));
  }
  console.log('[1/6] 下载 Natural Earth 10m admin-1（38.8MB）…');
  const res = await fetch(SRC_URL);
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}（jsDelivr 会 429，请用 NACIS zip 后备）`);
  const text = await res.text();
  if (!text.trimStart().startsWith('{')) throw new Error(`下载内容不是 GeoJSON：${text.slice(0, 80)}`);
  fs.mkdirSync(path.dirname(cache), { recursive: true });
  fs.writeFileSync(cache, text);
  return JSON.parse(text);
}

// ---------------------------------------------------------------------------
// 几何工具（与 scripts/fetch-world-data-v2.mjs 同一手法：经纬度平面上的 shoelace 面积）
// ---------------------------------------------------------------------------
function ringArea(ring) {
  let s = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % n];
    s += x1 * y2 - x2 * y1;
  }
  return Math.abs(s / 2);
}

/** 环列表 → 度² 面积（外环减内环，按有向面积符号判定；不做球面校正 —— 只用于相对比较）。 */
function polygonsArea(polygons) {
  let total = 0;
  for (const poly of polygons) {
    poly.forEach((ring, i) => {
      const a = ringArea(ring);
      total += i === 0 ? a : -a;
    });
  }
  return Math.abs(total);
}

/** GeoJSON geometry → 多边形数组（统一 Polygon / MultiPolygon / GeometryCollection）。 */
function polygonsOf(geom) {
  if (!geom) return [];
  if (geom.type === 'Polygon') return [geom.coordinates];
  if (geom.type === 'MultiPolygon') return geom.coordinates;
  if (geom.type === 'GeometryCollection') return geom.geometries.flatMap(polygonsOf);
  return [];
}

/**
 * **经度解缠**（按国家做一次，不是按单位各做一次）。
 *
 * 为什么必须做：地图坐标系是平面经纬度，一个跨 180° 经线的单位（俄罗斯楚科奇、
 * 阿拉斯加阿留申群岛）在源数据里一半点在 +179、一半点在 −179，直接算包围盒会得到
 * 「西边界 −179、东边界 +179」——铺满整个地球宽度，投影后这个单位被拉成一条横贯全图的细带，
 * 质心也会跑到地球另一边（实测阿拉斯加的平面质心落在 (−154.7, 32.5)，纬度整整偏南 30°）。
 *
 * ⚠ **两个必须同时满足的条件**（第一版就是漏了这两点才把拓扑搞坏：孤立单位从 2 个暴涨到 33 个）：
 *
 *   1. 参考经度**按国家算一次**（取面积最大单位的最大环质心）。若逐单位各算一次，
 *      同一段公共边界在两个单位里会被折算出不同的浮点尾数，mapshaper 就认不出它是同一条弧
 *      —— 拓扑一旦丢失，相邻关系全没了，简化还会在边界上留下裂缝。
 *   2. 只对**真正需要平移**的点加 **360 的整数倍**；不需要平移的点原样返回（逐位不变）。
 *      整数倍 360 对同一个源坐标在任何单位里都是同一个值，公共顶点因此保持逐位一致。
 */
function unwrapCountry(features) {
  // 参考经度：面积最大单位的最大环质心（用未平移的原始坐标算，平移不改变相对几何）
  let ref = 0;
  let bestArea = -1;
  for (const f of features) {
    for (const poly of polygonsOf(f.geometry)) {
      for (const ring of poly) {
        const a = ringArea(ring);
        if (a > bestArea) {
          bestArea = a;
          ref = centroidOf([[ring]])[0];
        }
      }
    }
  }
  for (const f of features) {
    f.geometry = {
      type: 'MultiPolygon',
      coordinates: polygonsOf(f.geometry).map((poly) => poly.map((ring) => ring.map(([x, y]) => {
        const k = Math.round((ref - x) / 360);
        return k === 0 ? [x, y] : [x + 360 * k, y];
      }))),
    };
  }
  return ref;
}

/** 丢弃的垃圾面 / 不考的面 / 兜底名 都以**最终编码**为准（见 CODE_SWAP）。 */
function finalCode(rawCode) {
  return CODE_SWAP[rawCode] ?? rawCode;
}

/**
 * 挑「当地语言」的名字。
 *
 * 俄罗斯用 `name_ru` 而不是 `name_local`：实测源数据的 `name_local` 有错配 ——
 * `RU-ARK`（阿尔汉格尔斯克州）的当地名被写成「Вологодская область」（那是沃洛格达州的名字），
 * 换完编码后仍会与 RU-VLG 重名。而 `name_ru` 与该几何一致，且 83 个题池单位全部非空。
 */
function pickLocal(langId, p) {
  if (langId === 'en') return p.name;
  if (langId === 'ja') return p.name_local || p.name_ja || p.name;
  return p.name_ru || p.name_local || p.name;
}

function bboxOf(polygons) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const poly of polygons) {
    for (const ring of poly) {
      for (const [x, y] of ring) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  return [minX, minY, maxX, maxY];
}

/** 面积加权质心（外环质心按面积加权）——标签锚点用，比 bbox 中心更贴合形状。 */
function centroidOf(polygons) {
  let sx = 0, sy = 0, sa = 0;
  for (const poly of polygons) {
    const ring = poly[0];
    if (!ring) continue;
    let a = 0, cx = 0, cy = 0;
    for (let i = 0, n = ring.length; i < n; i++) {
      const [x1, y1] = ring[i];
      const [x2, y2] = ring[(i + 1) % n];
      const cross = x1 * y2 - x2 * y1;
      a += cross;
      cx += (x1 + x2) * cross;
      cy += (y1 + y2) * cross;
    }
    a /= 2;
    if (a === 0) continue;
    cx /= 6 * a;
    cy /= 6 * a;
    sx += cx * Math.abs(a);
    sy += cy * Math.abs(a);
    sa += Math.abs(a);
  }
  if (sa === 0) {
    const [minX, minY, maxX, maxY] = bboxOf(polygons);
    return [(minX + maxX) / 2, (minY + maxY) / 2];
  }
  return [sx / sa, sy / sa];
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
const src = await loadSource();
const all = src.features;
console.log(`[2/6] 源共 ${all.length} 个面；抽取四国并清理 …`);

fs.mkdirSync(OUT_DIR, { recursive: true });
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'other-admin1-'));
const indexCountries = [];

for (const cfg of COUNTRIES) {
  // ---- 取面 + 清理 ----
  const raw = all.filter((f) => f.properties.adm0_a3 === cfg.a3);
  const dropped = [];
  const features = [];
  for (const f of raw) {
    // 编码先归一（源里有个别条目编码与几何对不上，见 CODE_SWAP 注释）
    const isoCode = finalCode(f.properties.iso_3166_2);
    if (!isoCode || DROP_CODES.includes(isoCode)) {
      dropped.push(`${isoCode ?? '(无编码)'} bbox=${JSON.stringify(bboxOf(polygonsOf(f.geometry)).map((v) => Number(v.toFixed(2))))}`);
      continue;
    }
    const zh = ZH_OVERRIDES[isoCode] ?? f.properties.name_zh;
    const local = LOCAL_OVERRIDES[isoCode] ?? pickLocal(cfg.lang.id, f.properties);
    if (!zh || !local) throw new Error(`${isoCode} 名称不全：zh=${zh} local=${local}`);
    const insetGroup = cfg.insetGroups.findIndex((codes) => codes.includes(isoCode));
    features.push({
      code: isoCode,
      zh,
      local,
      en: f.properties.name,
      decorative: DECORATIVE.includes(isoCode),
      inset: insetGroup >= 0,
      insetGroup: insetGroup >= 0 ? insetGroup : undefined,
      geometry: f.geometry,
    });
  }
  features.sort((a, b) => a.code.localeCompare(b.code));
  // 收集完再统一解缠（参考经度按国家算一次，见 unwrapCountry 的注释）
  unwrapCountry(features);

  // ---- 题池唯一性断言（源数据重名必须先被兜底表修掉）----
  const pool = features.filter((f) => !f.decorative);
  const zhNames = pool.map((f) => f.zh);
  const dupZh = zhNames.filter((v, i) => zhNames.indexOf(v) !== i);
  if (dupZh.length) throw new Error(`${cfg.name} 题池中文名重复：${[...new Set(dupZh)].join(', ')}（补 ZH_OVERRIDES）`);
  // 当地语言名同样必须唯一：切到「外语」档后，重名等于两道题答案一样（源数据里 RU-MOW/RU-MOS
  // 就是这种情况，靠这条断言抓出来才发现的）。
  const localNames = pool.map((f) => f.local);
  const dupLocal = localNames.filter((v, i) => localNames.indexOf(v) !== i);
  if (dupLocal.length) throw new Error(`${cfg.name} 题池当地名重复：${[...new Set(dupLocal)].join(', ')}（补 LOCAL_OVERRIDES）`);
  const codes = features.map((f) => f.code);
  const dupCode = codes.filter((v, i) => codes.indexOf(v) !== i);
  if (dupCode.length) throw new Error(`${cfg.name} 编码重复：${[...new Set(dupCode)].join(', ')}`);

  // ---- 磁盘交换给 mapshaper：简化 + 量化（与 world_v2 同一手法）----
  const tmpIn = path.join(tmpDir, `${cfg.cc}.geojson`);
  const tmpOut = path.join(tmpDir, `${cfg.cc}.topojson`);
  fs.writeFileSync(tmpIn, JSON.stringify({
    type: 'FeatureCollection',
    // 属性只带 code：几何文件只负责几何，事实（名称/相邻/面积）全在 units.json 里，
    // 免得同一件事有两个来源（改一个忘一个）。
    features: features.map((f) => ({ type: 'Feature', properties: { code: f.code }, geometry: f.geometry })),
  }));
  const { runCommands } = mapshaper;
  await runCommands(`-i ${tmpIn} -simplify dp keep-shapes ${cfg.simplify} -o format=topojson ${tmpOut}`);

  const topo = JSON.parse(fs.readFileSync(tmpOut, 'utf8'));
  const layerName = Object.keys(topo.objects)[0];
  const fc = topo.objects[layerName];
  const outTopo = {
    type: 'Topology',
    // 量化参数从 mapshaper 输出原样沿用（它就是 mapshaper 写出的 transform）
    transform: topo.transform,
    arcs: topo.arcs,
    objects: { [cfg.cc]: fc },
    bbox: topo.bbox,
  };
  fs.writeFileSync(path.join(OUT_DIR, `${cfg.cc}.topojson`), JSON.stringify(outTopo));

  // ---- 几何量：面积 / 包围盒 / 质心（都在**简化后 + 解缠后**的几何上算，与用户看到的一致）----
  // 展开必须用 topojson-client：TopoJSON 的 arc 是**差分编码**（每个点相对前一个点），
  // 手写展开漏掉累加就会得到完全错误的坐标 —— 本脚本第一版正是这么错的（阿拉斯加质心跑到
  // (−154.7, 32.5)）。这里不再自己造轮子，用项目既有依赖（与 fetch-world-data-v2.mjs 同一手法）。
  const expanded = toFeature(outTopo, outTopo.objects[cfg.cc]);
  const geoms = new Map(expanded.features.map((ft) => [ft.properties.code, polygonsOf(ft.geometry)]));

  // ---- 相邻关系：从 TopoJSON 的**共享弧索引**推（mapshaper 建过拓扑，共享边界就是同一条弧）----
  const arcOwner = new Map(); // 弧索引 → code 集合
  for (const g of fc.geometries) {
    for (const idx of arcsOf(g)) {
      const key = idx < 0 ? ~idx : idx;
      if (!arcOwner.has(key)) arcOwner.set(key, new Set());
      arcOwner.get(key).add(g.properties.code);
    }
  }
  const neighbors = new Map(features.map((f) => [f.code, new Set()]));
  for (const owners of arcOwner.values()) {
    if (owners.size < 2) continue;
    for (const a of owners) for (const b of owners) if (a !== b) neighbors.get(a).add(b);
  }

  // ---- 写题池元数据 ----
  const units = features.map((f) => {
    const polys = geoms.get(f.code) ?? [];
    const bb = polys.length ? bboxOf(polys) : [0, 0, 0, 0];
    return {
      code: f.code,
      name: f.zh,
      nameLocal: f.local,
      // 英文名单独留一份：题面用当地语言时，日本/俄罗斯的"当地语言"是日/俄，
      // 但管理员排查、以及"英语别名"容错都需要一个稳定的罗马字名。
      nameEn: f.en,
      decorative: f.decorative || undefined,
      inset: f.inset || undefined,
      insetGroup: f.inset ? f.insetGroup : undefined,
      center: centroidOf(polys).map((v) => Number(v.toFixed(4))),
      bbox: bb.map((v) => Number(v.toFixed(4))),
      area: Number(polygonsArea(polys).toFixed(4)),
      neighbors: [...neighbors.get(f.code)].sort(),
    };
  });

  fs.writeFileSync(
    path.join(OUT_DIR, `${cfg.cc}.units.json`),
    JSON.stringify({
      cc: cfg.cc,
      name: cfg.name,
      lang: cfg.lang,
      sourceNote: SOURCE_NOTE,
      units,
    }),
  );

  // ---- 断言：相邻必须对称；题池里除孤立岛屿外都应有邻居 ----
  const byCode = new Map(units.map((u) => [u.code, u]));
  for (const u of units) {
    for (const n of u.neighbors) {
      if (!byCode.get(n)?.neighbors.includes(u.code)) throw new Error(`${u.code} → ${n} 相邻不对称`);
    }
  }
  const isolated = pool.filter((f) => byCode.get(f.code).neighbors.length === 0).map((f) => f.code);
  const kb = (fs.statSync(path.join(OUT_DIR, `${cfg.cc}.topojson`)).size / 1024).toFixed(0);
  console.log(
    `  ${cfg.name.padEnd(4)} 面 ${String(features.length).padStart(3)}（题池 ${String(pool.length).padStart(3)}`
    + `${features.length - pool.length ? ` + 不考 ${features.length - pool.length}` : ''}）`
    + ` 小窗 ${cfg.insetGroups.map((g) => g.join('+')).join(',') || '无'}`
    + ` 孤立 ${isolated.length}${isolated.length ? `(${isolated.join(',')})` : ''}`
    + ` 几何 ${kb}KB`
    + `${dropped.length ? ` 丢弃 ${dropped.join(',')}` : ''}`,
  );

  indexCountries.push({
    cc: cfg.cc,
    name: cfg.name,
    lang: cfg.lang,
    /** 题池数量（不含"不考但显示"的面）。 */
    count: pool.length,
    decorativeCount: features.length - pool.length,
    inset: cfg.insetGroups.length > 0,
    /**
     * 投影范围（经纬度包围盒，[minLon, minLat, maxLon, maxLat]）。
     * `main` = 主图（不含飞地）；`insets` = 左下角**每个小窗**的编码与范围（没有飞地时为 []）。
     * 由构建期算好写进清单：渲染器据此注册地图的 boundingCoords，不必在运行时再遍历几何。
     */
    bbox: {
      // 全部单位的并集：飞地也留在主图里（用户口径：不要小窗，直接点大地图）
      main: unionBbox(units),
      insets: cfg.insetGroups.map((codes, i) => ({
        codes,
        bbox: unionBbox(units.filter((u) => u.insetGroup === i)),
      })),
    },
  });
}

/** 若干单位的包围盒并集。 */
function unionBbox(list) {
  const out = [Infinity, Infinity, -Infinity, -Infinity];
  for (const u of list) {
    out[0] = Math.min(out[0], u.bbox[0]);
    out[1] = Math.min(out[1], u.bbox[1]);
    out[2] = Math.max(out[2], u.bbox[2]);
    out[3] = Math.max(out[3], u.bbox[3]);
  }
  return out.map((v) => Number(v.toFixed(4)));
}

fs.writeFileSync(
  path.join(OUT_DIR, 'index.json'),
  JSON.stringify({ sourceNote: SOURCE_NOTE, countries: indexCountries }),
);

console.log('[6/6] 写出：');
for (const f of fs.readdirSync(OUT_DIR).sort()) {
  console.log(`  public/data/other/${f}  ${(fs.statSync(path.join(OUT_DIR, f)).size / 1024).toFixed(0)}KB`);
}
fs.rmSync(tmpDir, { recursive: true, force: true });

// ---------------------------------------------------------------------------
// TopoJSON 几何引用（仅相邻关系用：共享弧索引 ⇒ 相邻；弧的**坐标**展开交给 topojson-client）
// ---------------------------------------------------------------------------
/** TopoJSON geometry 引用的所有弧索引（负号表示反向）。 */
function arcsOf(g) {
  if (g.type === 'Polygon') return g.arcs.flat();
  if (g.type === 'MultiPolygon') return g.arcs.flat(2);
  return [];
}
