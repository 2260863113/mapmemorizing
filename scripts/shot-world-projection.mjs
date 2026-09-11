// 投影对比出图（人工验收用；不作为运行时依赖）。
//
// 对比「等距圆柱（改动前）」与「Robinson（改动后）」两种世界图投影，
// 重点让「俄罗斯/加拿大/格陵兰是否仍然显得过大」一眼可判。
//
// 关键：两张图都必须把**经度线性映射**与**投影映射**分别贯彻到底，否则对比不成立。
// 等距圆柱：x ∝ lng（各纬度等宽），y ∝ lat。
// Robinson ：x = X(φ)·λ·0.8487，y = 1.3527·Y(φ)（各纬度宽度随纬度收缩）。
//
// 用法：node scripts/shot-world-projection.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { feature } from 'topojson-client';
import sharp from 'sharp';
import { robinsonProject } from '../src/map/projection.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'shot-world');

// 与 renderer 的 WORLD_BOUNDING_COORDS / 世界图取景一致
const LAT_TOP = 83.6;
const LAT_BOTTOM = -90;
const W = 1500;
const H = 750;

const world = (() => {
  const t = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data/world_v2.topojson'), 'utf8'));
  return feature(t, t.objects.china);
})();

const polysOf = (g) => (g.type === 'Polygon' ? [g.coordinates] : g.coordinates);

/** 等距圆柱：x ∝ lng，y ∝ lat（各纬度等宽，高纬被放大）。 */
function equirectangular([lng, lat]) {
  return [((lng + 180) / 360) * W, ((LAT_TOP - lat) / (LAT_TOP - LAT_BOTTOM)) * H];
}

// Robinson 的纵向范围（用于把投影结果缩放到画布）
const yTop = robinsonProject([0, LAT_TOP])[1];
const yBottom = robinsonProject([0, LAT_BOTTOM])[1];
const xHalf = robinsonProject([180, 0])[0];

/** Robinson：按投影比例映射，宽度随纬度收缩。 */
function robinson([lng, lat]) {
  const [x, y] = robinsonProject([lng, lat]);
  return [((x + xHalf) / (2 * xHalf)) * W, ((yTop - y) / (yTop - yBottom)) * H];
}

function svgFor(projector, title, isOld) {
  const paths = [];
  for (const f of world.features) {
    if (!f.geometry) continue;
    const deco = !!f.properties.decorative;
    const d = [];
    for (const poly of polysOf(f.geometry)) {
      const ring = poly[0];
      if (!ring || ring.length < 3) continue;
      let started = false;
      for (const pt of ring) {
        const [x, y] = projector(pt);
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        d.push(`${started ? 'L' : 'M'}${x.toFixed(2)} ${y.toFixed(2)}`);
        started = true;
      }
      if (started) d.push('Z');
    }
    if (d.length) paths.push({ d: d.join(''), deco });
  }
  const body = paths
    .map(({ d, deco }) => `<path d="${d}" fill="${deco ? '#e8e8e8' : '#cfe3f3'}" stroke="${deco ? '#9aa0a6' : '#5b6b7a'}" stroke-width="0.5" stroke-linejoin="round" fill-rule="evenodd"/>`)
    .join('\n');
  // 加几条纬度参考线（赤道、南北回归线、60°N），便于看出高纬被压缩的程度
  const grid = [60, 23.5, 0, -23.5, -60]
    .map((lat) => {
      const [, y] = projector([0, lat]);
      const dash = lat === 0 ? '' : ' stroke-dasharray="4 4"';
      return `<line x1="0" y1="${y.toFixed(1)}" x2="${W}" y2="${y.toFixed(1)}" stroke="#d9534f" stroke-width="1" opacity="0.5"${dash}/><text x="6" y="${(y - 3).toFixed(1)}" font-family="sans-serif" font-size="11" fill="#d9534f">${lat}°</text>`;
    })
    .join('\n');
  const label = isOld
    ? '等距圆柱（改动前）：高纬被放大 —— 俄罗斯在图上面积是真实的 2.15 倍、格陵兰 3.82 倍'
    : 'Robinson 折中投影（改动后）：俄罗斯降到 1.50 倍、格陵兰 1.96 倍';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H + 26}">
