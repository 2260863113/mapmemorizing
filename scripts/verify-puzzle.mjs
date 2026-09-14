/**
 * 拼图模式（puzzle）真机验收：两阶段（选范围 / 拼图盘面）× 三个粒度（世界/省级/市级），共 49 项。
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
      zoomPill: document.getElementById('zoom-pill').textContent,
      zoomPillHidden: document.getElementById('zoom-pill').classList.contains('hidden'),
      sidePanelHidden: document.getElementById('side-panel').classList.contains('hidden'),
      leaderboardHidden: document.getElementById('leaderboard').classList.contains('hidden'),
      leaderboardTitle: (document.querySelector('#leaderboard .leaderboard-title') || {}).textContent || null,
      sidePanelCollapsed: document.getElementById('side-panel').classList.contains('collapsed'),
    };
  })()`);

  /** 地图页 zoom=1 的每经度像素数（拼图 1x 必须与它一致 —— 用户口径）。 */
  const mapUnitScale = async () => json(`(function(){
    var f = JSON.parse(window.__probe.followFrames());
    return f.window ? Number((1 / f.window.perPxX).toFixed(3)) : null;
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
  check('页签顺序：输入模式右边、无尽闯关左边是「拼图模式」（自由模式已于 2026-09 下线）',
    tabs.join('/') === '点击模式/输入模式/拼图模式/无尽闯关', tabs);

  // ==================== 进入拼图 = 选范围阶段（仍然看得见完整地图） ====================
  await ev(`(() => { document.querySelector('#mode-tabs button[data-mode="puzzle"]').click(); return true })()`);
  await sleep(900);
  const scope1 = await scopeUI();
  check('进入后仍是完整地图（#map 可见、#puzzle 隐藏、省级全国的港澳放大框在）',
    scope1.mapVisible && !scope1.puzzleVisible && scope1.insetVisible, scope1);
  check('画布还没有碎片、也没有卡槽，先出「开始」卡片、进度行隐藏',
    scope1.pieces === 0 && scope1.slots === 0 && scope1.startCard && scope1.statusHidden, scope1);
  check('开始卡片写明范围：「全国 34 个省级单位」', scope1.subtitle === '把全国 34 个省级单位拼成一幅完整的地图', scope1.subtitle);
  check('选范围阶段：粒度行（省级选中）与难度行都可见，侧栏不出现（拼图榜只在世界/全国市级两档）', scope1.granularityVisible && scope1.granularityActive === '省级' && (await difficultyUI()).visible, scope1);
  const map1xProvince = await mapUnitScale();
  check('省级全国地图 zoom=1 的比例可读（拼图 1x 的比对标尺）', typeof map1xProvince === 'number' && map1xProvince > 5, { map1xProvince });
  await shot('puzzle-1-scope.png');

  // ==================== 唯一层级的京津沪渝/港澳台：一律不下钻（所有模式） ====================
  const bjClick = await json(`window.__probe.puzzleUnit('110000')`);
  const bjToast = await ev(`document.getElementById('toast').textContent`);
  check('省级全国里点北京（直辖市，只有一个下级单位）→ 不下钻，并给一行提示',
    bjClick.handled === true && bjClick.snapshot.granularity === 'province' && bjClick.snapshot.scope === PROVINCE_NATION && /不再下钻/.test(bjToast),
    { handled: bjClick.handled, granularity: bjClick.snapshot.granularity, scope: bjClick.snapshot.scope, toast: bjToast });
  const hkClick = await json(`window.__probe.puzzleUnit('810000')`);
  check('点香港（特别行政区，同样只有一个下级单位）→ 也不下钻',
    hkClick.handled === true && hkClick.snapshot.granularity === 'province' && hkClick.snapshot.scope === PROVINCE_NATION,
    { handled: hkClick.handled, granularity: hkClick.snapshot.granularity, scope: hkClick.snapshot.scope });

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
  const map1xWorld = await mapUnitScale();
  check('世界档地图 zoom=1 的比例（世界族）明显小于中国族',
    typeof map1xWorld === 'number' && map1xWorld > 1 && map1xWorld < map1xProvince, { map1xWorld, map1xProvince });
  check('全世界（可提交范围）：右侧显示拼图排行榜',
    !world1.sidePanelHidden && !world1.leaderboardHidden && /拼图模式/.test(world1.leaderboardTitle ?? ''),
    { title: world1.leaderboardTitle, sidePanelHidden: world1.sidePanelHidden });

  // ---- 大洋洲：仍可作为范围，但不再细分次区域（用户口径，所有模式） ----
  await ev(`(() => { document.getElementById('continent-OC').click(); return true })()`);
  await sleep(600);
  const oceania = await scopeUI();
  const ocProbe = await puzzle();
  check('点「大洋洲」：进入大洋洲范围，但不再出现次区域行',
    ocProbe.scope === '__continent_OC__' && !oceania.subregionVisible && /^把大洋洲的 \d+ 个国家和地区/.test(oceania.subtitle),
    { scope: ocProbe.scope, subregionVisible: oceania.subregionVisible, subtitle: oceania.subtitle });
  const ocClick = await json(`window.__probe.puzzleUnit('AUS')`);
  check('在大洋洲里点澳大利亚 → 不再下钻到「澳新」次区域',
    ocClick.snapshot.scope === '__continent_OC__', { scope: ocClick.snapshot.scope });
  await ev(`(() => { document.getElementById('continent-all').click(); return true })()`);
  await sleep(500);

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

  // ---- 市级档点地级单位：必须**真的**收窄到它所属的省（用户报的缺陷：范围仍是 340） ----
  await setScope('city', null); // 探针把状态摆到「市级 + 全国」
  await sleep(500);
  const cityNationBefore = await puzzle();
  check('市级全国：范围就是全国 340 片',
    cityNationBefore.granularity === 'city' && cityNationBefore.scope === null &&
      (await scopeUI()).subtitle === '把全国 340 个地级单位拼成一幅完整的地图', cityNationBefore);
  const cityClick = await mapPoint(0.5, 0.42); // 市级全国视图中心 = 四川一带
  await click(cityClick.x, cityClick.y);
  const cityDrilled = await puzzle();
  const cityDrilledUI = await scopeUI();
  check('市级全国里单击一个地级单位 → 范围**收窄到它所属的省**（不再停留在 340 片）',
    cityDrilled.granularity === 'city' && /^\d{6}$/.test(cityDrilled.scope ?? '') &&
      /^把.+的 \d+ 个地级单位/.test(cityDrilledUI.subtitle),
    { before: cityNationBefore.scope, scope: cityDrilled.scope, subtitle: cityDrilledUI.subtitle });
  const drilledCount = Number(cityDrilledUI.subtitle.match(/(\d+) 个地级单位/)?.[1] ?? 0);
  await ev(`(() => { document.getElementById('puzzle-start').click(); return true })()`);
  await sleep(900);
  const cityDrilledBoard = await puzzle();
  check('开局片数 = 该省的地级单位数（不是 340），进度行同步',
    cityDrilledBoard.total === drilledCount && drilledCount > 1 && drilledCount < 340 &&
      (await ev(`document.getElementById('puzzle-status').textContent`)).includes(`已拼 1/${drilledCount}`),
    { total: cityDrilledBoard.total, drilledCount });
  await resetClick();
  // 「点空白返回」在这一步走探针（等价于空白点击后的模式回调，`puzzleBack`）：
  // 四川的取景框（lng 87–119 / lat 23.9–36.5）里**看不到海面**，而该视图下其它省的面与
  // 南海诸岛装饰面都会被 renderer 忽略（不算空白），所以这个视图里没有可点的真空白点。
  // 鼠标级的空白返回已在世界档那两条（东亚→亚洲→全世界）用真实点击验证过。
  await ev(`window.__probe.puzzleBack()`);
  await sleep(500);
  const backNation = await puzzle();
  check('市级下钻后点空白 → 回到「全国 340 个地级单位」，地图也一并退回全国',
    backNation.scope === null && backNation.granularity === 'city' &&
      (await scopeUI()).subtitle === '把全国 340 个地级单位拼成一幅完整的地图' &&
      (await json(`window.__probe.quizScope().viewProvince`)) === null,
    { scope: backNation.scope, viewProvince: await json(`window.__probe.quizScope().viewProvince`) });
  check('已在市级档时再点「市级」= 回到全国市级（粒度按钮可当"退出下钻"用）',
    (await (async () => { await setScope('city', '130000'); await sleep(300); await ev(`(() => { document.getElementById('granularity-city').click(); return true })()`); await sleep(500); return puzzle(); })()).scope === null);

  // ==================== 开始 = 拼图盘面（地图隐藏、画布清空） ====================
  await ev(`(() => { document.getElementById('granularity-province').click(); return true })()`);
  await sleep(600);
  await ev(`(() => { document.getElementById('puzzle-start').click(); return true })()`);
  await sleep(700);
  const board = await scopeUI();
  const boardHint = await json(`document.getElementById('top-hint').textContent || ''`);
  const started = await puzzle();
  const statusText = await ev(`document.getElementById('puzzle-status').textContent`);
  /** 拼图 1x 的基准比例（探针读到的 px/°），用于和地图 1x 比对。 */
  const truePosScaleProvince = (await json(`window.__probe.puzzleTruePosition('110000')`)).scale;
  check('点开始后：地图隐藏、拼图画布显示、港澳放大框收起、开始卡片消失',
    !board.mapVisible && board.puzzleVisible && !board.insetVisible && !board.startCard && boardHint === '', { ...board, boardHint });
  check('画布上先没有任何碎片（清空）、左侧补满三个卡槽', board.pieces === 0 && board.slots === 3, board);
  check('缩放角标显示拼图自己的倍率，且进入时就是 1.00x',
    board.zoomPillHidden === false && board.zoomPill === '1.00x', { pill: board.zoomPill, hidden: board.zoomPillHidden });
  check('拼图 1x 的比例 = 地图 1x 的比例（省级全国）',
    Math.abs(truePosScaleProvince - map1xProvince) / map1xProvince < 0.02,
    { puzzle: truePosScaleProvince, map: map1xProvince });
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
  check('盘面运行时右侧排行榜收起（与测验一致）', board.sidePanelCollapsed === true, { collapsed: board.sidePanelCollapsed });
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
  // 偏移差 (5,4) → 6.4px：在**简单档 10px** 容差内（困难档 5px 时另有专门断言，见下面容差小节）
  const nearDrop = await json(`window.__probe.puzzlePlaceAt('130000', ${truePosB.x + 5}, ${truePosB.y + 4})`);
  const afterSnap = await puzzle();
  const bjGroup = afterSnap.groups.find((g) => g.pieces.includes('110000'));
  check('相邻两片偏移差在容差内 → 精确对齐合成一组',
    nearDrop.mergedGroups === 1 && afterSnap.groups.some((g) => g.pieces.length === 2 && g.pieces.includes('110000') && g.pieces.includes('130000')),
    { nearDrop, groups: afterSnap.groups.map((g) => g.pieces.length) });
  // 用户口径（2026-09-14）：**被拖拽的那片主动吸附过去**，目标组原地不动。
  // 这里先摆好北京（真值，偏移 0），再把河北放在真值 +9,+8 → 松手后河北跳到北京的偏差上 ⇒ 组偏移 = 0。
  check('松手后是**拖拽方**吸附过去（河北跳到北京的偏移 0，而不是把北京拽到 +9,+8）',
    !!bjGroup && Math.abs(bjGroup.dx) <= 2 && Math.abs(bjGroup.dy) <= 2 && bjGroup.pieces.length === 2, { group: bjGroup });
  const statusAfterSnap = await ev(`document.getElementById('puzzle-status').textContent`);
  check('发生一次吸附后「已拼」从 1 变成 2（用户口径：只看吸附次数）', /已拼 2\/34/.test(statusAfterSnap), statusAfterSnap);

  const truePosC = await json(`window.__probe.puzzleTruePosition('710000')`); // 台湾
  await ev(`window.__probe.puzzlePlaceAt('710000', ${truePosC.x + 6}, ${truePosC.y + 6})`);
  const afterFar = await puzzle();
  const twGroup = afterFar.groups.find((g) => g.pieces.includes('710000'));
  check('台湾与北京不相邻 → 即使放在一起也不吸合（仍是独立单片组）',
    !!twGroup && twGroup.pieces.length === 1 && !twGroup.pieces.includes('110000'), afterFar.groups.map((g) => g.pieces));

  // ==================== 面积层级：**先按组总面积**、组内再按各片面积（小的压在大的之上） ====================
  /** 画布上的 DOM 顺序 = 绘制顺序（后面的在上面）。两级排序：组总面积降序 → 片自身面积降序。 */
  const order = await json(`(function(){
    var wraps = document.querySelectorAll('#puzzle g.puzzle-piece-wrap');
    var rows = Array.prototype.map.call(wraps, function(w){
      return { area: Number(w.dataset.area), groupArea: Number(w.dataset.groupArea), group: w.dataset.group, adcode: w.dataset.adcode };
    });
    var byGroup = true, byPiece = true;
    for (var i = 1; i < rows.length; i++) {
      var prev = rows[i - 1], cur = rows[i];
      if (cur.groupArea > prev.groupArea + 1e-9) byGroup = false;
      else if (Math.abs(cur.groupArea - prev.groupArea) <= 1e-9 && cur.group === prev.group && cur.area > prev.area + 1e-9) byPiece = false;
    }
    var idx = function(a){ return rows.findIndex(function(r){ return r.adcode === a; }); };
    return {
      count: rows.length,
      rows: rows.slice(0, 8),
      byGroup: byGroup,
      byPieceWithinGroup: byPiece,
      // 北京（面积小）必须排在河北（面积大）之后 —— 后画 = 压在河北的环里
      bjIndex: idx('110000'),
      hbIndex: idx('130000'),
    };
  })()`);
  check('上下覆盖按**组总面积**从大到小排（很多小片拼成的大块要沉到中块之下）',
    order.count >= 3 && order.byGroup === true, order);
  check('同一组内仍按各片自身面积从大到小排', order.byPieceWithinGroup === true, order.rows);
  check('北京（面积小）画在河北（面积大）之后 → 压在河北的环里',
    order.bjIndex > order.hbIndex && order.hbIndex >= 0, { bjIndex: order.bjIndex, hbIndex: order.hbIndex });
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
    // 参照"普通灰面"用被拖拽的那片（它只会加绿边、不加填充），此时台湾还在卡槽里、DOM 里没有它
    var idle = document.querySelector('#puzzle path[data-adcode="130000"]');
    return {
      lit: lit.length,
      selfLit: self.length,
      stroke: target ? getComputedStyle(target).stroke : null,
      width: target ? getComputedStyle(target).strokeWidth : null,
      // 边界荧光：目标片的 filter 里有 drop-shadow；且**不能有整片面积的填充**（fill 保持普通灰面）
      glow: target ? getComputedStyle(target.parentNode).filter : null,
      fill: target ? getComputedStyle(target).fill : null,
      fillOpacity: target ? getComputedStyle(target).fillOpacity : null,
      idleFill: idle ? getComputedStyle(idle).fill : null,
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
    // 往北京方向拖 55px：偏移差从 (60,60) 收到 (5,5) = 7.1px → 落在**简单档 10px** 容差内（困难档另有断言）
    for (let i = 1; i <= 6; i++) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x - (55 * i) / 6, y: from.y - (55 * i) / 6, button: 'left', buttons: 1 });
      await sleep(20);
    }
    const hint = await snapHintState();
    if (shotDuringDrag) await shot(shotDuringDrag); // 趁还在拖、提示亮着的时候截图
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: from.x - 55, y: from.y - 55, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(150);
    return hint;
  };

  const hintEasy = await checkSnapHint('easy', 'puzzle-3b-snap-hint.png');
  check('简单难度：拖到可吸附范围时给出绿色**边界**提示（目标组绿边 + 绿辉光、手里那块也加绿边）',
    !!hintEasy && hintEasy.lit >= 1 && hintEasy.selfLit >= 1 && parseFloat(hintEasy.width) >= 2 &&
      hintEasy.stroke !== 'none' && /drop-shadow/.test(hintEasy.glow ?? ''),
    hintEasy);
  check('简单难度的提示**只有边界荧光**：目标片没有整片面积的绿色填充',
    !!hintEasy && hintEasy.lit >= 1 && hintEasy.fill === hintEasy.idleFill, hintEasy);
  const hintHard = await checkSnapHint('hard', 'puzzle-3c-snap-hint-hard.png');
  check('困难难度：**完全不给任何吸附提示**（目标不亮、手里那块也不加描边，避免靠提示撞运气）',
    !!hintHard && hintHard.lit === 0 && hintHard.selfLit === 0,
    hintHard);
  check('困难模式下画布上没有名称标签', (await ev(`document.querySelectorAll('#puzzle .puzzle-label').length`)) === 0);

  // ==================== 磁吸容差按难度分档：简单 10px / 困难 5px ====================
  /** 在当前难度下，把两片相邻碎片按给定偏移差摆放，看是否吸上。 */
  const toleranceProbe = async (difficulty, gap) => {
    await resetClick();
    await ev(`(() => { document.getElementById('puzzle-${difficulty}').click(); return true })()`);
    await sleep(200);
    await ev(`(() => { document.getElementById('puzzle-start').click(); return true })()`);
    await sleep(500);
    const p1 = await json(`window.__probe.puzzleTruePosition('110000')`);
    const p2 = await json(`window.__probe.puzzleTruePosition('130000')`);
    await ev(`window.__probe.puzzlePlaceAt('110000', ${p1.x}, ${p1.y})`);
    const res = await json(`window.__probe.puzzlePlaceAt('130000', ${p2.x + gap}, ${p2.y})`);
    const after = await puzzle();
    return { merged: res.mergedGroups, groups: after.groups.length, placed: after.placed };
  };
  const easy8 = await toleranceProbe('easy', 8);
  check('简单档容差 10px：偏移差 8px → 吸上并成组', easy8.merged === 1 && easy8.groups === 1, easy8);
  const hard8 = await toleranceProbe('hard', 8);
  check('困难档容差 5px：同样的 8px 偏移差 → **不吸**（比简单档更严）',
    hard8.merged === 0 && hard8.groups === 2, hard8);
  const hard4 = await toleranceProbe('hard', 4);
  check('困难档容差 5px：偏移差 4px → 吸上', hard4.merged === 1 && hard4.groups === 1, hard4);

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
    submitHidden: document.getElementById('summary-submit').classList.contains('hidden'),
    statusText: document.getElementById('puzzle-status').textContent,
  })`);
  check('把 34 片全部放到真值位置 → 吸成一整块（获胜）',
    solved === true && win.complete === true && win.groups.length === 1 && win.groups[0].pieces.length === 34,
    { solved, groups: win.groups.length, complete: win.complete });
  check('获胜后弹完成卡片：标题「拼图完成」+ 显示用时 + 「再来一局」',
    winDom.summaryVisible && /拼图完成/.test(winDom.body) && /用时/.test(winDom.body) && winDom.restartLabel === '再来一局', winDom);
  check('获胜后自动补上三沙等远海岛礁（归入海南所在组）', winDom.seaIslets >= 1, { seaIslets: winDom.seaIslets });
  check('省级全国不是可提交范围 → 完成卡片上没有「提交成绩」', winDom.submitHidden === true, winDom);
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
  const worldPuzzleScale = (await json(`window.__probe.puzzleTruePosition('CHN')`)).scale;
  check('拼图 1x 的比例 = 地图 1x 的比例（世界族）',
    Math.abs(worldPuzzleScale - map1xWorld) / map1xWorld < 0.02, { puzzle: worldPuzzleScale, map: map1xWorld });

  // ---- 中途终止提交：已拼 = 1（一片都没吸上）→ 不弹结算卡片，直接回开始卡片 ----
  await resetClick();
  const floorState = await puzzle();
  const floorDom = await json(`({
    settlement: !document.getElementById('settlement').classList.contains('hidden'),
    startCard: !!document.getElementById('puzzle-start'),
  })`);
  check('全世界范围运行中按「重置」：已拼 = 1（还没吸上任何一片）时不弹结算卡片，直接回开始卡片',
    floorState.phase === 'scope' && floorDom.settlement === false && floorDom.startCard === true,
    { phase: floorState.phase, ...floorDom });

  // ---- 已拼 ≥ 2 → 「重置」弹结算卡片，可提交 ----
  await ev(`(() => { document.getElementById('puzzle-start').click(); return true })()`);
  await sleep(800);
  const pA = await json(`window.__probe.puzzleTruePosition('CHN')`);
  const pB = await json(`window.__probe.puzzleTruePosition('MNG')`);
  await ev(`window.__probe.puzzlePlaceAt('CHN', ${pA.x}, ${pA.y})`);
  await ev(`window.__probe.puzzlePlaceAt('MNG', ${pB.x + 3}, ${pB.y + 3})`); // 4.2px：两档容差（10/5）内都吸得上
  await sleep(200);
  const snapped = await puzzle();
  await ev(`(() => { document.getElementById('btn-reset').click(); return true })()`);
  await sleep(150);
  await ev(`(() => { document.getElementById('btn-reset').click(); return true })()`);
  await sleep(500);
  const settleDom = await json(`({
    settlement: !document.getElementById('settlement').classList.contains('hidden'),
    body: document.getElementById('settlement-body').textContent,
  })`);
  check('已拼 ≥ 2 后按「重置」→ 弹结算卡片（显示「已拼 2/194 ｜ 用时」与排名口径）',
    snapped.placed === 2 && settleDom.settlement && /已拼\s*2\/194/.test(settleDom.body) && /已拼个数排名/.test(settleDom.body),
    { placed: snapped.placed, body: settleDom.body });
  await shot('puzzle-11-settlement.png');
  await ev(`(() => { document.getElementById('settlement-submit').click(); return true })()`);
  await sleep(600);
  const submitGate = await json(`({
    toast: document.getElementById('toast').textContent,
    authOpen: !document.getElementById('auth-panel').classList.contains('hidden'),
  })`);
  check('通过提交门槛后点「提交成绩」→ 走登录门控（未登录先要求登录），不是"不能提交"的拒绝提示',
    /登录/.test(submitGate.toast) && !/至少吸上/.test(submitGate.toast), submitGate);
  await ev(`(() => { document.getElementById('settlement-close').click(); return true })()`);
  await sleep(400);
  await resetClick();

  // ---- 完成后（可提交范围）完成卡片上直接给「提交成绩」 ----
  await ev(`(() => { document.getElementById('puzzle-start').click(); return true })()`);
  await sleep(900);
  const worldSolved = await ev(`window.__probe.puzzleAutoSolve()`);
  await sleep(1800);
  const worldWin = await puzzle();
  const worldWinDom = await json(`({
    body: document.getElementById('summary-body').textContent,
    submitHidden: document.getElementById('summary-submit').classList.contains('hidden'),
    status: document.getElementById('puzzle-status').textContent,
  })`);
  check('世界档把 194 个国家全部拼成一整块（多范围拼图逻辑跑通）',
    worldSolved === true && worldWin.complete === true && worldWin.groups.length === 1 && worldWin.groups[0].pieces.length === 194,
    { solved: worldSolved, groups: worldWin.groups.length });
  check('可提交范围拼完后：完成卡片标题「拼图完成」且带「提交成绩」按钮，进度行写 已拼 194/194',
    /拼图完成/.test(worldWinDom.body) && worldWinDom.submitHidden === false && /已拼 194\/194/.test(worldWinDom.status),
    worldWinDom);
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
