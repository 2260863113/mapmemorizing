// 离线简化中国地图成品（与 build-data.mjs 的 safeSimplify 同一套逻辑）：
// 对 public/data/china_units.geojson 与 china_provinces.geojson 施加更大简化容差，
// 降低运行时拖动/缩放的每帧重绘成本（地级卡顿根因 = 12.6 万点，见 probe-drag-perf 实测）。
//
// 决策背景（grill-rounds.log 2026-09-09）：Q2 容差 0.012（点 -58%，面积保真 ≥99.98%），
// Q5 离线简化现有成品（不联网、不动上游 DataV）；原成品已备份到 .backup-data/，可 --restore 还原。
//
// 用法：
//   node scripts/simplify-data.mjs                 # tolerance=0.012（默认，当前口径）
//   node scripts/simplify-data.mjs --tolerance=0.02  # 试其它档位
//   node scripts/simplify-data.mjs --restore         # 从 .backup-data/ 还原原成品
//   node scripts/simplify-data.mjs --check           # 只跑 check-data.mjs 校验，不简化
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { simplify } from '@turf/simplify';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'public', 'data');
const BAK_DIR = path.join(ROOT, '.backup-data'); // 高精度成品备份（不进 public/dist，避免被部署暴露）
const TARGETS = ['china_units.geojson', 'china_provinces.geojson'];
const DEFAULT_TOLERANCE = 0.012;

const args = process.argv.slice(2);
const restore = args.includes('--restore');
const checkOnly = args.includes('--check');
const tolArg = args.find((a) => a.startsWith('--tolerance='));
const tolerance = tolArg ? Number(tolArg.split('=')[1]) : DEFAULT_TOLERANCE;

// ---------- 几何工具（与 build-data.mjs 保持一致） ----------
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

/** 保守简化：小面（岛屿/小县级）跳过；简化结果退化（无坐标/零面积）时回退原始 */
function safeSimplify(feature, tol) {
  const b = bboxOf(feature);
  const span = Math.max(b[2] - b[0], b[3] - b[1]);
  if (span < 0.2) return feature;
  try {
    const out = simplify(feature, { tolerance: tol, highQuality: false });
    if (!out || !out.geometry || !out.geometry.coordinates) return feature;
    const nb = bboxOf(out);
    if (nb[2] - nb[0] < 1e-9 || nb[3] - nb[1] < 1e-9) return feature;
    return out;
  } catch {
    return feature;
  }
}

// ---------- 统计 ----------
function countPoints(gj) {
  let rings = 0;
  let points = 0;
  const walkRing = (ring) => {
    rings++;
    points += ring.length;
  };
  const walk = (coords) => {
    if (!Array.isArray(coords)) return;
    if (Array.isArray(coords[0]) && typeof coords[0][0] === 'number') walkRing(coords);
    else for (const c of coords) walk(c);
  };
  for (const f of gj.features) walk(f.geometry.coordinates);
  return { rings, points };
}

function areaOf(gj) {
  const ringArea = (ring) => {
    let a = 0;
    for (let i = 0; i < ring.length; i++) {
      const [x0, y0] = ring[i];
      const [x1, y1] = ring[(i + 1) % ring.length];
      a += x0 * y1 - x1 * y0;
    }
    return a / 2;
  };
  const polyArea = (p) => p.reduce((s, ring, i) => s + (i === 0 ? 1 : -1) * ringArea(ring), 0);
  let total = 0;
  for (const f of gj.features) {
    if (f.geometry.type === 'Polygon') total += polyArea(f.geometry.coordinates);
    else if (f.geometry.type === 'MultiPolygon') for (const poly of f.geometry.coordinates) total += polyArea(poly);
  }
  return Math.abs(total);
}

// ---------- 还原 ----------
if (restore) {
  console.log('[还原] 从 .backup-data/ 恢复原成品...');
  for (const name of TARGETS) {
    const bak = path.join(BAK_DIR, name);
    if (!fs.existsSync(bak)) {
      console.warn(`  ⚠ 缺少备份 .backup-data/${name}，跳过`);
      continue;
    }
    fs.copyFileSync(bak, path.join(OUT_DIR, name));
    console.log(`  ✓ ${name} ← .backup-data/${name}`);
  }
  runCheck();
  process.exit(0);
}

if (checkOnly) {
  runCheck();
  process.exit(0);
}

// ---------- 简化 ----------
console.log(`[简化] tolerance=${tolerance}（跨度 < 0.2° 的面跳过；退化回退）`);
for (const name of TARGETS) {
  const file = path.join(OUT_DIR, name);
  const gj = JSON.parse(fs.readFileSync(file, 'utf8'));
  const before = countPoints(gj);
  const beforeArea = areaOf(gj);
  const beforeKB = fs.statSync(file).size / 1024;

  const out = {
    ...gj,
    features: gj.features.map((f) => ({ ...f, geometry: safeSimplify(f, tolerance).geometry })),
  };
  const after = countPoints(out);
  const afterArea = areaOf(out);
  const json = JSON.stringify(out);
  const afterKB = json.length / 1024;
  const areaFidelity = (100 * afterArea) / beforeArea;

  fs.writeFileSync(file, json);
  console.log(`  ${name}`);
  console.log(`    点: ${before.points.toLocaleString()} → ${after.points.toLocaleString()} (${(-100 * (1 - after.points / before.points)).toFixed(0)}%) | 环: ${before.rings} → ${after.rings}`);
  console.log(`    面积保真: ${areaFidelity.toFixed(2)}% | 文件: ${beforeKB.toFixed(0)}KB → ${afterKB.toFixed(0)}KB`);
}

runCheck();

function runCheck() {
  console.log('\n[校验] check-data.mjs ...');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'check-data.mjs')], { cwd: ROOT, encoding: 'utf8' });
  console.log(r.stdout);
  if (r.stderr) console.error(r.stderr);
  if (r.status !== 0) {
    console.error('[校验失败] 见上方输出。可用 node scripts/simplify-data.mjs --restore 还原。');
    process.exit(r.status ?? 1);
  }
}
