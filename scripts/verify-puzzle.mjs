/**
 * 拼图模式（puzzle）真机验收：拖拽 / 磁吸成组 / 难度 / 未开放提示 / 暂停 / 获胜 / 重置 + 截图。
 *
 * 用法：npm run build && node scripts/verify-puzzle.mjs
 * 产物：docs/shots/puzzle-*.png
 *
 * 拖拽用 CDP 的真实鼠标事件（Chrome 会据此合成 pointerdown/move/up），
 * 吸附判定与获胜流程则走探针（`puzzlePlaceAt` / `puzzleAutoSolve`）以便确定性断言。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BROWSER = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9983;
const CDP = 9984;
const OUT = path.join(ROOT, 'docs', 'shots');
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn(process.execPath, [path.join(ROOT, 'scripts', 'static-server.mjs'), String(PORT), path.join(ROOT, 'dist')], { stdio: 'ignore' });
await sleep(1200);
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-puzzle-'));
const browser = spawn(BROWSER, ['--headless=new', '--disable-gpu', '--no-first-run', `--user-data-dir=${userDir}`, `--remote-debugging-port=${CDP}`, '--window-size=1440,900', '--force-device-scale-factor=1', 'about:blank'], { stdio: 'ignore' });

let ws; let id = 0; const pending = new Map();
const send = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })); });

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : '  → ' + JSON.stringify(detail)}`);
};

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
    fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, 'base64'));
    console.log('  截图', name);
  };
  const puzzle = () => ev('JSON.stringify(window.__probe.puzzle())').then((s) => JSON.parse(s));

  /** 真实鼠标拖拽（CDP 会合成 pointer 事件）。 */
  const drag = async (from, to, steps = 8) => {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 });
    for (let i = 1; i <= steps; i++) {
      const x = from.x + ((to.x - from.x) * i) / steps;
      const y = from.y + ((to.y - from.y) * i) / steps;
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 });
      await sleep(16);
    }
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(120);
  };
  const click = async (x, y) => {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(160);
  };

  for (let i = 0; i < 90; i++) {
    await sleep(500);
    if ((await ev('typeof window.__probe').catch(() => 'no')) === 'object') break;
  }

  // ---------------- 页签位置 ----------------
  const tabs = JSON.parse(await ev(`JSON.stringify(Array.prototype.map.call(document.querySelectorAll('#mode-tabs button'), function(b){ return b.textContent; }))`));
  check('页签顺序：输入模式右边、无尽闯关左边新增「拼图模式」',
    tabs.join('/') === '点击模式/输入模式/拼图模式/无尽闯关/自由模式', tabs);

  // ---------------- 进入拼图：无地图 + 三个卡槽 ----------------
  await ev(`(() => { document.querySelector('#mode-tabs button[data-mode="puzzle"]').click(); return true })()`);
  await sleep(900);
  const entered = JSON.parse(await ev(`JSON.stringify((function(){
    var slots = document.querySelectorAll('#puzzle .puzzle-slot');
    var previews = Array.prototype.map.call(slots, function(s){ return (s.querySelector('path')||{}).getAttribute ? s.querySelector('path').getAttribute('d').length : 0; });
    return {
      mapHidden: document.getElementById('map').classList.contains('hidden'),
      puzzleVisible: !document.getElementById('puzzle').classList.contains('hidden'),
      slotCount: slots.length,
      previewsOk: previews.every(function(n){ return n > 50; }),
      hasStartCard: !!document.getElementById('puzzle-start'),
      statusHidden: document.getElementById('puzzle-status').classList.contains('hidden'),
      insetHidden: document.getElementById('hkmac-inset').classList.contains('hidden'),
      sidePanelHidden: document.getElementById('side-panel').classList.contains('hidden'),
      difficultyVisible: !document.getElementById('puzzle-difficulty-toggle').classList.contains('hidden'),
      granularityVisible: !document.getElementById('granularity-toggle').classList.contains('hidden'),
      pieces: document.querySelectorAll('#puzzle .puzzle-piece').length,
    };
  })())`));
  check('进入后没有地图（#map 隐藏、#puzzle 显示、港澳放大框收起）', entered.mapHidden && entered.puzzleVisible && entered.insetHidden, entered);
  check('左侧三个玻璃态卡槽，槽内都有真实几何预览', entered.slotCount === 3 && entered.previewsOk, entered);
  check('画布上没有任何碎片（0 片）、先出「开始」卡片、进度行隐藏', entered.pieces === 0 && entered.hasStartCard && entered.statusHidden, entered);
  check('难度分段按钮与粒度分段按钮都显示（侧栏不出现）', entered.difficultyVisible && entered.granularityVisible && entered.sidePanelHidden, entered);
  await shot('puzzle-1-start.png');

  // ---------------- 开始 + 计时 ----------------
  await ev(`(() => { document.getElementById('puzzle-start').click(); return true })()`);
  await sleep(600);
  const started = await puzzle();
  const statusText = await ev(`document.getElementById('puzzle-status').textContent`);
  check('点开始后：已拼 0/34、进度行出现「已拼/用时」', started.started === true && started.placed === 0 && /已拼 0\/34/.test(statusText) && /用时 \d\d:\d\d/.test(statusText), { statusText, placed: started.placed });
  const buttons = JSON.parse(await ev(`JSON.stringify({
    skip: document.getElementById('btn-skip').classList.contains('hidden'),
    pause: document.getElementById('btn-end').classList.contains('hidden'),
    reset: document.getElementById('btn-reset').classList.contains('hidden'),
  })`));
  check('开始后：不显示「跳过」，显示「暂停」与「重置」', buttons.skip === true && buttons.pause === false && buttons.reset === false, buttons);

  // ---------------- 真实拖拽：从卡槽拖到画布 ----------------
  const slotRect = JSON.parse(await ev(`JSON.stringify((function(){ var r = document.querySelector('#puzzle .puzzle-slot').getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })())`));
  const firstAdcode = await ev(`document.querySelector('#puzzle .puzzle-slot').dataset.adcode`);
  await drag(slotRect, { x: slotRect.x + 320, y: slotRect.y - 120 });
  const afterDrag = await puzzle();
  const slotsAfter = afterDrag.slots.join(',');
  check('真实拖拽：碎片离开卡槽落到画布、卡槽立刻补上新片',
    afterDrag.placed === 1 && afterDrag.groups.length === 1 && !afterDrag.slots.includes(firstAdcode) && afterDrag.slots.length === 3,
    { placed: afterDrag.placed, slots: afterDrag.slots, firstAdcode });
  const statusAfterDrag = await ev(`document.getElementById('puzzle-status').textContent`);
  check('进度行随拖拽更新为「已拼 1/34」', /已拼 1\/34/.test(statusAfterDrag), statusAfterDrag);
  await shot('puzzle-2-dragged.png');

  // ---------------- 磁吸：相邻两片接近 → 合并；差太远 → 不合并 ----------------
  const truePosA = await ev(`JSON.stringify(window.__probe.puzzleTruePosition('110000'))`).then((s) => JSON.parse(s)); // 北京
  const truePosB = await ev(`JSON.stringify(window.__probe.puzzleTruePosition('130000'))`).then((s) => JSON.parse(s)); // 河北（与北京相邻）
  check('北京与河北的真值位置都在拼图坐标系内（探针可用）', !!truePosA && !!truePosB && truePosA.scale > 5, { a: truePosA, b: truePosB });

  // 先把北京放到真值位置，再把河北放到"差 12px"处 → 应吸合
  await ev(`window.__probe.puzzlePlaceAt('110000', ${truePosA.x}, ${truePosA.y})`);
  const nearDrop = await ev(`JSON.stringify(window.__probe.puzzlePlaceAt('130000', ${truePosB.x + 9}, ${truePosB.y + 8}))`).then((s) => JSON.parse(s));
  const afterSnap = await puzzle();
  const bjGroup = afterSnap.groups.find((g) => g.pieces.includes('110000'));
  check('相邻两片偏移差在容差内 → 精确对齐合成一组',
    nearDrop.mergedGroups === 1 && afterSnap.groups.some((g) => g.pieces.length === 2 && g.pieces.includes('110000') && g.pieces.includes('130000')),
    { nearDrop, groups: afterSnap.groups.map((g) => g.pieces.length) });
  // 对齐到"被拖动的一方"（河北落在真值 +9,+8 处）→ 两片共享该偏移，相对偏移归零
  check('成组后两片共享同一偏移（零缝隙对齐到被拖动的一方）',
    !!bjGroup && Math.abs(bjGroup.dx - 9) <= 2 && Math.abs(bjGroup.dy - 8) <= 2 && bjGroup.pieces.length === 2,
    { group: bjGroup });

  // 不相邻的一片放到同一位置 → 不吸（北京↔台湾 不相邻）
  const truePosC = await ev(`JSON.stringify(window.__probe.puzzleTruePosition('710000'))`).then((s) => JSON.parse(s)); // 台湾
  await ev(`window.__probe.puzzlePlaceAt('710000', ${truePosC.x + 6}, ${truePosC.y + 6})`);
  const afterFar = await puzzle();
  const twGroup = afterFar.groups.find((g) => g.pieces.includes('710000'));
  check('台湾与北京不相邻 → 即使放在一起也不吸合（台湾仍是独立单片组）',
    !!twGroup && twGroup.pieces.length === 1 && !twGroup.pieces.includes('110000'),
    afterFar.groups.map((g) => g.pieces));
  await shot('puzzle-3-snapped.png');

  // ---------------- 难度：只影响省名标签 ----------------
  const labelsEasy = await ev(`document.querySelectorAll('#puzzle .puzzle-label').length`);
  await ev(`(() => { document.getElementById('puzzle-hard').click(); return true })()`);
  await sleep(300);
  const labelsHard = await ev(`document.querySelectorAll('#puzzle .puzzle-label').length`);
  const storedHard = await ev(`localStorage.getItem('china-admin-puzzle-difficulty-v1')`);
  check('难度=简单时显示省名，切到困难后标签全部消失（并持久化）',
    labelsEasy > 0 && labelsHard === 0 && storedHard === 'hard', { labelsEasy, labelsHard, storedHard });
  await shot('puzzle-4-hard.png');
  await ev(`(() => { document.getElementById('puzzle-easy').click(); return true })()`);
  await sleep(300);
  check('切回简单后标签恢复', (await ev(`document.querySelectorAll('#puzzle .puzzle-label').length`)) > 0);

  // ---------------- 未开放的粒度 ----------------
  await ev(`(() => { document.getElementById('granularity-world').click(); return true })()`);
  await sleep(300);
  const granularityProbe = JSON.parse(await ev(`JSON.stringify({
    toast: document.getElementById('toast').textContent,
    active: (document.querySelector('#granularity-toggle button.active')||{}).textContent,
    granularity: window.__probe.puzzle().granularity,
  })`));
  check('点「世界」提示暂未开放，且仍停在省级',
    granularityProbe.toast.includes('暂未开放') && granularityProbe.active === '省级' && granularityProbe.granularity === 'province',
    granularityProbe);

  // ---------------- 暂停：停表 + 遮罩 ----------------
  const elapsedBefore = (await puzzle()).elapsedMs;
  await ev(`(() => { document.getElementById('btn-end').click(); return true })()`);
  await sleep(900);
  const pausedState = await puzzle();
  const pausedDom = JSON.parse(await ev(`JSON.stringify({
    overlay: !document.getElementById('pause-overlay').classList.contains('hidden'),
    appPaused: document.getElementById('app').classList.contains('test-paused'),
  })`));
  check('点暂停：出现「点击继续」遮罩、画布模糊、计时停住（暂停期间不累计）',
    pausedState.paused === true && pausedDom.overlay && pausedDom.appPaused &&
      Math.abs(pausedState.elapsedMs - elapsedBefore) < 120 && pausedState.elapsedMs > 0,
    { paused: pausedState.paused, ...pausedDom, elapsedBefore, elapsedAfter: pausedState.elapsedMs });
  await shot('puzzle-5-paused.png');
  await click(720, 460); // 点遮罩继续
  await sleep(500);
  check('点遮罩后恢复（不再暂停）', (await puzzle()).paused === false);

  // ---------------- 获胜：一整块 + 补三沙 + 完成卡片 ----------------
  const solved = await ev(`window.__probe.puzzleAutoSolve()`);
  await sleep(1600);
  const win = await puzzle();
  const winDom = JSON.parse(await ev(`JSON.stringify({
    summaryVisible: !document.getElementById('summary').classList.contains('hidden'),
    body: document.getElementById('summary-body').textContent,
    restartLabel: document.getElementById('summary-restart').textContent,
    seaIslets: document.querySelectorAll('#puzzle .puzzle-sea-islets').length,
  })`));
  check('把 34 片全部放到真值位置 → 吸成一整块（获胜）', solved === true && win.complete === true && win.groups.length === 1 && win.groups[0].pieces.length === 34, { solved, groups: win.groups.length, complete: win.complete });
  check('获胜后弹完成卡片：显示用时 + 「再来一局」', winDom.summaryVisible && /拼好了/.test(winDom.body) && /用时/.test(winDom.body) && winDom.restartLabel === '再来一局', winDom);
  check('获胜后自动补上三沙等远海岛礁（归入海南所在组）', winDom.seaIslets >= 1, { seaIslets: winDom.seaIslets });
  await shot('puzzle-6-win.png');

  // ---------------- 重置 = 重开一局 ----------------
  await ev(`(() => { document.getElementById('summary-close').click(); return true })()`);
  await sleep(200);
  await ev(`(() => { document.getElementById('btn-reset').click(); return true })()`);
  await sleep(150);
  await ev(`(() => { document.getElementById('btn-reset').click(); return true })()`); // 二次确认
  await sleep(600);
  const restarted = await puzzle();
  const restartStatus = await ev(`document.getElementById('puzzle-status').textContent`);
  check('「重置」= 重开一局：已拼回到 0/34、卡槽重新填满三片',
    restarted.placed === 0 && restarted.slots.length === 3 && restarted.complete === false && /已拼 0\/34/.test(restartStatus),
    { placed: restarted.placed, slots: restarted.slots, restartStatus });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) process.exitCode = 1;
} catch (e) {
  console.error('ERR', e.message);
  process.exitCode = 1;
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  browser.kill(); server.kill();
  await sleep(400);
  try { fs.rmSync(userDir, { recursive: true, force: true }); } catch { /* ignore */ }
}
