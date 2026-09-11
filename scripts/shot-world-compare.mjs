// 世界地图换源前后对比出图（人工验收用；不作为运行时依赖）
//
// 用途：把旧档 public/data/world.geojson 与新档 public/data/world_v2.topojson
// 用**完全相同的投影**渲染成 PNG，供人眼比对边线精细度。
//
// 注意：这里刻意用等距圆柱（不是运行时实际使用的 Robinson），因为本脚本只回答
// 「同样的图上，哪个源的边线更细」，两种源走同一映射才能隔离出几何本身的差异。
// 投影本身的改动由 scripts/shot-world-projection.mjs 单独出图。
//
// 投影：等距圆柱（equirectangular），即 ECharts geo 显式给 boundingCoords 后的线性映射：
//   x = (lng + 180) / 360 * W
//   y = (TOP - lat) / (TOP - BOTTOM) * H
// 两边同投影、同尺寸、同线宽，因此图上任何差别都只来自几何本身。
//
// 用法：node scripts/shot-world-compare.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { feature } from 'topojson-client';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'public', 'data');
const OUT = path.join(ROOT, 'shot-world');

const BBOX = { west: -180, east: 180, south: -90, north: 83.6 };

/** 视角：全图 + 四个特征区域（含大国海岸线与多岛国），与 grill 轮次约定的验收范围一致。 */
const VIEWS = [
  { id: 'global', title: '全球', west: -180, east: 180, south: -90, north: 83.6, w: 1600, h: 780 },
  { id: 'china', title: '中国周边', west: 100, east: 145, south: 3, north: 45, w: 1200, h: 1120 },
  { id: 'europe', title: '欧洲', west: -12, east: 32, south: 34, north: 62, w: 1200, h: 766 },
  { id: 'caribbean', title: '加勒比', west: -90, east: -58, south: 8, north: 28, w: 1200, h: 750 },
  { id: 'norway', title: '挪威峡湾', west: 3, east: 32, south: 57, north: 72, w: 1200, h: 620 },
];

function loadOld() {
  return JSON.parse(fs.readFileSync(path.join(DATA, 'world.geojson'), 'utf8'));
}
function loadNew() {
  const t = JSON.parse(fs.readFileSync(path.join(DATA, 'world_v2.topojson'), 'utf8'));
  return feature(t, t.objects.china);
}

function polygonsOf(geom) {
  if (!geom) return [];
  if (geom.type === 'Polygon') return [geom.coordinates];
  if (geom.type === 'MultiPolygon') return geom.coordinates;
  return [];
}

function makeProjector(view) {
  return (lng, lat) => [
    ((lng - view.west) / (view.east - view.west)) * view.w,
    ((view.north - lat) / (view.north - view.south)) * view.h,
  ];
}

/** 把 GeoJSON 转为 SVG path 串。只画答题国与装饰面的轮廓；装饰面用浅灰以区分。 */
function toPaths(geojson, view) {
  const p = makeProjector(view);
  const out = [];
  for (const f of geojson.features ?? []) {
    if (!f.geometry) continue;
    const deco = !!f.properties.decorative;
    const d = [];
    for (const poly of polygonsOf(f.geometry)) {
      // 只取外环（环 0）：视觉对比关心的是轮廓精细度，内环（湖泊）在灰色填充下不可辨
      const ring = poly[0];
      if (!ring || ring.length < 3) continue;
      let started = false;
      for (const [lng, lat] of ring) {
        const [x, y] = p(lng, lat);
        // SVG 坐标需有限，避免 NaN 破坏整条 path
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        d.push(`${started ? 'L' : 'M'}${x.toFixed(2)} ${y.toFixed(2)}`);
        started = true;
      }
      if (started) d.push('Z');
    }
    if (d.length) out.push({ d: d.join(''), deco });
  }
  return out;
}

function svgFor(geojson, view) {
  const paths = toPaths(geojson, view);
  const body = paths
    .map(({ d, deco }) => `<path d="${d}" fill="${deco ? '#e8e8e8' : '#cfe3f3'}" stroke="${deco ? '#9aa0a6' : '#5b6b7a'}" stroke-width="0.7" stroke-linejoin="round" fill-rule="evenodd"/>`)
    .join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${view.w}" height="${view.h}" viewBox="0 0 ${view.w} ${view.h}">
<rect width="100%" height="100%" fill="#ffffff"/>
${body}
</svg>`;
}

/** 两版并排（上=旧，下=新），并加一条分隔线，便于同屏比对同一区域。 */
async function renderPair(view) {
  const oldSvg = svgFor(loadOld(), view);
  const newSvg = svgFor(loadNew(), view);
  const oldPng = await sharp(Buffer.from(oldSvg)).png().toBuffer();
  const newPng = await sharp(Buffer.from(newSvg)).png().toBuffer();

  const labelH = 34;
  const gap = 12;
  const totalH = labelH + view.h + gap + labelH + view.h;
  const label = (text, w) => Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${labelH}">
      <rect width="100%" height="100%" fill="#ffffff"/>
      <text x="10" y="23" font-family="Microsoft YaHei, sans-serif" font-size="19" fill="#111">${text}</text>
    </svg>`,
  );

  await sharp({ create: { width: view.w, height: totalH, channels: 3, background: '#ffffff' } })
    .composite([
      { input: label(`旧档 Surbowl —— ${view.title}（中位线段 0.733°，1000px 下 2.04px）`, view.w), top: 0, left: 0 },
      { input: oldPng, top: labelH, left: 0 },
      { input: label(`新档 Natural Earth 10m _chn 中国视角 dp12 —— ${view.title}（中位线段 0.163°，0.45px，4.5 倍精细）`, view.w), top: labelH + view.h + gap, left: 0 },
      { input: newPng, top: labelH + view.h + gap + labelH, left: 0 },
    ])
    .png()
    .toFile(path.join(OUT, `${view.id}.png`));

  fs.writeFileSync(path.join(OUT, `${view.id}.old.svg`), oldSvg);
  fs.writeFileSync(path.join(OUT, `${view.id}.new.svg`), newSvg);
  return { id: view.id, bytes: fs.statSync(path.join(OUT, `${view.id}.png`)).size };
}

fs.mkdirSync(OUT, { recursive: true });
console.log('渲染前后对比图 ...');
for (const v of VIEWS) {
  const r = await renderPair(v);
  console.log(`  ${r.id.padEnd(10)} ${v.w}x${view_h(v)} *2  ${(r.bytes / 1024).toFixed(0)}KB`);
}
console.log(`\n输出目录: shot-world/（${VIEWS.length} 组，每组上=旧档、下=新档）`);
function view_h(v) { return v.h; }
