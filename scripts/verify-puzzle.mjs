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

  // ---------------- 难度分段按钮：未开始时可见可切（看卡槽省名），开始后收起 ----------------
  const slotNames = async () => ev(`document.querySelectorAll('#puzzle .puzzle-slot-name').length`);
  check('未开始时「简单」显示省名（卡槽预览下的名称）', (await slotNames()) === (await ev(`document.querySelectorAll('#puzzle .puzzle-slot').length`)));
  await ev(`(() => { document.getElementById('puzzle-hard').click(); return true })()`);
  await sleep(250);
  const hardNames = await slotNames();
  const storedHard = await ev(`localStorage.getItem('china-admin-puzzle-difficulty-v1')`);
  check('切到「困难」后省名全部消失，并持久化本机', hardNames === 0 && storedHard === 'hard', { hardNames, storedHard });
  await shot('puzzle-4-start-hard.png');
  await ev(`(() => { document.getElementById('puzzle-easy').click(); return true })()`);
  await sleep(250);
  check('切回「简单」后省名恢复', (await slotNames()) > 0);

  // ---------------- 开始 + 计时 ----------------
  await ev(`(() => { document.getElementById('puzzle-start').click(); return true })()`);
  await sleep(600);
  const started = await puzzle();
  const statusText = await ev(`document.getElementById('puzzle-status').textContent`);
  check('点开始后：进度行出现「已拼 1/34 ｜ 用时 mm:ss」（已拼起始为 1，不随拿出碎片增加）',
    started.started === true && /已拼 1\/34/.test(statusText) && /用时 \d\d:\d\d/.test(statusText), { statusText, placed: started.placed });
  check('开始后收起「简单/困难」分段按钮（运行中不允许切换）',
    (await ev(`document.getElementById('puzzle-difficulty-toggle').classList.contains('hidden')`)) === true);
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
  check('从卡槽拖出碎片不增加「已拼」（只算吸附，起始 1）', /已拼 1\/34/.test(statusAfterDrag), statusAfterDrag);
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

  // ---------------- 拖动中「可吸附」绿色提示（两种难度都要有） ----------------
  /** 找到某片路径上可点中的屏幕坐标（bbox 中心可能落在凹形省的空洞里，故网格取点）。 */
  const pointOnPiece = async (adcode) => JSON.parse(await ev(`JSON.stringify((function(){
    var el = document.querySelector('#puzzle path[data-adcode="${adcode}"]');
    if (!el) return null;
    var r = el.getBoundingClientRect();
    for (var i = 1; i <= 5; i++) {
      for (var j = 1; j <= 5; j++) {
        var x = r.left + (r.width * i) / 6, y = r.top + (r.height * j) / 6;
        if (document.elementFromPoint(x, y) === el) return { x: x, y: y };
      }
    }
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })())`));
  /** 拖动中的可吸附提示：返回高亮组数、手里那块是否也高亮、以及目标片的实际描边。 */
  const snapHintState = async () => JSON.parse(await ev(`JSON.stringify((function(){
    var lit = document.querySelectorAll('#puzzle g.puzzle-piece-wrap.can-snap');
    var self = document.querySelectorAll('#puzzle g.puzzle-piece-wrap.can-snap-self');
    var target = lit.length ? lit[0].querySelector('path') : null;
    return {
      lit: lit.length,
      selfLit: self.length,
      stroke: target ? getComputedStyle(target).stroke : null,
      width: target ? getComputedStyle(target).strokeWidth : null,
      accent: getComputedStyle(document.body).getPropertyValue('--accent').trim(),
    };
  })())`));

  const checkSnapHint = async (difficulty, shotDuringDrag) => {
    // 走真实用户路径：重置回开始卡片 →（此时难度按钮已放出）切难度 → 开始 → 拖拽
    await ev(`(() => { document.getElementById('btn-reset').click(); return true })()`);
    await sleep(120);
    await ev(`(() => { document.getElementById('btn-reset').click(); return true })()`);
    await sleep(600);
    await ev(`(() => { document.getElementById('puzzle-${difficulty}').click(); return true })()`);
    await sleep(200);
    await ev(`(() => { document.getElementById('puzzle-start').click(); return true })()`);
    await sleep(300);
    const pBJ = await ev(`JSON.stringify(window.__probe.puzzleTruePosition('110000'))`).then((s) => JSON.parse(s));
    const pHB = await ev(`JSON.stringify(window.__probe.puzzleTruePosition('130000'))`).then((s) => JSON.parse(s));
    await ev(`window.__probe.puzzlePlaceAt('110000', ${pBJ.x}, ${pBJ.y})`);
    await ev(`window.__probe.puzzlePlaceAt('130000', ${pHB.x + 60}, ${pHB.y + 60})`);
    await sleep(150);
    const from = await pointOnPiece('130000');
    if (!from) return null;
    // 按住河北，往北京方向挪 50px（偏移差变成 ~10px → 进入容差），**松手前**检查高亮
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 });
    for (let i = 1; i <= 6; i++) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x - (50 * i) / 6, y: from.y - (50 * i) / 6, button: 'left', buttons: 1 });
      await sleep(20);
    }
    const hint = await snapHintState();
    if (shotDuringDrag) await shot(shotDuringDrag); // 趁还在拖、提示亮着的时候截图
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: from.x - 50, y: from.y - 50, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(150);
    return hint;
  };

  const hintEasy = await checkSnapHint('easy', 'puzzle-3b-snap-hint.png');
  check('简单难度：拖到可吸附范围时给出绿色提示（目标组绿边 + 绿辉光、手里那块也加绿边）',
    !!hintEasy && hintEasy.lit >= 1 && hintEasy.selfLit >= 1 && parseFloat(hintEasy.width) >= 2 && hintEasy.stroke !== 'none',
    hintEasy);
  const hintHard = await checkSnapHint('hard', 'puzzle-3c-snap-hint-hard.png');
  check('困难难度：拖到可吸附范围时同样给出绿色提示',
    !!hintHard && hintHard.lit >= 1 && hintHard.selfLit >= 1 && parseFloat(hintHard.width) >= 2 && hintHard.stroke !== 'none',
    hintHard);
  check('困难模式下画布上没有省名标签（提示不依赖标签）',
    (await ev(`document.querySelectorAll('#puzzle .puzzle-label').length`)) === 0);
  await ev(`(() => { document.getElementById('puzzle-easy').click(); return true })()`);
  await sleep(300);

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

  // ---------------- 重置 = 回到开始卡片 ----------------
  await ev(`(() => { document.getElementById('summary-close').click(); return true })()`);
  await sleep(200);
  await ev(`(() => { document.getElementById('btn-reset').click(); return true })()`);
  await sleep(150);
  await ev(`(() => { document.getElementById('btn-reset').click(); return true })()`); // 二次确认
  await sleep(700);
  const restarted = await puzzle();
  const restartDom = JSON.parse(await ev(`JSON.stringify({
    startCard: !!document.getElementById('puzzle-start'),
    statusHidden: document.getElementById('puzzle-status').classList.contains('hidden'),
    difficultyVisible: !document.getElementById('puzzle-difficulty-toggle').classList.contains('hidden'),
    pieces: document.querySelectorAll('#puzzle .puzzle-piece').length,
    slots: document.querySelectorAll('#puzzle .puzzle-slot').length,
  })`));
  check('「重置」= 回到开始卡片界面：画布清空、卡槽重新填满三片、进度行隐藏',
    restarted.started === false && restartDom.pieces === 0 && restartDom.slots === 3 && restartDom.statusHidden && restartDom.startCard,
    { started: restarted.started, ...restartDom });
  check('回到开始卡片后「简单/困难」分段按钮重新显现', restartDom.difficultyVisible === true, restartDom);

  // ---------------- 难度按钮的选中样式（与其它模式的分段按钮一致） ----------------
  const segStyle = JSON.parse(await ev(`JSON.stringify((function(){
    var cs = function(el){ var s = getComputedStyle(el); return { active: el.classList.contains('active'), bgImage: (s.backgroundImage || '').slice(0, 30), color: s.color }; };
    return { easy: cs(document.getElementById('puzzle-easy')), hard: cs(document.getElementById('puzzle-hard')), current: window.__probe.puzzle().difficulty };
  })())`));
  const activeSeg = segStyle.current === 'hard' ? segStyle.hard : segStyle.easy;
  const idleSeg = segStyle.current === 'hard' ? segStyle.easy : segStyle.hard;
  check('难度分段按钮的选中态用与其它模式同一套样式（active 类 + 深色渐变填充 + 白字）',
    activeSeg.active === true && activeSeg.bgImage.indexOf('gradient') >= 0 && idleSeg.active === false && idleSeg.bgImage === 'none',
    segStyle);
  await shot('puzzle-7-back-to-start.png');

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
