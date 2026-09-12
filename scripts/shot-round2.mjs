/**
 * 截图脚本：目测确认本轮视觉结果。
 *   shot1: 世界全图（默认）
 *   shot2: 下钻亚洲后（其余洲应为空白，且空白处无可高亮的国家）
 *   shot3: 开启「忽略面积极小的国家」后的世界全图（极小国家应灰显）
 *
 * 用法：node scripts/shot-round2.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BROWSER = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9981;
const CDP = 9982;
const OUT = path.join(ROOT, 'docs', 'shots');
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn(process.execPath, [path.join(ROOT, 'scripts', 'static-server.mjs'), String(PORT), path.join(ROOT, 'dist')], { stdio: 'ignore' });
await sleep(1200);
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shot-r2-'));
const browser = spawn(BROWSER, ['--headless=new', '--disable-gpu', '--no-first-run', `--user-data-dir=${userDir}`, `--remote-debugging-port=${CDP}`, '--window-size=1280,900', '--force-device-scale-factor=1', 'about:blank'], { stdio: 'ignore' });

let ws; let id = 0; const pending = new Map();
const send = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })); });

async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  const f = path.join(OUT, name);
  fs.writeFileSync(f, Buffer.from(r.data, 'base64'));
  console.log('saved', f, fs.statSync(f).size, 'bytes');
}

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

  const ev = async (e) => {
    const r = await send('Runtime.evaluate', { expression: `(async () => (${e}))()`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed');
    return r.result.value;
  };
  const waitProbe = async () => {
    for (let i = 0; i < 90; i++) {
      await sleep(500);
      if ((await ev('typeof window.__probe').catch(() => 'no')) === 'object') return true;
    }
    return false;
  };
  const goto = async (query) => {
    await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?probe=1&${query}` });
    await sleep(2500);
    await waitProbe();
    await sleep(2500);
  };

  // 1) 世界全图
  await goto('g=world');
  await shot('round2-1-world.png');

  // 2) 下钻亚洲（走真实深链路径 ?g=world&c=AS，而不是直接调渲染器）
  await goto('g=world&c=AS');
  const asiaScope = await ev('JSON.stringify(window.__probe.renderedRegions())');
  console.log('下钻亚洲后的 region 状态:', asiaScope);
  await shot('round2-2-asia-drill.png');

  // 3) 开启「忽略面积极小的国家」后再看世界全图（6 个极小国应灰显）
  await goto('g=world');
  await ev('(async () => { await window.__probe.toggleTiny(true); return true })()');
  await sleep(2200);
  await shot('round2-3-tiny-ignored.png');
  await ev('(async () => { await window.__probe.toggleTiny(false); return true })()');

} catch (e) {
  console.error('ERR', e.message);
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  browser.kill(); server.kill();
  await sleep(400);
  try { fs.rmSync(userDir, { recursive: true, force: true }); } catch { /* ignore */ }
}
