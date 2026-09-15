/**
 * 国旗缩略图管线：把 194 面国旗 SVG 栅格化成 **40px 宽的 WebP 小图**，供**地图标签**使用。
 *
 * ## 为什么要单独一套小图
 * 地图标签上的国旗只有二十几像素宽，用原始 SVG（最大 177KB、合计 1.21MB）既没必要也拖慢绘制：
 * 标签是**每帧都要重画**的（拖动/缩放），194 张复杂 SVG 的解析与绘制成本远高于一张 1KB 的位图。
 * 而**点击模式的题面卡片**继续用原始 SVG（用户口径：提示里的国旗不压缩，要大要清楚）。
 *
 * ## 为什么用无头 Edge 而不是 node 里的图像库
 * 仓库没有、也不想为一次性构建引入 sharp/resvg 这类原生依赖；而验收链路本来就依赖本机 Edge + CDP，
 * 复用它做一次批量栅格化最省事。Chromium 自带 WebP 编码器，`canvas.toDataURL('image/webp')` 即可。
 *
 * ## 输出契约
 *   public/data/flags/thumbs/<a2>.webp   194 张小图（4:3，40×30）
 *   public/data/flags/thumbs.json        { "source": "...", "thumbs": { "JPN": "jp.webp", ... } }
 *     - 键集合必须与 countries.json 的 iso 完全一致（双向断言）
 *     - 与 `fetch-world-flags.mjs` 的 index.json 是**两张表**：各自单一职责（一个下载矢量、一个栅格化），
 *       由 `src/worldFlagsData.test.ts` 断言两者的键集合一致、文件都存在 → 谁漏生成都会在测试里暴露
 *     - 无时间戳：同样的输入产出逐字节相同的文件
 *
 * 用法：node scripts/build-flag-thumbs.mjs
 *   需要本机 Edge（路径见 BROWSER）。已有小图默认跳过，`--refresh` 强制重做。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FLAG_DIR = path.join(ROOT, 'public', 'data', 'flags');
const OUT_DIR = path.join(FLAG_DIR, 'thumbs');
const OUT_INDEX = path.join(FLAG_DIR, 'thumbs.json');
const BROWSER = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9995;
const CDP = 9996;
/** 目标尺寸：4:3 比例（flag-icons 的 4x3 集），40px 宽在地图标签上足够清晰。 */
const W = 40;
const H = 30;
const QUALITY = 0.85;
const REFRESH = process.argv.includes('--refresh');

const SOURCE_NOTE =
  `由 scripts/build-flag-thumbs.mjs 从 public/data/flags/*.svg 栅格化而来（${W}×${H} WebP，quality ${QUALITY}）；` +
  '矢量来源见 flags/index.json 的 source 字段（flag-icons, MIT）。地图标签用这套小图，点击模式题面仍用原始 SVG。';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('[1/4] 读国旗索引 ...');
const index = JSON.parse(fs.readFileSync(path.join(FLAG_DIR, 'index.json'), 'utf8'));
const countries = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'data', 'countries.json'), 'utf8')).countries;
const jobs = countries.map((c) => ({ iso: c.iso, svg: index.flags[c.iso] }));
const missing = jobs.filter((j) => !j.svg).map((j) => j.iso);
if (missing.length) throw new Error(`index.json 里缺这些 iso 的国旗文件：${missing.join(',')}`);
console.log(`  ${jobs.length} 面待栅格化`);

fs.mkdirSync(OUT_DIR, { recursive: true });
const pending = REFRESH ? jobs : jobs.filter((j) => !fs.existsSync(path.join(OUT_DIR, j.svg.replace(/\.svg$/, '.webp'))));
console.log(`[2/4] 需要栅格化 ${pending.length} 面${pending.length === 0 ? '（全部已存在，跳过浏览器）' : ''}`);

