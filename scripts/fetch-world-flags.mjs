/**
 * 国旗资源管线：为答题池里的 194 个国家下载并**冻结**国旗 SVG（点击模式「国旗」档的题面用）。
 *
 * ## 为什么需要它
 * 「国旗」这一档要在地图上方给出一张国旗图片、让用户点地图上对应的国家。仓库原先只有
 * `countries.json`（iso_a3）与 `world_names.json`（英文名/首都名），没有旗帜资源。
 *
 * ## 为什么用 SVG 文件而不是 emoji 国旗
 * 国旗 emoji（🇯🇵 这类区域指示符对）在 **Windows 的 Chrome/Edge 上不渲染** —— 会退化成
 * 「JP」两个字母。本项目的开发与运行时验收都在 Windows 上，emoji 方案连验收都过不了。
 * 故从开放许可的 SVG 国旗集取图，冻结进 `public/data/flags/`，**运行时不依赖网络**。
 * 旗帜按上游文件**原样复制**，不重新压缩、不改图形（改图会引入许可与准确性问题）。
 *
 * ## 两个来源（都是开放许可，可入库）
 * 1. **旗帜**：`flag-icons`（MIT，Panayiotis Lipiridis，https://github.com/lipis/flag-icons），
 *    经 jsDelivr 取 `flags/4x3/<a2>.svg`。版本**钉死**在 `FLAG_ICONS_VERSION`，保证可复现。
 * 2. **a3 → a2 映射**：Natural Earth v5.1.2 `ne_10m_admin_0_countries_chn.geojson`
 *    的 `ISO_A3`/`ISO_A2`（与 `fetch-world-names.mjs` 同一份源、同一套取值规则）。
 *
 * ## 输出契约
 *   public/data/flags/index.json   { "source": "...", "flags": { "JPN": "jp.svg", ... } }
 *     - 键集合必须与 countries.json 的 iso **完全一致**（双向断言，不一致即失败）
 *     - 无时间戳：同样的输入必须产出逐字节相同的文件（便于复核与 git diff）
 *   public/data/flags/<a2>.svg     194 个旗帜文件（文件名即上游的小写 a2）
 *
 * 用法：node scripts/fetch-world-flags.mjs [--refresh]
 *   `--refresh` 忽略本地缓存、重新下载（缓存目录：系统临时目录下的 map-memory-world-flags，
 *   含 NE 源与已下载的旗帜；重跑时秒级完成）。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'public', 'data', 'flags');
const OUT_INDEX = path.join(OUT_DIR, 'index.json');
const COUNTRIES = path.join(ROOT, 'public', 'data', 'countries.json');

const CACHE_DIR = path.join(os.tmpdir(), 'map-memory-world-flags');
const REFRESH = process.argv.includes('--refresh');

/** 旗帜集版本（钉死，保证可复现；升级版本时按下面「升级步骤」重跑并复核报告）。 */
const FLAG_ICONS_VERSION = '7.5.0';
const FLAG_URL = (a2) => `https://cdn.jsdelivr.net/npm/flag-icons@${FLAG_ICONS_VERSION}/flags/4x3/${a2}.svg`;

/** a3→a2 的来源（与 fetch-world-names.mjs 同一份 Natural Earth 数据、同一套取值规则）。 */
const NE_URL = 'https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector@v5.1.2/geojson/ne_10m_admin_0_countries_chn.geojson';

const SOURCE_NOTE =
  `旗帜：flag-icons v${FLAG_ICONS_VERSION}（MIT，Panayiotis Lipiridis，https://github.com/lipis/flag-icons），` +
  '经 jsDelivr 取 flags/4x3/<a2>.svg，**原样复制**入 public/data/flags/；' +
  'iso_a3→iso_a2 映射取 Natural Earth v5.1.2 ne_10m_admin_0_countries_chn（公有领域）。运行时不依赖网络。';

/**
 * 人工例外表：某个 iso 在源里的 a2 取不到/取错时在这里补上，**每条必须写明理由**。
 * 目前为空 —— 194 个答题国的 a2 都能从 Natural Earth 直接取到（由下面的硬断言保证）。
 */
