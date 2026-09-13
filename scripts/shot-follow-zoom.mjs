/**
 * 自动跟随倍率抽样：对代表性国家各出一张截图，用于目测「国家在屏幕上的占比」。
 * 输出到 docs/shots/follow-<ISO>.png
 *
 * 用法：node scripts/shot-follow-zoom.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BROWSER = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9975;
const CDP = 9976;
const OUT = path.join(ROOT, 'docs', 'shots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 覆盖：顶到上限的小国、中等国、超大国家，以及几个面积递减的中间档
const SAMPLES = [
  ['AND', '安道尔'],
  ['LIE', '列支敦士登'],
  ['MLT', '马耳他'],
  ['LUX', '卢森堡'],
  ['ISR', '以色列'],
  ['CHE', '瑞士'],
  ['KOR', '韩国'],
  ['PRT', '葡萄牙'],
  ['VNM', '越南'],
  ['DEU', '德国'],
  ['FRA', '法国'],
  ['TUR', '土耳其'],
  ['IND', '印度'],
  ['CHN', '中国'],
  ['USA', '美国'],
  ['RUS', '俄罗斯'],
];

fs.mkdirSync(OUT, { recursive: true });
const server = spawn(process.execPath, [path.join(ROOT, 'scripts', 'static-server.mjs'), String(PORT), path.join(ROOT, 'dist')], { stdio: 'ignore' });
await sleep(1200);
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fz-'));
const browser = spawn(BROWSER, ['--headless=new', '--disable-gpu', '--no-first-run', `--user-data-dir=${userDir}`, `--remote-debugging-port=${CDP}`, '--window-size=1280,900', '--force-device-scale-factor=1', 'about:blank'], { stdio: 'ignore' });

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
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?probe=1&g=world` });

  const ev = async (e) => {
    const r = await send('Runtime.evaluate', { expression: `(async () => (${e}))()`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed');
    return r.result.value;
  };
  for (let i = 0; i < 90; i++) {
    await sleep(500);
    if ((await ev('typeof window.__probe').catch(() => 'no')) === 'object') break;
  }

  for (const [iso, name] of SAMPLES) {
    const info = await ev(`window.__probe.followShot('${iso}')`);
    await sleep(1300); // 等动画结束 + 重绘
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    const f = path.join(OUT, `follow-${iso}.png`);
    fs.writeFileSync(f, Buffer.from(shot.data, 'base64'));
    console.log(`${iso.padEnd(4)} ${name.padEnd(7)} 面积=${String(info.area).padStart(10)}  倍率=${info.zoom.toFixed(2)}x  → follow-${iso}.png`);
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
