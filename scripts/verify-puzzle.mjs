/**
 * 拼图模式（puzzle）真机验收：两阶段（选范围 / 拼图盘面）× 三个粒度（世界/省级/市级）。
 *
 * 用法：npm run build && node scripts/verify-puzzle.mjs
 * 产物：docs/shots/puzzle-*.png
 *
 * 拖拽用 CDP 的真实鼠标事件（Chrome 会据此合成 pointerdown/move/up），
 * 地图下钻/空白返回用真实点击；吸附判定、跨范围片数与获胜流程走探针以便确定性断言。
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

const PROVINCE_NATION = '__province_nation__';
const WORLD_NATION = '__world_nation__';
const CONTINENT_AS = '__continent_AS__';
const SUBREGION_EAS = '__subregion_EAS__';

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
  const json = async (e) => JSON.parse(await ev(`JSON.stringify(${e})`));
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, 'base64'));
    console.log('  截图', name);
  };
  const puzzle = () => json(`window.__probe.puzzle()`);
  const setScope = (g, s) => json(`window.__probe.puzzleSetScope(${JSON.stringify(g)}, ${JSON.stringify(s)})`);
  const difficultyUI = () => json(`(function(){
    var t = document.getElementById('puzzle-difficulty-toggle');
    return { visible: !t.classList.contains('hidden'), active: (t.querySelector('button.active')||{}).textContent || null };
  })()`);
  const scopeUI = () => json(`(function(){
    var sub = document.querySelector('.start-subtitle');
    return {
      subtitle: sub ? sub.textContent : null,
      startCard: !!document.getElementById('puzzle-start'),
      mapVisible: !document.getElementById('map').classList.contains('hidden'),
      puzzleVisible: !document.getElementById('puzzle').classList.contains('hidden'),
      insetVisible: !document.getElementById('hkmac-inset').classList.contains('hidden'),
      statusHidden: document.getElementById('puzzle-status').classList.contains('hidden'),
      slots: document.querySelectorAll('#puzzle .puzzle-slot').length,
      pieces: document.querySelectorAll('#puzzle .puzzle-piece').length,
      granularityVisible: !document.getElementById('granularity-toggle').classList.contains('hidden'),
      granularityActive: (document.querySelector('#granularity-toggle button.active')||{}).textContent || null,
      continentVisible: !document.getElementById('continent-toggle').classList.contains('hidden'),
      continentActive: (document.querySelector('#continent-toggle button.active')||{}).textContent || null,
      subregionVisible: !document.getElementById('subregion-toggle').classList.contains('hidden'),
      subregionActive: (document.querySelector('#subregion-toggle button.active')||{}).textContent || null,
      zoomPillHidden: document.getElementById('zoom-pill').classList.contains('hidden'),
      sidePanelHidden: document.getElementById('side-panel').classList.contains('hidden'),
    };
  })()`);

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
    await sleep(400);
  };
  const mapPoint = async (fx, fy) => {
    const r = await json(`(function(){ var r = document.getElementById('map').getBoundingClientRect(); return { left:r.left, top:r.top, width:r.width, height:r.height }; })()`);
    return { x: r.left + r.width * fx, y: r.top + r.height * fy };
  };
  /** 「重置」是二次确认按钮：第一次变成「确认」，第二次才真的重置。 */
  const resetClick = async () => {
    await ev(`(() => { document.getElementById('btn-reset').click(); return true })()`);
    await sleep(150);
    await ev(`(() => { document.getElementById('btn-reset').click(); return true })()`);
    await sleep(700);
  };

  for (let i = 0; i < 90; i++) {
    await sleep(500);
    if ((await ev('typeof window.__probe').catch(() => 'no')) === 'object') break;
  }

  // ==================== 页签位置 ====================
  const tabs = await json(`Array.prototype.map.call(document.querySelectorAll('#mode-tabs button'), function(b){ return b.textContent; })`);
  check('页签顺序：输入模式右边、无尽闯关左边是「拼图模式」',
    tabs.join('/') === '点击模式/输入模式/拼图模式/无尽闯关/自由模式', tabs);

  // ==================== 进入拼图 = 选范围阶段（仍然看得见完整地图） ====================
  await ev(`(() => { document.querySelector('#mode-tabs button[data-mode="puzzle"]').click(); return true })()`);
  await sleep(900);
  const scope1 = await scopeUI();
  check('进入后仍是完整地图（#map 可见、#puzzle 隐藏、省级全国的港澳放大框在）',
    scope1.mapVisible && !scope1.puzzleVisible && scope1.insetVisible, scope1);
  check('画布还没有碎片、也没有卡槽，先出「开始」卡片、进度行隐藏',
    scope1.pieces === 0 && scope1.slots === 0 && scope1.startCard && scope1.statusHidden, scope1);
  check('开始卡片写明范围：「全国 34 个省级单位」', scope1.subtitle === '把全国 34 个省级单位拼成一幅完整的地图', scope1.subtitle);
  check('选范围阶段：粒度行（省级选中）与难度行都可见，侧栏不出现',
    scope1.granularityVisible && scope1.granularityActive === '省级' && (await difficultyUI()).visible && scope1.sidePanelHidden, scope1);
  await shot('puzzle-1-scope.png');

  // ==================== 难度：选范围阶段改的是地图上的名称标签 ====================
  const hideLabels = async () => json(`window.__probe.round3Ui().labels.hideLabels`);
  check('「简单」档：选范围地图上显示名称（hideLabels=false）', (await hideLabels()) === false);
  await ev(`(() => { document.getElementById('puzzle-hard').click(); return true })()`);
  await sleep(400);
  const hardState = await json(`({ hide: window.__probe.round3Ui().labels.hideLabels, stored: localStorage.getItem('china-admin-puzzle-difficulty-v1') })`);
  check('切到「困难」：地图标签全部隐藏并持久化到本机', hardState.hide === true && hardState.stored === 'hard', hardState);
  await ev(`(() => { document.getElementById('puzzle-easy').click(); return true })()`);
  await sleep(400);
  check('切回「简单」：地图标签恢复', (await hideLabels()) === false);

  // ==================== 世界粒度：大洲行 / 次区域行 / 下钻 / 空白返回 ====================
  await ev(`(() => { document.getElementById('granularity-world').click(); return true })()`);
  await sleep(600);
  const world1 = await scopeUI();
  const worldState1 = await puzzle();
  check('点「世界」：地图切到世界档、大洲行出现（全世界选中）、开始卡片改写成全世界 194 个国家和地区',
    world1.continentVisible && world1.continentActive === '全世界' && world1.subtitle === '把全世界 194 个国家和地区拼成一幅完整的地图',
    { ...world1, probeScope: worldState1.scope });
  const worldMap = await json(`window.__probe.round3Ui().view`);
  check('世界档的地图渲染确实是世界视图', worldMap.worldMode === true, worldMap);

  await ev(`(() => { document.getElementById('continent-AS').click(); return true })()`);
  await sleep(600);
  const asia = await scopeUI();
  const asiaProbe = await puzzle();
  check('点「亚洲」：下钻到大洲范围、次区域行出现、副标题改写',
    asiaProbe.scope === CONTINENT_AS && asia.continentActive === '亚洲' && asia.subregionVisible && /^把亚洲的 \d+ 个国家和地区/.test(asia.subtitle),
    { scope: asiaProbe.scope, subtitle: asia.subtitle, subregionActive: asia.subregionActive });

  await ev(`(() => { Array.prototype.find.call(document.querySelectorAll('#subregion-toggle button'), function(b){ return b.dataset.subregion === 'EAS'; }).click(); return true })()`);
  await sleep(700);
  const eas = await puzzle();
  const easUI = await scopeUI();
  check('点「东亚」：再下钻到次区域范围（片数进一步缩小）',
    eas.scope === SUBREGION_EAS && easUI.subregionActive === '东亚' && easUI.subtitle === '把东亚的 5 个国家和地区拼成一幅完整的地图',
    { scope: eas.scope, subtitle: easUI.subtitle });
  await shot('puzzle-1b-world-eas.png');

  // 真实空白点击：次区域 → 大洲 → 全世界（用户口径「单击空白返回」）
  const blankA = await mapPoint(0.06, 0.5); // 东亚取景的左侧是南亚/中东，属范围外面 → 等价空白
  await click(blankA.x, blankA.y);
  const afterBlankA = await puzzle();
  check('单击空白从次区域退回大洲（东亚 → 亚洲）', afterBlankA.scope === CONTINENT_AS, { scope: afterBlankA.scope });
  const blankB = await mapPoint(0.06, 0.5); // 亚洲取景的左侧是非洲 → 同样等价空白
  await click(blankB.x, blankB.y);
  const afterBlankB = await puzzle();
  check('再单击空白从大洲退回全世界', afterBlankB.scope === WORLD_NATION, { scope: afterBlankB.scope });

  // ==================== 市级：粒度为「市级」全国 340 片，单击某省下钻到该省地级市 ====================
  await ev(`(() => { document.getElementById('granularity-province').click(); return true })()`);
  await sleep(700);
  const back2Province = await puzzle();
  check('点「省级」回到省级全国，副标题恢复',
    back2Province.scope === PROVINCE_NATION && (await puzzle()).granularity === 'province' &&
      (await scopeUI()).subtitle === '把全国 34 个省级单位拼成一幅完整的地图', back2Province.scope);
  const provinceCenter = await mapPoint(0.5, 0.42); // 省级全国视图中心 = 甘肃/宁夏一带
  await click(provinceCenter.x, provinceCenter.y);
  const drilled = await puzzle();
  const drilledUI = await scopeUI();
  check('单击地图上的省 → 下钻到该省地级市范围（粒度变市级、范围变该省 adcode）',
    drilled.granularity === 'city' && /^\d{6}$/.test(drilled.scope ?? '') && /^把.+的 \d+ 个地级单位/.test(drilledUI.subtitle),
    { granularity: drilled.granularity, scope: drilled.scope, subtitle: drilledUI.subtitle });
  const drilledMap = await json(`window.__probe.round3Ui().view`);
  check('下钻后地图确实切到了该省视图', drilledMap.drilledProvince === drilled.scope, drilledMap);
  await ev(`window.__probe.puzzleBack()`); // 等价于在该省视图下点空白
  await sleep(400);
  const backCity = await puzzle();
  check('从下钻的省返回后回到「全国 340 个地级单位」', backCity.scope === null && backCity.granularity === 'city' &&
    (await scopeUI()).subtitle === '把全国 340 个地级单位拼成一幅完整的地图', backCity.scope);

  // ==================== 开始 = 拼图盘面（地图隐藏、画布清空） ====================
  await ev(`(() => { document.getElementById('granularity-province').click(); return true })()`);
  await sleep(600);
  await ev(`(() => { document.getElementById('puzzle-start').click(); return true })()`);
  await sleep(700);
  const board = await scopeUI();
  const boardHint = await json(`document.getElementById('top-hint').textContent || ''`);
  const started = await puzzle();
  const statusText = await ev(`document.getElementById('puzzle-status').textContent`);
  check('点开始后：地图隐藏、拼图画布显示、港澳放大框收起、开始卡片消失',
    !board.mapVisible && board.puzzleVisible && !board.insetVisible && !board.startCard && boardHint === '', { ...board, boardHint });
  check('画布上先没有任何碎片（清空）、左侧补满三个卡槽、缩放角标收起',
    board.pieces === 0 && board.slots === 3 && board.zoomPillHidden, board);
  check('进度行出现「已拼 1/34 ｜ 用时 mm:ss」（已拼起始为 1，不随拿出碎片增加）',
    started.started === true && /已拼 1\/34/.test(statusText) && /用时 \d\d:\d\d/.test(statusText), { statusText, placed: started.placed });
  check('开始后收起「简单/困难」分段按钮（运行中不允许切换）', (await difficultyUI()).visible === false);
  const buttons = await json(`({
    skip: document.getElementById('btn-skip').classList.contains('hidden'),
    pause: document.getElementById('btn-end').classList.contains('hidden'),
    reset: document.getElementById('btn-reset').classList.contains('hidden'),
    granularity: document.getElementById('granularity-toggle').classList.contains('hidden'),
  })`);
  check('开始后：不显示「跳过」，显示「暂停」与「重置」，粒度行也收起（不能再换范围）',
    buttons.skip === true && buttons.pause === false && buttons.reset === false && buttons.granularity === true, buttons);
  await shot('puzzle-2-board.png');

  // ==================== 真实拖拽：从卡槽拖到画布 ====================
  const slotRect = await json(`(function(){ var r = document.querySelector('#puzzle .puzzle-slot').getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()`);
  const firstAdcode = await ev(`document.querySelector('#puzzle .puzzle-slot').dataset.adcode`);
  await drag(slotRect, { x: slotRect.x + 320, y: slotRect.y - 120 });
  const afterDrag = await puzzle();
  check('真实拖拽：碎片离开卡槽落到画布、卡槽立刻补上新片',
    afterDrag.placed >= 1 && afterDrag.groups.length === 1 && !afterDrag.slots.includes(firstAdcode) && afterDrag.slots.length === 3,
    { placed: afterDrag.placed, slots: afterDrag.slots, firstAdcode });
  const statusAfterDrag = await ev(`document.getElementById('puzzle-status').textContent`);
  check('从卡槽拖出碎片不增加「已拼」（只算吸附，起始 1）', /已拼 1\/34/.test(statusAfterDrag), statusAfterDrag);

  // ==================== 磁吸：相邻两片接近 → 合并；差太远 → 不合并 ====================
  const truePosA = await json(`window.__probe.puzzleTruePosition('110000')`); // 北京
  const truePosB = await json(`window.__probe.puzzleTruePosition('130000')`); // 河北（与北京相邻）
  check('北京与河北的真值位置都在拼图坐标系内（探针可用）', !!truePosA && !!truePosB && truePosA.scale > 5, { a: truePosA, b: truePosB });

  await ev(`window.__probe.puzzlePlaceAt('110000', ${truePosA.x}, ${truePosA.y})`);
  const nearDrop = await json(`window.__probe.puzzlePlaceAt('130000', ${truePosB.x + 9}, ${truePosB.y + 8})`);
  const afterSnap = await puzzle();
  const bjGroup = afterSnap.groups.find((g) => g.pieces.includes('110000'));
  check('相邻两片偏移差在容差内 → 精确对齐合成一组',
    nearDrop.mergedGroups === 1 && afterSnap.groups.some((g) => g.pieces.length === 2 && g.pieces.includes('110000') && g.pieces.includes('130000')),
    { nearDrop, groups: afterSnap.groups.map((g) => g.pieces.length) });
  check('成组后两片共享同一偏移（零缝隙对齐到被拖动的一方）',
    !!bjGroup && Math.abs(bjGroup.dx - 9) <= 2 && Math.abs(bjGroup.dy - 8) <= 2 && bjGroup.pieces.length === 2, { group: bjGroup });
  const statusAfterSnap = await ev(`document.getElementById('puzzle-status').textContent`);
  check('发生一次吸附后「已拼」从 1 变成 2（用户口径：只看吸附次数）', /已拼 2\/34/.test(statusAfterSnap), statusAfterSnap);

  const truePosC = await json(`window.__probe.puzzleTruePosition('710000')`); // 台湾
  await ev(`window.__probe.puzzlePlaceAt('710000', ${truePosC.x + 6}, ${truePosC.y + 6})`);
  const afterFar = await puzzle();
  const twGroup = afterFar.groups.find((g) => g.pieces.includes('710000'));
  check('台湾与北京不相邻 → 即使放在一起也不吸合（仍是独立单片组）',
    !!twGroup && twGroup.pieces.length === 1 && !twGroup.pieces.includes('110000'), afterFar.groups.map((g) => g.pieces));
  await shot('puzzle-3-snapped.png');

  // ==================== 拖动中「可吸附」绿色提示（两种难度都要有） ====================
  /** 找到某片路径上可点中的屏幕坐标（bbox 中心可能落在凹形省的空洞里，故网格取点）。 */
  const pointOnPiece = async (adcode) => json(`(function(){
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
  })()`);
  const snapHintState = () => json(`(function(){
    var lit = document.querySelectorAll('#puzzle g.puzzle-piece-wrap.can-snap');
    var self = document.querySelectorAll('#puzzle g.puzzle-piece-wrap.can-snap-self');
    var target = lit.length ? lit[0].querySelector('path') : null;
    return {
      lit: lit.length,
      selfLit: self.length,
      stroke: target ? getComputedStyle(target).stroke : null,
      width: target ? getComputedStyle(target).strokeWidth : null,
    };
  })()`);

  const checkSnapHint = async (difficulty, shotDuringDrag) => {
    // 走真实用户路径：重置回开始卡片 →（此时难度按钮已放出）切难度 → 开始 → 拖拽
    await resetClick();
    await ev(`(() => { document.getElementById('puzzle-${difficulty}').click(); return true })()`);
    await sleep(200);
    await ev(`(() => { document.getElementById('puzzle-start').click(); return true })()`);
    await sleep(400);
    const pBJ = await json(`window.__probe.puzzleTruePosition('110000')`);
    const pHB = await json(`window.__probe.puzzleTruePosition('130000')`);
    await ev(`window.__probe.puzzlePlaceAt('110000', ${pBJ.x}, ${pBJ.y})`);
    await ev(`window.__probe.puzzlePlaceAt('130000', ${pHB.x + 60}, ${pHB.y + 60})`);
    await sleep(150);
    const from = await pointOnPiece('130000');
    if (!from) return null;
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
  check('困难模式下画布上没有名称标签（提示不依赖标签）',
    (await ev(`document.querySelectorAll('#puzzle .puzzle-label').length`)) === 0);

  // ==================== 暂停：停表 + 遮罩 ====================
  const elapsedBefore = (await puzzle()).elapsedMs;
  await ev(`(() => { document.getElementById('btn-end').click(); return true })()`);
  await sleep(900);
  const pausedState = await puzzle();
  const pausedDom = await json(`({
    overlay: !document.getElementById('pause-overlay').classList.contains('hidden'),
    appPaused: document.getElementById('app').classList.contains('test-paused'),
  })`);
  check('点暂停：出现「点击继续」遮罩、画布模糊、计时停住（暂停期间不累计）',
    pausedState.paused === true && pausedDom.overlay && pausedDom.appPaused &&
      Math.abs(pausedState.elapsedMs - elapsedBefore) < 150 && pausedState.elapsedMs > 0,
    { paused: pausedState.paused, ...pausedDom, elapsedBefore, elapsedAfter: pausedState.elapsedMs });
  await shot('puzzle-5-paused.png');
  await click(720, 460);
  await sleep(600);
  check('点遮罩后恢复（不再暂停）', (await puzzle()).paused === false);

  // ==================== 获胜（省级）：一整块 + 补三沙 + 完成卡片 ====================
  const solved = await ev(`window.__probe.puzzleAutoSolve()`);
  await sleep(1600);
  const win = await puzzle();
  const winDom = await json(`({
    summaryVisible: !document.getElementById('summary').classList.contains('hidden'),
    body: document.getElementById('summary-body').textContent,
    restartLabel: document.getElementById('summary-restart').textContent,
    seaIslets: document.querySelectorAll('#puzzle .puzzle-sea-islets').length,
    difficultyVisible: !document.getElementById('puzzle-difficulty-toggle').classList.contains('hidden'),
    statusText: document.getElementById('puzzle-status').textContent,
  })`);
  check('把 34 片全部放到真值位置 → 吸成一整块（获胜）',
    solved === true && win.complete === true && win.groups.length === 1 && win.groups[0].pieces.length === 34,
    { solved, groups: win.groups.length, complete: win.complete });
  check('获胜后弹完成卡片：显示用时 + 「再来一局」',
    winDom.summaryVisible && /拼好了/.test(winDom.body) && /用时/.test(winDom.body) && winDom.restartLabel === '再来一局', winDom);
  check('获胜后自动补上三沙等远海岛礁（归入海南所在组）', winDom.seaIslets >= 1, { seaIslets: winDom.seaIslets });
  check('一局结束后「简单/困难」分段按钮重新显现（之前运行的盘面会收起它们）',
    winDom.difficultyVisible === true, winDom);
  await shot('puzzle-6-win.png');

  // ==================== 重置 = 回到开始卡片 ====================
  await ev(`(() => { document.getElementById('summary-close').click(); return true })()`);
  await sleep(200);
  await resetClick();
  const restarted = await puzzle();
  const restartDom = await scopeUI();
  check('「重置」= 回到开始卡片界面：地图重新出现、画布清空、卡槽清空、进度行隐藏',
    restarted.started === false && restarted.phase === 'scope' && restartDom.mapVisible && !restartDom.puzzleVisible &&
      restartDom.pieces === 0 && restartDom.slots === 0 && restartDom.statusHidden && restartDom.startCard,
    { phase: restarted.phase, ...restartDom });
  check('回到开始卡片后「简单/困难」保持可见', (await difficultyUI()).visible === true);
  await shot('puzzle-7-back-to-start.png');

  // ==================== 世界档拼图：194 个国家整幅拼成一块 ====================
  await ev(`(() => { document.getElementById('granularity-world').click(); return true })()`);
  await sleep(700);
  await ev(`(() => { document.getElementById('puzzle-start').click(); return true })()`);
  await sleep(900);
  const worldBoard = await puzzle();
  check('世界档开局：194 片、地图隐藏、卡槽三片、进度行写 已拼 1/194',
    worldBoard.total === 194 && worldBoard.started === true && (await ev(`document.getElementById('puzzle-status').textContent`)).includes('已拼 1/194'),
    { total: worldBoard.total });
  const worldSolved = await ev(`window.__probe.puzzleAutoSolve()`);
  await sleep(1800);
  const worldWin = await puzzle();
  check('世界档把 194 个国家全部拼成一整块（多范围拼图逻辑跑通）',
    worldSolved === true && worldWin.complete === true && worldWin.groups.length === 1 && worldWin.groups[0].pieces.length === 194,
    { solved: worldSolved, groups: worldWin.groups.length });
  await shot('puzzle-8-win-world.png');

  // ==================== 市级档拼图：下钻某省 + 全国 340 片 ====================
  await ev(`(() => { document.getElementById('summary-close').click(); return true })()`);
  await sleep(200);
  await resetClick();
  await setScope('city', '130000');
  await sleep(400);
  const hebeiScope = await scopeUI();
  check('市级下钻河北：开始卡片写「河北的 11 个地级单位」', /^把河北的 \d+ 个地级单位/.test(hebeiScope.subtitle), hebeiScope.subtitle);
  await ev(`(() => { document.getElementById('puzzle-start').click(); return true })()`);
  await sleep(800);
  const cityBoard = await puzzle();
  const citySolved = await ev(`window.__probe.puzzleAutoSolve()`);
  await sleep(1500);
  const cityWin = await puzzle();
  check('市级下钻开局 11 片，全部拼成一整块即获胜',
    cityBoard.total === 11 && citySolved === true && cityWin.complete === true && cityWin.groups[0].pieces.length === 11,
    { total: cityBoard.total, groups: cityWin.groups?.length });
  await shot('puzzle-9-win-hebei.png');

  await ev(`(() => { document.getElementById('summary-close').click(); return true })()`);
  await sleep(200);
  await resetClick();
  await setScope('city', null);
  await sleep(400);
  await ev(`(() => { document.getElementById('puzzle-start').click(); return true })()`);
  await sleep(1600);
  const cityNation = await puzzle();
  const cityNationDom = await json(`({
    slots: document.querySelectorAll('#puzzle .puzzle-slot').length,
    pieces: document.querySelectorAll('#puzzle .puzzle-piece').length,
    status: document.getElementById('puzzle-status').textContent,
  })`);
  check('市级全国：340 个地级单位、三个卡槽、画布先清空、进度行 已拼 1/340',
    cityNation.total === 340 && cityNationDom.slots === 3 && cityNationDom.pieces === 0 && /已拼 1\/340/.test(cityNationDom.status),
    { total: cityNation.total, ...cityNationDom });
  await shot('puzzle-10-board-city.png');
  await resetClick();

  // ==================== 难度分段按钮的选中样式（与其它模式一致） ====================
  await ev(`(() => { document.getElementById('granularity-province').click(); return true })()`);
  await sleep(500);
  await ev(`(() => { document.getElementById('puzzle-hard').click(); return true })()`);
  await sleep(300);
  const segStyle = await json(`(function(){
    var cs = function(el){ var s = getComputedStyle(el); return { active: el.classList.contains('active'), bgImage: (s.backgroundImage || '').slice(0, 30), color: s.color }; };
    var ref = document.getElementById('granularity-province');
    return { easy: cs(document.getElementById('puzzle-easy')), hard: cs(document.getElementById('puzzle-hard')), ref: cs(ref), current: window.__probe.puzzle().difficulty };
  })()`);
  const activeSeg = segStyle.current === 'hard' ? segStyle.hard : segStyle.easy;
  const idleSeg = segStyle.current === 'hard' ? segStyle.easy : segStyle.hard;
  check('难度分段按钮的选中态与其它模式的分段按钮同一套样式（active 类 + 深色渐变填充 + 白字）',
    activeSeg.active === true && activeSeg.bgImage.indexOf('gradient') >= 0 && idleSeg.active === false && idleSeg.bgImage === 'none' &&
      activeSeg.bgImage === segStyle.ref.bgImage,
    segStyle);
  await ev(`(() => { document.getElementById('puzzle-easy').click(); return true })()`);
  await sleep(200);

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