const results = [];
if (pending.length) {
  const server = spawn(process.execPath, [path.join(ROOT, 'scripts', 'static-server.mjs'), String(PORT), path.join(ROOT, 'public')], { stdio: 'ignore' });
  await sleep(1200);
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flag-thumbs-'));
  const browser = spawn(BROWSER, ['--headless=new', '--disable-gpu', '--no-first-run', `--user-data-dir=${userDir}`, `--remote-debugging-port=${CDP}`, '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });

  let ws; let msgId = 0; const pendingMsgs = new Map();
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++msgId;
      pendingMsgs.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });

  try {
    let target = null;
    for (let i = 0; i < 60; i++) {
      await sleep(400);
      try {
        const list = await fetch(`http://127.0.0.1:${CDP}/json/list`).then((r) => r.json());
        target = list.find((t) => t.type === 'page');
        if (target?.webSocketDebuggerUrl) break;
      } catch { /* 还没起来 */ }
    }
    if (!target) throw new Error('CDP 目标未就绪');
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pendingMsgs.has(m.id)) {
        const p = pendingMsgs.get(m.id); pendingMsgs.delete(m.id);
        if (m.error) p.reject(new Error(JSON.stringify(m.error))); else p.resolve(m.result);
      }
    });
    await send('Runtime.enable');
    await send('Page.enable');
    await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
    await sleep(1500);

    // 整批一次栅格化：在页面里逐个 load SVG → 画到 canvas → toDataURL('image/webp')
    const payload = JSON.stringify(pending.map((j) => ({ iso: j.iso, svg: j.svg })));
    const expr = `(async () => {
      const jobs = ${payload};
      const out = [];
      const canvas = document.createElement('canvas');
      canvas.width = ${W}; canvas.height = ${H};
      const ctx = canvas.getContext('2d', { alpha: true });
      for (const job of jobs) {
        const img = new Image();
        const url = 'data/flags/' + job.svg;
        const ok = await new Promise((resolve) => {
          img.onload = () => resolve(true);
          img.onerror = () => resolve(false);
          img.src = url;
        });
        if (!ok) { out.push({ iso: job.iso, error: 'load failed' }); continue; }
        ctx.clearRect(0, 0, ${W}, ${H});
        // SVG 声明为 4:3，按整数比例直接铺满；万一比例不同也按 contain 保形
        const scale = Math.min(${W} / img.naturalWidth, ${H} / img.naturalHeight);
        const w = img.naturalWidth * scale, h = img.naturalHeight * scale;
        ctx.drawImage(img, (${W} - w) / 2, (${H} - h) / 2, w, h);
        out.push({ iso: job.iso, dataUrl: canvas.toDataURL('image/webp', ${QUALITY}) });
      }
      return JSON.stringify(out);
    })()`;
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? '栅格化失败');
    results.push(...JSON.parse(r.result.value));
  } finally {
    try { ws?.close(); } catch { /* ignore */ }
    browser.kill(); server.kill();
    await sleep(300);
    try { fs.rmSync(userDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

console.log('[3/4] 写小图与 thumbs.json ...');
const failures = results.filter((r) => r.error);
if (failures.length) throw new Error(`有 ${failures.length} 面栅格化失败：${failures.map((f) => f.iso).join(',')}`);
for (const r of results) {
  const b64 = String(r.dataUrl).split(',')[1] ?? '';
  const buf = Buffer.from(b64, 'base64');
  if (buf.length < 100 || buf.subarray(0, 4).toString('ascii') !== 'RIFF') {
    throw new Error(`${r.iso} 产出的不是有效 WebP（${buf.length} 字节）`);
  }
  fs.writeFileSync(path.join(OUT_DIR, r.iso === '' ? 'x' : `${index.flags[r.iso].replace(/\.svg$/, '')}.webp`), buf);
}
// thumbs.json 用「读回最终文件」的方式重建，保证与磁盘一致（而不是只记录本次新做的）
const thumbs = {};
const sizes = [];
for (const j of jobs) {
  const webp = `${j.svg.replace(/\.svg$/, '')}.webp`;
  const file = path.join(OUT_DIR, webp);
  if (!fs.existsSync(file)) throw new Error(`缺小图文件 ${webp}（${j.iso}）`);
  thumbs[j.iso] = webp;
  sizes.push({ iso: j.iso, bytes: fs.statSync(file).size });
}
fs.writeFileSync(OUT_INDEX, `${JSON.stringify({ source: SOURCE_NOTE, thumbs })}\n`);

console.log('[4/4] 自检与报告 ...');
const keys = Object.keys(thumbs).sort();
const isos = countries.map((c) => c.iso).sort();
if (keys.join(',') !== isos.join(',')) throw new Error('thumbs.json 的键集合与 countries.json 不一致');
console.log(`  ✓ 键集合一致：${keys.length} 条 = countries.json 的 194 个答题国`);
const total = sizes.reduce((s, x) => s + x.bytes, 0);
const sorted = [...sizes].sort((a, b) => a.bytes - b.bytes);
console.log(`  ✓ 体积：合计 ${(total / 1024).toFixed(0)} KB，中位 ${sorted[Math.floor(sorted.length / 2)].bytes} 字节，最大 ${Math.round(sorted.at(-1).bytes / 1024)} KB（${sorted.at(-1).iso}）`);
console.log(`  ✓ 对比原始 SVG：1.21 MB → ${(total / 1024 / 1024).toFixed(2)} MB（约 ${Math.round((1 - total / (1.21 * 1024 * 1024)) * 100)}% 更小）`);
const orphans = fs.readdirSync(OUT_DIR).filter((f) => f.endsWith('.webp') && !Object.values(thumbs).includes(f));
for (const f of orphans) fs.rmSync(path.join(OUT_DIR, f), { force: true });
if (orphans.length) console.log(`  删除孤儿小图 ${orphans.length} 个：${orphans.join(', ')}`);
console.log('\n完成。');