const A2_OVERRIDES = {
  // 例：'XKX': { a2: 'xk', reason: '科索沃在 NE 里 ISO_A2=-99；flag-icons 用 xk' },
};

const UA = { 'User-Agent': 'Mozilla/5.0 (map-memory-flags/1.0)' };

async function fetchText(url) {
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`下载失败 ${res.status} ${url}`);
  return res.text();
}

/** 带缓存的下载（缓存目录不复用网络结果时会退化成每次重下，故默认走缓存）。 */
async function cached(fileName, url) {
  const file = path.join(CACHE_DIR, fileName);
  if (!REFRESH && fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
  const text = await fetchText(url);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return text;
}

/** 从 NE 的 feature properties 取 a3→a2（与 fetch-world-names.mjs 同一取值规则：'-99' 视为缺失）。 */
function pickIso(value) {
  return typeof value === 'string' && value !== '-99' && value.trim() ? value.trim() : '';
}

console.log('[1/5] 读答题池与 a3→a2 映射 ...');
const pool = JSON.parse(fs.readFileSync(COUNTRIES, 'utf8')).countries.map((c) => c.iso);
const neText = await cached('ne_10m_admin_0_countries_chn.geojson', NE_URL);
const ne = JSON.parse(neText);
const a3ToA2 = new Map();
for (const f of ne.features ?? []) {
  const p = f.properties ?? {};
  const a3 = pickIso(p.ISO_A3) || pickIso(p.ADM0_A3);
  const a2 = pickIso(p.ISO_A2) || pickIso(p.ISO_A2_EH);
  if (a3 && a2 && !a3ToA2.has(a3)) a3ToA2.set(a3, a2.toLowerCase());
}
console.log(`  NE 里拿到 ${a3ToA2.size} 条 a3→a2；答题池 ${pool.length} 国`);

console.log('[2/5] 解析每个答题国的 a2 ...');
const resolved = new Map(); // iso → a2
const overridden = [];
const unresolved = [];
for (const iso of pool) {
  const ov = A2_OVERRIDES[iso];
  const a2 = ov ? ov.a2 : a3ToA2.get(iso);
  if (!a2) {
    unresolved.push(iso);
    continue;
  }
  if (ov) overridden.push(`${iso} → ${a2}（人工：${ov.reason}）`);
  resolved.set(iso, a2);
}
if (unresolved.length) {
  // 不许静默留空：缺一个国家的映射就必须停下来，要么补 A2_OVERRIDES，要么承认该不该在池里
  throw new Error(`这些答题国取不到 a2（请在 A2_OVERRIDES 里补上并写明理由）：${unresolved.join(', ')}`);
}
console.log(`  ${resolved.size} 国全部解析成功${overridden.length ? `（人工例外 ${overridden.length} 条）` : '（无人工例外）'}`);

console.log('[3/5] 下载旗帜（命中缓存则跳过）...');
fs.mkdirSync(OUT_DIR, { recursive: true });
const sizes = [];
const failed = [];
let fromCache = 0;
for (const [iso, a2] of [...resolved].sort((a, b) => a[0].localeCompare(b[0]))) {
  const fileName = `${a2}.svg`;
  const outFile = path.join(OUT_DIR, fileName);
  let svg;
  try {
    const cacheFile = path.join(CACHE_DIR, 'flags', fileName);
    if (!REFRESH && fs.existsSync(cacheFile)) {
      svg = fs.readFileSync(cacheFile, 'utf8');
      fromCache += 1;
    } else {
      svg = await fetchText(FLAG_URL(a2));
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      fs.writeFileSync(cacheFile, svg);
    }
  } catch (err) {
    failed.push(`${iso}(${a2}): ${String(err).slice(0, 80)}`);
    continue;
  }
  // 基本健全性：必须真是一份 SVG，且不是小得可疑的占位文件
  const head = svg.trimStart().slice(0, 400).toLowerCase();
  if (!head.includes('<svg') || svg.length < 100) {
    failed.push(`${iso}(${a2}): 不是有效 SVG（${svg.length} 字节）`);
    continue;
  }
  fs.writeFileSync(outFile, svg);
  sizes.push({ iso, a2, bytes: Buffer.byteLength(svg) });
}
if (failed.length) throw new Error(`有 ${failed.length} 个旗帜下载/校验失败：\n  ${failed.join('\n  ')}`);
console.log(`  ${sizes.length} 个旗帜写入 public/data/flags/（其中 ${fromCache} 个来自缓存）`);

console.log('[4/5] 写 index.json 并清理孤儿文件 ...');
const flags = {};
for (const [iso, a2] of [...resolved].sort((a, b) => a[0].localeCompare(b[0]))) flags[iso] = `${a2}.svg`;
fs.writeFileSync(OUT_INDEX, `${JSON.stringify({ source: SOURCE_NOTE, flags })}\n`);

// 目录由本脚本独占：删掉不再被引用的 SVG（通常是改过文件名后的残留），并打印出来
const referenced = new Set(Object.values(flags));
const orphans = fs
  .readdirSync(OUT_DIR)
  .filter((f) => f.endsWith('.svg') && !referenced.has(f));
for (const f of orphans) fs.rmSync(path.join(OUT_DIR, f), { force: true });
if (orphans.length) console.log(`  删除孤儿文件 ${orphans.length} 个：${orphans.join(', ')}`);

console.log('[5/5] 自检与报告 ...');
const indexKeys = Object.keys(flags).sort();
const poolSorted = [...pool].sort();
const extra = indexKeys.filter((iso) => !poolSorted.includes(iso));
const missing = poolSorted.filter((iso) => !indexKeys.includes(iso));
if (extra.length || missing.length) {
  throw new Error(`index.json 与 countries.json 的 iso 集合不一致：多出 ${extra.join(',')} / 缺少 ${missing.join(',')}`);
}
console.log(`  ✓ 键集合一致：${indexKeys.length} 条 = countries.json 的 ${poolSorted.length} 个答题国`);
const total = sizes.reduce((s, x) => s + x.bytes, 0);
console.log(`  ✓ 体积：合计 ${(total / 1024 / 1024).toFixed(2)} MB，中位 ${Math.round(sizes.map((s) => s.bytes).sort((a, b) => a - b)[Math.floor(sizes.length / 2)] / 1024)} KB`);
const largest = [...sizes].sort((a, b) => b.bytes - a.bytes).slice(0, 5);
console.log(`  最大的 5 个：${largest.map((s) => `${s.iso}(${s.a2}) ${Math.round(s.bytes / 1024)}KB`).join('、')}`);

// 纯白旗在白色卡片上只能靠我们画的那圈细描边区分 —— 只提示，不失败（卡片自带 1px 描边）。
// 判据：取所有 fill 值，若全是白色系（含 white / #fff / rgb(255,255,255)）才提示；
// 注意别只匹配 #hex —— 上游也有写具名色（red）的文件，漏掉会造成误报。
const WHITE_FILLS = new Set(['#fff', '#ffffff', '#ffffffff', 'white', 'rgb(255,255,255)', 'rgb(100%,100%,100%)']);
const whiteOnly = [];
for (const { iso, a2 } of sizes) {
  const svg = fs.readFileSync(path.join(OUT_DIR, `${a2}.svg`), 'utf8');
  const fills = [...svg.matchAll(/fill="([^"]+)"/g)].map((m) => m[1].trim().toLowerCase());
  const nonWhite = fills.some((f) => !WHITE_FILLS.has(f));
  const hasShape = /<path|<rect|<circle|<polygon|<g/i.test(svg);
  if (!nonWhite && hasShape) whiteOnly.push(`${iso}(${a2})`);
}
if (whiteOnly.length) console.log(`  ⚠ 提示：${whiteOnly.length} 个旗帜的填色全是白（白卡片上靠 1px 描边区分）：${whiteOnly.join(', ')}`);

console.log('\n完成。');
console.log(`  来源与许可（写进 index.json 的 source 字段）：${SOURCE_NOTE}`);
if (overridden.length) console.log(`  人工例外：\n    ${overridden.join('\n    ')}`);
console.log('  注：升级 flag-icons 版本时改 FLAG_ICONS_VERSION 后重跑（加 --refresh），并复核上面的报告。');
