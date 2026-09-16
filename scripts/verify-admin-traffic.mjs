/**
 * 本轮验收脚本（真实浏览器 + 真实指针事件）：管理端「日志记录」子视图的**流量折线图**与**时间范围选择**。
 *
 * 需求口径（用户原话）：「将管理员用户管理的流量看板做成折线图（鼠标挪到标记点显示当天或小时的
 * 访问量），而且可以选择，近一天，近7天，近一个月的时间范围。」
 *
 * 为什么必须运行时验：单测只能覆盖 option 的构造（`trafficSeries.test.ts`），覆盖不到
 * 「ECharts 真的建了实例、容器真的非 0 高、鼠标挪到标记点真的弹出访问量、反复切 tab 没有累积实例」。
 *
 * 两个环境难点与对策：
 *   1. **本地静态服没有 Pages Functions** → 用 `Page.addScriptToEvaluateOnNewDocument` 在页面脚本
 *      执行前替换 `window.fetch`：`/api/**` 一律返回打桩数据，其余请求（`data/*.json` 等地图数据）
 *      照常走真网络；
 *   2. **管理端要求管理员登录态** → 同一时机写入 `localStorage['china-admin-session-v1']`
 *      （`src/authStore.ts` 的存储键），`isAdmin: true` 才会在下拉菜单里出现「日志记录」入口。
 *
 * 用 Edge 而不是 Chrome：与其余验收脚本一致（本机 Chrome 过旧，不支持 ES module）。
 *
 * 用法：npm run build && node scripts/verify-admin-traffic.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BROWSER = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9999;
const CDP = 10000;
const OUT = path.join(ROOT, 'docs', 'shots');
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 打桩脚本（在页面任何脚本之前执行）。
 *
 * 数据刻度是**确定性**的：每个范围的桶数、标签、计数都由公式给出，因此"鼠标挪到第 k 个标记点
 * 应当看到哪一行 tooltip"在脚本里可以逐字比对（不是"含某个数字"这种模糊断言）。
 *   · 近一天（按小时）：24 点，标签 2026-09-15 15:00 → 2026-09-16 14:00，计数 3,6,9,…（倍数 3）
 *   · 近七天（按天）：7 点，标签 2026-09-10 → 2026-09-16，计数 7,14,21,…（倍数 7）
 *   · 近一个月（按天）：30 点，标签 …→ 2026-09-16，计数 11,22,…（倍数 11）
 */