<rect width="100%" height="100%" fill="#ffffff"/>
<text x="6" y="17" font-family="Microsoft YaHei, sans-serif" font-size="15" fill="#111">${label}</text>
<g transform="translate(0,26)">
${body}
${grid}
</g>
</svg>`;
}

fs.mkdirSync(OUT, { recursive: true });
console.log('渲染投影对比图 ...');

const oldSvg = svgFor(equirectangular, 'old', true);
const newSvg = svgFor(robinson, 'new', false);
const oldPng = await sharp(Buffer.from(oldSvg)).png().toBuffer();
const newPng = await sharp(Buffer.from(newSvg)).png().toBuffer();

const gap = 14;
const totalH = (H + 26) * 2 + gap;
await sharp({ create: { width: W, height: totalH, channels: 3, background: '#ffffff' } })
  .composite([
    { input: oldPng, top: 0, left: 0 },
    { input: newPng, top: H + 26 + gap, left: 0 },
  ])
  .png()
  .toFile(path.join(OUT, 'projection-compare.png'));

fs.writeFileSync(path.join(OUT, 'projection.old.svg'), oldSvg);
fs.writeFileSync(path.join(OUT, 'projection.new.svg'), newSvg);

// 量化：各国在两投影下的相对「视觉面积」（占整幅图的比例），供人眼比对时对照
console.log('\n各国在两种投影下占世界图的面积比（同一点集，两种投影各自归一化）:');
const areaOf = (projector) => {
  const res = new Map();
  for (const f of world.features) {
    if (!f.geometry) continue;
    const key = f.properties.iso_a3;
    let a = 0;
    for (const poly of polysOf(f.geometry)) {
      for (const ring of poly) {
        const r = ring.map(projector);
        let s = 0;
        for (let i = 0; i < r.length; i++) {
          const [x1, y1] = r[i];
          const [x2, y2] = r[(i + 1) % r.length];
          s += x1 * y2 - x2 * y1;
        }
        a += s / 2;
      }
    }
    res.set(key, (res.get(key) ?? 0) + Math.abs(a));
  }
  const total = [...res.values()].reduce((s, v) => s + v, 0);
  for (const [k, v] of res) res.set(k, v / total);
  return res;
};
const eqArea = areaOf(equirectangular);
const rbArea = areaOf(robinson);
console.log('  ISO   等距圆柱%   Robinson%');
for (const iso of ['RUS', 'CAN', 'GRL', 'USA', 'CHN', 'BRA', 'IND', 'AUS', 'ATA']) {
  if (!eqArea.has(iso)) continue;
  console.log(`  ${iso}   ${(eqArea.get(iso) * 100).toFixed(2).padStart(7)}   ${(rbArea.get(iso) * 100).toFixed(2).padStart(7)}`);
}
const share = (m, isos) => isos.reduce((s, i) => s + (m.get(i) ?? 0), 0);
const AFRICA = ['DZA','EGY','LBY','SDN','TCD','NER','MLI','MRT','SEN','GMB','GIN','GNB','SLE','LBR','CIV','GHA','TGO','BEN','NGA','CMR','CAF','GNQ','GAB','COG','COD','AGO','ZMB','MWI','MOZ','ZWE','BWA','NAM','ZAF','LSO','SWZ','MDG','ETH','ERI','DJI','SOM','KEN','UGA','RWA','BDI','TZA','BFA','MAR','ESH','TUN'];
console.log(`\n  俄罗斯 / 非洲  等距圆柱 = ${(eqArea.get('RUS') / share(eqArea, AFRICA)).toFixed(3)}   Robinson = ${(rbArea.get('RUS') / share(rbArea, AFRICA)).toFixed(3)}`);
console.log(`  （真实面积比 = 0.574：等距圆柱下俄国显得比非洲大，Robinson 下正确回到更小）`);
console.log(`\n输出: shot-world/projection-compare.png（上=改动前，下=改动后）`);
