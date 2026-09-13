/**
 * 跟随钳制（2026-09）目测截图：把贴边目标与正常目标的取景各拍一张。
 *
 * 用法：npm run build && node scripts/shot-follow-clamp.mjs
 * 产物：docs/shots/clamp-*.png（每张同时打印取景边界/视口数据矩形，便于核对露白）
 *
 * 对照关系（其余条件相同，只差目标位置）：
 *   clamp-cn-北界-大兴安岭  vs  clamp-cn-中央-郑州      → 贴边目标不居中，中央目标仍居中
 *   clamp-cn-西界-喀什      vs  clamp-cn-南界-三沙
 *   clamp-nx-下钻宁夏       → 小省档：倍率被下限抬高，不再有三面空白
 *   clamp-world-俄罗斯      → 北纬贴世界 bbox（3x 视口中心上限约 47°N）
 *   clamp-world-澳大利亚    → 东经贴 ±180
 *   clamp-world-新加坡      → 正常对照（28x，仍居中）
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BROWSER = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9987;
const CDP = 9988;
const OUT = path.join(ROOT, 'docs', 'shots');
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn(process.execPath, [path.join(ROOT, 'scripts', 'static-server.mjs'), String(PORT), path.join(ROOT, 'dist')], { stdio: 'ignore' });
await sleep(1200);
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shot-clamp-'));
const browser = spawn(BROWSER, ['--headless=new', '--disable-gpu', '--no-first-run', `--user-data-dir=${userDir}`, `--remote-debugging-port=${CDP}`, '--window-size=1440,900', '--force-device-scale-factor=1', 'about:blank'], { stdio: 'ignore' });

let ws; let id = 0; const pending = new Map();
const send = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })); });

try {
  let target = null;
  for (let i = 0; i < 60; i++) {
    await sleep(400);
    try { const l = await fetch(`http://127.0.0.1:${CDP}/json/list`).then((r) => r.json()); target = l.find((t) => t.type === 'page'); if (target?.webSocketDebuggerUrl) break; } catch { /* wait */ }
  }
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } });
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?probe=1` });

  const ev = async (e) => {
    const r = await send('Runtime.evaluate', { expression: `(async () => (${e}))()`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed');
    return r.result.value;
  };
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    const f = path.join(OUT, name);
    fs.writeFileSync(f, Buffer.from(r.data, 'base64'));
    const frames = await ev('window.__probe.followFrames()');
    const f2 = JSON.parse(frames);
    const blank = (() => {
      const w = f2.window?.box, e = f2.extent;
      if (!w || !e) return 'n/a';
      const over = [Math.max(e[0] - w[0], 0).toFixed(2), Math.max(w[2] - e[2], 0).toFixed(2), Math.max(e[1] - w[1], 0).toFixed(2), Math.max(w[3] - e[3], 0).toFixed(2)];
      return `越界(西/东/南/北)=${over.join('/')} 度`;
    })();
    console.log(`  ${name}  zoom=${f2.zoom.toFixed(2)} ${blank}`);
    console.log(`      取景边界=[${f2.extent.map((v) => v.toFixed(2)).join(', ')}] 视口=[${f2.window.box.map((v) => v.toFixed(2)).join(', ')}] 中心=[${f2.center.map((v) => v.toFixed(2)).join(', ')}]`);
  };

  for (let i = 0; i < 90; i++) {
    await sleep(500);
    if ((await ev('typeof window.__probe').catch(() => 'no')) === 'object') break;
  }
  await ev(`(() => { document.getElementById('app').style.visibility = 'visible'; return true })()`);

  // ---- 中国族：贴边 vs 中央 ----
  const cn = [
    ['clamp-cn-north-daxinganling.png', '232700'], // 大兴安岭地区 [124.2, 52.3] 最北（bbox 北界 53.6）
    ['clamp-cn-west-kezilesu.png', '653000'],      // 克孜勒苏柯尔克孜自治州 [75.9, 39.7] 最西（bbox 西界 73.5）
    ['clamp-cn-east-shuangyashan.png', '230500'],  // 双鸭山市 [132.5, 46.7] 最东（bbox 东界 135.1）
    ['clamp-cn-south-sansha.png', '460300'],       // 三沙市 [114.3, 7.7] 最南（bbox 南界 3.4）
    ['clamp-cn-center-zhengzhou.png', '410100'],   // 郑州市 [113.5, 34.6] 中央对照
  ];
  for (const [file, adcode] of cn) {
    await ev(`window.__probe.followUnitShot('${adcode}', null)`);
    await sleep(1400);
    await ev(`window.__probe.flashTarget('${adcode}')`); // 标黄高亮，便于在截图里认出目标
    await sleep(150);
    await shot(file);
  }

  // ---- 下钻小省：倍率下限生效（宁夏 3.36°×4.15°，12x 视口远超它 → 抬到 28x 上限）----
  await ev(`window.__probe.followUnitShot('640100', '640000')`); // 下钻宁夏 → 跟随银川
  await sleep(1600);
  await ev(`window.__probe.flashTarget('640100')`);
  await sleep(150);
  await shot('clamp-nx-drill-ningxia.png');

  // ---- 世界族：北界 / ±180 / 正常对照 ----
  for (const [file, iso] of [['clamp-world-russia.png', 'RUS'], ['clamp-world-australia.png', 'AUS'], ['clamp-world-singapore.png', 'SGP']]) {
    await ev(`window.__probe.followShot('${iso}')`);
    await sleep(1400);
    await ev(`window.__probe.flashTarget('${iso}')`);
    await sleep(150);
    await shot(file);
  }
} catch (e) {
  console.error('ERR', e.message);
  process.exitCode = 1;
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  browser.kill(); server.kill();
  await sleep(400);
  try { fs.rmSync(userDir, { recursive: true, force: true }); } catch { /* ignore */ }
}