const STUB = `(function () {
  var ADMIN = { username: 'admintest', hometown: null, avatar: null, isAdmin: true, createdAt: 0, updatedAt: 0 };
  try { localStorage.setItem('china-admin-session-v1', JSON.stringify({ token: 'probe-token', user: ADMIN })); } catch (e) {}

  var SPECS = { day: { unit: 'hour', n: 24, step: 3 }, week: { unit: 'day', n: 7, step: 7 }, month: { unit: 'day', n: 30, step: 11 } };
  var pad = function (n) { return (n < 10 ? '0' : '') + n; };
  function labelsOf(spec) {
    var out = [];
    for (var i = spec.n - 1; i >= 0; i--) {
      var d = spec.unit === 'hour'
        ? new Date(Date.UTC(2026, 8, 16, 14, 0) - i * 3600000)
        : new Date(Date.UTC(2026, 8, 16) - i * 86400000);
      var day = d.toISOString().slice(0, 10);
      out.push(spec.unit === 'hour' ? day + ' ' + pad(d.getUTCHours()) + ':00' : day);
    }
    return out;
  }

  window.__apiCalls = [];
  window.__zeroRange = '';   // 置为某个范围名时，该范围的统计全为 0（验空态）
  window.__stub = function (url) {
    var json = function (body) { return { ok: true, status: 200, json: function () { return Promise.resolve(body); } }; };
    if (url.indexOf('/api/auth/me') >= 0) return json({ user: ADMIN });
    if (url.indexOf('/api/visit') >= 0) return json({ ok: true });
    if (url.indexOf('/api/announcements') >= 0) return json({ announcements: [] });
    if (url.indexOf('/api/leaderboard') >= 0) return json({ entries: [] });
    if (url.indexOf('/api/board') >= 0) return json({ posts: [] });
    if (url.indexOf('/api/admin/users') >= 0) return json({ users: [] });
    if (url.indexOf('/api/admin/logs') >= 0 && url.indexOf('view=stats') >= 0) {
      var m = /[?&]range=([a-z]+)/.exec(url);
      var range = (m && SPECS[m[1]]) ? m[1] : 'week';
      var spec = SPECS[range];
      var labels = labelsOf(spec);
      var zero = window.__zeroRange === range;
      return json({
        range: range,
        unit: spec.unit,
        points: labels.map(function (label, i) { return { label: label, count: zero ? 0 : (i + 1) * spec.step }; }),
      });
    }
    if (url.indexOf('/api/admin/logs') >= 0) {
      var logs = [];
      for (var i = 0; i < 3; i++) logs.push({ id: 100 - i, username: 'admintest', ua: 'probe-UA-' + i, createdAt: Date.UTC(2026, 8, 16, 13, i) });
      return json({ logs: logs });
    }
    return json({ ok: true });
  };

  var realFetch = window.fetch ? window.fetch.bind(window) : null;
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    // 只拦 API：data/*.json（地图数据）等必须照常走真网络，否则应用起不来
    if (url.indexOf('/api/') < 0) return realFetch ? realFetch(input, init) : Promise.reject(new Error('no fetch'));
    window.__apiCalls.push({ url: url, method: (init && init.method) || 'GET' });
    return Promise.resolve(window.__stub(url));
  };
})();`;

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : '  → ' + JSON.stringify(detail)}`);
};

const server = spawn(process.execPath, [path.join(ROOT, 'scripts', 'static-server.mjs'), String(PORT), path.join(ROOT, 'dist')], { stdio: 'ignore' });
await sleep(1200);
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-admin-traffic-'));
const browser = spawn(
  BROWSER,
  ['--headless=new', '--disable-gpu', '--no-first-run', `--user-data-dir=${userDir}`, `--remote-debugging-port=${CDP}`, '--window-size=1440,900', '--force-device-scale-factor=1', 'about:blank'],
  { stdio: 'ignore' },
);

let ws; let id = 0; const pending = new Map();
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id;
  pending.set(i, { res, rej });
  ws.send(JSON.stringify({ id: i, method, params }));
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
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
    }
  });
  await send('Runtime.enable');
  await send('Page.enable');
  // 必须在导航之前：打桩与登录态都得在应用脚本执行前就绪
  await send('Page.addScriptToEvaluateOnNewDocument', { source: STUB });

  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression: `(async () => (${expression}))()`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed');
    return r.result.value;
  };
  const json = (expression) => ev(`JSON.stringify(${expression})`).then((s) => (s === undefined ? null : JSON.parse(s)));
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    const f = path.join(OUT, name);
    fs.writeFileSync(f, Buffer.from(r.data, 'base64'));
    console.log('  截图', path.relative(ROOT, f));
  };
  const moveTo = async (x, y) => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(x), y: Math.round(y), button: 'none' });
    await sleep(280);
  };

  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?probe=1` });
  for (let i = 0; i < 90; i++) {
    await sleep(500);
    if ((await ev('typeof window.__probe').catch(() => 'no')) === 'object') break;
  }
  await sleep(800);

  const traffic = () => json('window.__probe.adminTraffic()');
  const pixelOf = (index) => json(`window.__probe.adminTrafficPointPixel(${index})`);
  const clickTab = async (view) => {
    await ev(`(() => {
      var b = Array.prototype.slice.call(document.querySelectorAll('.admin-tab')).filter(function (x) { return x.dataset.view === '${view}'; })[0];
      if (b) b.click();
      return !!b;
    })()`);
    await sleep(800);
  };
  const clickRange = async (range) => {
    const clicked = await ev(`(() => {
      var b = document.querySelector('#admin-traffic-range button[data-range="${range}"]');
      if (b) b.click();
      return !!b;
    })()`);
    await sleep(700);
    return clicked;
  };
  const activeRanges = () => json(`Array.prototype.slice.call(document.querySelectorAll('#admin-traffic-range button')).filter(function (b) { return b.classList.contains('active'); }).map(function (b) { return b.dataset.range; })`);
  /** 页面上此刻可见的浮层文本（ECharts 的 tooltip 挂在 body 下、position: absolute）。 */
  const overlays = () => json(`(function () {
    var out = [];
    document.querySelectorAll('div').forEach(function (d) {
      var s = getComputedStyle(d);
      if (s.position !== 'absolute' && s.position !== 'fixed') return;
      if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return;
      var txt = (d.textContent || '').trim();
      if (txt) out.push(txt);
    });
    return out;
  })()`);
  const tooltipText = async () => {
    const list = (await overlays()) ?? [];
    return list.find((t) => t.includes('次访问')) ?? null;
  };

  // ==================== 0. 用真实路径进入「日志记录」 ====================
  console.log('=== 0. 进入管理端「日志记录」（真实点击下拉菜单） ===');
  await ev(`(() => { document.getElementById('user-center').click(); return true })()`);
  await sleep(400);
  const menu = await json(`Array.prototype.map.call(document.querySelectorAll('#user-menu button'), function (b) { return b.textContent; })`);
  check('注入的管理员登录态生效（下拉菜单出现三个管理入口）', ['用户管理', '日志记录', '公告管理'].every((x) => (menu ?? []).includes(x)), menu);
  const opened = await ev(`(() => {
    var b = Array.prototype.slice.call(document.querySelectorAll('#user-menu button')).filter(function (x) { return x.textContent === '日志记录'; })[0];
    if (b) b.click();
    return !!b;
  })()`);
  await sleep(1000);
  check('点击「日志记录」进入日志子视图', opened === true);
  const statsCalls = (await json(`window.__apiCalls.filter(function (c) { return c.url.indexOf('view=stats') >= 0; })`)) ?? [];
  check('首次进入即请求统计接口，且带上了默认范围 range=week', statsCalls.length >= 1 && statsCalls[0].url.includes('range=week'), statsCalls.map((c) => c.url));

  // ==================== 1. 折线图真的画出来了 ====================
  console.log('\n=== 1. 折线图渲染（容器高度 / canvas / 点数 / x 轴 / 按钮） ===');
  const base = await traffic();
  check('图表容器非 0 高（ECharts 需要非零高度，否则画成 0×0）', base.height > 100, { height: base.height, rect: base.rect });
  check('ECharts 实例已挂载且有 canvas', base.mounted === true && base.canvasCount >= 1, { mounted: base.mounted, canvas: base.canvasCount });
  check('系列类型是折线（line）', base.option?.type === 'line', base.option?.type);
  // 像素级：读回 option 只能证明"配置对了"，这里数一遍画布上真的画出来的绿色像素（折线 + 面积）
  const greenPixels = await ev(`(function () {
    var c = document.querySelector('#admin-traffic canvas');
    if (!c) return -1;
    var d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    var n = 0;
    for (var i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 40) continue;
      if (d[i + 1] > d[i] + 10 && d[i + 1] > d[i + 2] + 10) n++;
    }
    return n;
  })()`);
  check('画布上真的画出了折线与面积（不是只画了坐标轴）', greenPixels > 500, { greenPixels });
  check('默认「近七天」= 7 个点、粒度按天', base.range === 'week' && base.unit === 'day' && base.pointCount === 7 && base.option?.counts.length === 7, { range: base.range, unit: base.unit, points: base.pointCount, counts: base.option?.counts });
  check('x 轴刻度是日期（读回真正生效的 option）', base.option?.xAxis.join(',') === '9/10,9/11,9/12,9/13,9/14,9/15,9/16', base.option?.xAxis);
  const buttons = await json(`(function () {
    var btns = Array.prototype.slice.call(document.querySelectorAll('#admin-traffic-range button'));
    return { texts: btns.map(function (b) { return b.textContent; }), active: btns.filter(function (b) { return b.classList.contains('active'); }).map(function (b) { return b.dataset.range; }), segmented: btns.length > 0 && btns[0].parentElement.className.indexOf('mode-segmented') >= 0 };
  })()`);
  check('三个范围按钮：文案与既有分段按钮同一套样式（.mode-segmented）', buttons.texts.join('|') === '近一天|近七天|近一个月' && buttons.segmented, buttons);
  check('默认选中「近七天」', buttons.active.join(',') === 'week', buttons.active);
  await shot('admin-traffic-1-week.png');

  // ==================== 2. 三个范围：点数与粒度 ====================
  console.log('\n=== 2. 范围切换（真实点击按钮） ===');
  const clickedDay = await clickRange('day');
  const day = await traffic();
  check('「近一天」按钮可点，切换后 = 24 个点、粒度按小时', clickedDay === true && day.range === 'day' && day.unit === 'hour' && day.pointCount === 24 && day.option?.counts.length === 24, { range: day.range, unit: day.unit, points: day.pointCount });
  check('「近一天」x 轴刻度是整点（15:00 … 14:00，读回 option 一致）', day.option?.xAxis.length === 24 && day.option.xAxis[0] === '15:00' && day.option.xAxis[23] === '14:00', { first: day.option?.xAxis[0], last: day.option?.xAxis[23] });
  const dayCalls = (await json(`window.__apiCalls.filter(function (c) { return c.url.indexOf('range=day') >= 0; })`)) ?? [];
  check('切到「近一天」真的重新拉了 day 范围的数据', dayCalls.length >= 1, dayCalls.map((c) => c.url));
  check('按钮选中态跟随（近一天）', (await activeRanges()).join(',') === 'day');
  await shot('admin-traffic-2-day.png');

  const clickedMonth = await clickRange('month');
  const month = await traffic();
  check('「近一个月」按钮可点，切换后 = 30 个点、粒度按天', clickedMonth === true && month.range === 'month' && month.unit === 'day' && month.pointCount === 30 && month.option?.counts.length === 30, { range: month.range, unit: month.unit, points: month.pointCount });
  check('按钮选中态跟随（近一个月）', (await activeRanges()).join(',') === 'month');
  await shot('admin-traffic-3-month.png');

  // ==================== 3. 鼠标挪到标记点 → tooltip 显示访问量 ====================
  console.log('\n=== 3. 真实鼠标悬停标记点 → tooltip 文本 ===');
  check('未悬停时页面上没有任何「次访问」提示', (await tooltipText()) === null);
  await moveTo(6, 6);
  await clickRange('week');
  const week = await traffic();
  check('切回「近七天」用于逐字比对（7 点 / 按天）', week.pointCount === 7 && week.unit === 'day', { points: week.pointCount, unit: week.unit });

  // 打桩数据：第 i 个点 count = (i+1)*7 → 第 5 个点（index 4）是 9/14、35 次访问
  const weekIndex = 4;
  const px = await pixelOf(weekIndex);
  const rect = week.rect;
  const onChart = !!px && !!rect && px[0] >= rect.left && px[0] <= rect.left + rect.width && px[1] >= rect.top && px[1] <= rect.top + rect.height;
  check('拿得到第 5 个标记点的页面像素（且落在图表内）', onChart, { pixel: px, rect });
  if (onChart) {
    await moveTo(px[0], px[1]);
    const text = await tooltipText();
    check('鼠标挪到标记点后弹出访问量（含「次访问」）', !!text && text.includes('次访问'), text);
    check('tooltip 文案逐字正确（按天）：「9月14日 · 35 次访问」', text === '9月14日 · 35 次访问', text);
    await shot('admin-traffic-4-tooltip-week.png');
  } else {
    check('鼠标挪到标记点后弹出访问量（含「次访问」）', false, '取不到标记点像素');
  }

  // 按小时那档：第 4 个点（index 3）= 2026-09-15 18:00、12 次访问
  await clickRange('day');
  await moveTo(6, 6);
  const dayPx = await pixelOf(3);
  if (dayPx) {
    await moveTo(dayPx[0], dayPx[1]);
    const hourText = await tooltipText();
    check('tooltip 文案逐字正确（按小时）：「9月15日 18:00 · 12 次访问」', hourText === '9月15日 18:00 · 12 次访问', hourText);
    await shot('admin-traffic-5-tooltip-day.png');
  } else {
    check('tooltip 文案逐字正确（按小时）：「9月15日 18:00 · 12 次访问」', false, '取不到标记点像素');
  }
  await moveTo(6, 6);
  check('鼠标移开后 tooltip 收起（不是常驻浮层）', (await tooltipText()) === null);

  // ==================== 4. 只刷新图表 + 不残留实例 ====================
  console.log('\n=== 4. 局部刷新与实例生命周期 ===');
  await ev(`(() => { document.getElementById('admin-body').dataset.probeMark = 'keep-me'; return true })()`);
  await clickRange('month');
  const markKept = await ev(`(() => document.getElementById('admin-body').dataset.probeMark || '')()`);
  check('切范围**不重建** #admin-body（局部刷新：不丢滚动位置、不闪一下）', markKept === 'keep-me', markKept);

  const before = await traffic();
  for (let i = 0; i < 3; i++) {
    await clickTab('users');
    await clickTab('logs');
  }
  const after = await traffic();
  check('反复切 tab 3 轮后，图表容器内只有一套 canvas（没有累积实例）', after.canvasCount === before.canvasCount && after.canvasCount >= 1, { before: before.canvasCount, after: after.canvasCount });
  const containers = await ev(`document.querySelectorAll('#admin-traffic').length`);
  check('页面上只有一个图表容器（旧容器连同其实例一起被换掉）', containers === 1, containers);

  await clickTab('users');
  const afterLeave = await traffic();
  check('切走子视图后图表实例被销毁（dispose 生效，不是只把 DOM 藏起来）', afterLeave.mounted === false && afterLeave.canvasCount === 0 && afterLeave.rect === null, { mounted: afterLeave.mounted, canvas: afterLeave.canvasCount, rect: afterLeave.rect });
  await clickTab('logs');

  // ==================== 5. 空态 ====================
  console.log('\n=== 5. 空数据 → 空态文案 ===');
  await ev(`(() => { window.__zeroRange = 'day'; return true })()`);
  await clickRange('week');
  await clickRange('day');
  const empty = await traffic();
  check('整段窗口一次访问都没有时显示空态文案', empty.emptyVisible === true, { emptyVisible: empty.emptyVisible });
  check('空态下仍然画出时间窗口（24 个点不被清空）', empty.pointCount === 24, empty.pointCount);
  const emptyText = await ev(`(() => { var el = document.getElementById('admin-traffic-empty'); return el ? el.textContent.trim() : ''; })()`);
  check('空态文案取自既有文案键（admin.noStats = 「暂无统计数据」）', emptyText === '暂无统计数据' && empty.emptyVisible, emptyText);
  await shot('admin-traffic-6-empty.png');
  await ev(`(() => { window.__zeroRange = ''; return true })()`);
  await clickRange('week');
  check('恢复有数据后空态自动收起', (await traffic()).emptyVisible === false);

  // ==================== 6. 暗色模式跟随 ====================
  console.log('\n=== 6. 暗色模式（跟随 settings.darkMode 与既有主题色） ===');
  const lightRead = (await traffic()).option;
  await ev(`(() => { document.getElementById('btn-theme').click(); return true })()`);
  await sleep(900);
  const darkTraffic = await traffic();
  const darkRead = darkTraffic.option;
  const norm = (s) => String(s ?? '').replace(/\s+/g, '');
  check('切到黑夜模式后图表仍在（已挂载、高度 > 0、canvas 还在）', darkTraffic.mounted === true && darkTraffic.height > 100 && darkTraffic.canvasCount >= 1, { height: darkTraffic.height, canvas: darkTraffic.canvasCount });
  check('tooltip 底色换成暗色主题的既有令牌（不是新配的一套颜色）', darkRead.tooltipBg !== lightRead.tooltipBg && norm(darkRead.tooltipBg).includes('15,23,42'), { light: lightRead.tooltipBg, dark: darkRead.tooltipBg });
  check('折线颜色跟随 CSS 变量 --accent（暗主题亮一档）', darkRead.lineColor !== lightRead.lineColor && darkRead.lineColor.length > 0, { light: lightRead.lineColor, dark: darkRead.lineColor });
  await shot('admin-traffic-7-dark.png');
  await ev(`(() => { document.getElementById('btn-theme').click(); return true })()`);
  await sleep(800);

  // ==================== 7. 位置与下方列表保持不变 ====================
  console.log('\n=== 7. 位置与访问明细保持不变 ===');
  await clickRange('week');
  const coexist = await json(`(function () {
    var body = document.getElementById('admin-body');
    var chart = body.querySelector('#admin-traffic');
    var list = body.querySelector('.admin-log-list');
    var more = document.getElementById('admin-log-more');
    return {
      tabs: Array.prototype.map.call(document.querySelectorAll('.admin-tab'), function (b) { return b.dataset.view; }),
      rows: list ? list.querySelectorAll('.log-row').length : 0,
      moreVisible: !!more && getComputedStyle(more).display !== 'none',
      moreText: more ? more.textContent.trim() : '',
      chartBeforeList: !!(chart && list) && (chart.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING) > 0,
    };
  })()`);
  check('没有新增 tab（仍是三个子视图，流量看板留在「日志记录」里）', coexist.tabs.join(',') === 'users,logs,announcements', coexist.tabs);
  check('下方访问明细与「加载更多」保持不变', coexist.rows === 3 && coexist.moreVisible && coexist.moreText === '加载更多', coexist);
  check('图表在访问明细之前（同一子视图内、顺序合理）', coexist.chartBeforeList === true);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n===== ${results.length - failed.length}/${results.length} 通过 =====`);
  if (failed.length) {
    console.log('失败项：');
    for (const f of failed) console.log(`  - ${f.name}: ${JSON.stringify(f.detail)}`);
  }
  process.exitCode = failed.length ? 1 : 0;
} catch (err) {
  console.error('验收脚本异常：', err.message);
  process.exitCode = 1;
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  browser.kill();
  server.kill();
  await sleep(400);
  try { fs.rmSync(userDir, { recursive: true, force: true }); } catch { /* ignore */ }
}
