/**
 * 本轮验收脚本（真实浏览器 + 真实指针事件）：管理端「日志记录」与「游玩统计」两个子视图的
 * **折线图 / 时间范围选择 / 条目列表**，以及日志条的完整 IP·UA·环境详情与爬虫标记。
 *
 * 需求口径（用户原话）：
 *   · 日志记录要显示完整的浏览器环境与 IP，对境外 IP 与异常浏览器打关键词标签；
 *     未登录的访问**有判定理由才显示「爬虫」**、**没有理由是「游客」**；
 *   · 看板加「游玩统计」，样式与日志一致（曲线图 + 条目），统计点「开始」的次数（含 Tab 次数）。
 *
 * 为什么必须运行时验：单测只能覆盖 option 的构造（`trafficSeries.test.ts`）与纯映射
 * （`accessLog.test.ts`），覆盖不到「ECharts 真的建了实例、容器真的非 0 高、鼠标挪到标记点真的
 * 弹出访问量、反复切 tab 没有累积实例、翻页追加的行与首屏同构」。
 *
 * 两个环境难点与对策：
 *   1. **本地静态服没有 Pages Functions** → 用 `Page.addScriptToEvaluateOnNewDocument` 在页面脚本
 *      执行前替换 `window.fetch`：`/api/**` 一律返回打桩数据，其余请求（`data/*.json` 等地图数据）
 *      照常走真网络；
 *   2. **管理端要求管理员登录态** → 同一时机写入 `localStorage['china-admin-session-v1']`
 *      （`src/authStore.ts` 的存储键），`isAdmin: true` 才会在下拉菜单里出现管理入口。
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
 *
 * 访问日志与游玩记录各 3 条（日志另有第 4 条），刻意覆盖本轮新增字段的**边角**：
 *   · 第 1 条：完整环境 + 境外 IP + 超长 UA（> 90 字，旧 `truncateUa` 会截断）+ 未被判定为爬虫；
 *   · 第 2 条：匿名（username=null）、无 IP、无环境快照、UA 是 curl，被判定爬虫（headless / keyword）
 *     → 用户名位置必须显示「爬虫」；
 *   · 第 3 条：登录用户但 `webdriver=true`、Cookie 关闭、UA 为空、region 与 city 同名（去重）；
 *   · 第 4 条：匿名（username=null）但**没有任何判定理由** → 用户名位置必须显示「游客」
 *     （2026-09 二次确认口径：标签与判定严格同源，不再"未登录即爬虫"）。
 * 游玩记录覆盖三种来源/模式组合：start + 已知模式、tab + 另一已知模式、未登录 + 未知模式。
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
  /** 统计响应：范围 → 24/7/30 个点，计数按范围倍数递增；zeroRange 命中时该范围全为 0（验空态）。 */
  function statsOf(url, zeroRange) {
    var m = /[?&]range=([a-z]+)/.exec(url);
    var range = (m && SPECS[m[1]]) ? m[1] : 'week';
    var spec = SPECS[range];
    var labels = labelsOf(spec);
    var zero = zeroRange === range;
    return {
      range: range,
      unit: spec.unit,
      points: labels.map(function (label, i) { return { label: label, count: zero ? 0 : (i + 1) * spec.step }; }),
    };
  }

  // 完整 UA，故意超过 90 字（旧实现截断到 90 字，脚本据此断言"显示完整 UA、不截断"）
  var LONG_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.2210.91';
  var LOGS = [
    { id: 100, username: 'admintest', ua: LONG_UA, ip: '203.0.113.7', country: '美国', region: 'California', city: 'Los Angeles',
      env: { platform: 'Win32', language: 'zh-CN', languages: 'zh-CN,zh,en', timezone: 'Asia/Shanghai', screen: '1920x1080', viewport: '1280x720', dpr: 2, cores: 8, memory: 8, touch: 0, vendor: 'Google Inc.' },
      visitor: null, bot: false, botReasons: [], createdAt: Date.UTC(2026, 8, 16, 13, 0) },
    { id: 99, username: null, ua: 'curl/8.4.0', ip: null, country: null, region: null, city: null,
      env: null, visitor: '4321', bot: true, botReasons: ['headless', 'keyword:curl'], createdAt: Date.UTC(2026, 8, 16, 12, 30) },
    { id: 98, username: 'probeuser', ua: '', ip: '10.0.0.1', country: '中国', region: '上海', city: '上海',
      env: { webdriver: true, cookie: false }, visitor: null, bot: true, botReasons: ['automation'], createdAt: Date.UTC(2026, 8, 16, 12, 0) },
    // 匿名但**没有任何判定理由**：普通游客，用户名位置应当是「游客1234」而不是「爬虫」
    { id: 97, username: null, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Mobile/15E148 Safari/604.1',
      ip: '198.51.100.9', country: '中国', region: null, city: null,
      env: { platform: 'iPhone', language: 'zh-CN', timezone: 'Asia/Shanghai' }, visitor: '8765', bot: false, botReasons: [],
      createdAt: Date.UTC(2026, 8, 16, 11, 30) },
  ];
  var PLAYS = [
    // 登录用户：显示用户名，带出题范围
    { id: 300, username: 'admintest', mode: 'self', source: 'start', scopeProvince: '__world_nation__', scopeLabel: '世界',
      visitor: null, bot: false, createdAt: Date.UTC(2026, 8, 16, 13, 5) },
    // 未登录：显示「游客1234」（不再写「未登录」），云南范围用哨兵 → 展示名
    { id: 299, username: null, mode: 'puzzle', source: 'tab', scopeProvince: '530000', scopeLabel: '云南省',
      visitor: '1234', bot: false, createdAt: Date.UTC(2026, 8, 16, 12, 40) },
    // 未知模式 + 老行（没有范围列）→ 模式原样显示、范围给占位
    { id: 298, username: 'probeuser', mode: 'unknown_mode', source: 'start', scopeProvince: null, scopeLabel: null,
      visitor: null, bot: false, createdAt: Date.UTC(2026, 8, 16, 12, 10) },
  ];

  window.__apiCalls = [];
  window.__zeroRange = '';       // 置为某个范围名时，该范围的**访问**统计全为 0（验空态）
  window.__zeroPlayRange = '';   // 同上，作用于**游玩**统计
  window.__stub = function (url) {
    var json = function (body) { return { ok: true, status: 200, json: function () { return Promise.resolve(body); } }; };
    if (url.indexOf('/api/auth/me') >= 0) return json({ user: ADMIN });
    if (url.indexOf('/api/visit') >= 0) return json({ ok: true });
    if (url.indexOf('/api/announcements') >= 0) return json({ announcements: [] });
    if (url.indexOf('/api/leaderboard') >= 0) return json({ entries: [] });
    if (url.indexOf('/api/board') >= 0) return json({ posts: [] });
    if (url.indexOf('/api/admin/users') >= 0) return json({ users: [] });
    // 注意：/api/admin/plays 必须排在 /api/play 之前（前者包含后者的前缀）
    if (url.indexOf('/api/admin/plays') >= 0) {
      if (url.indexOf('view=stats') >= 0) return json(statsOf(url, window.__zeroPlayRange));
      return json({ plays: PLAYS });
    }
    if (url.indexOf('/api/admin/logs') >= 0) {
      if (url.indexOf('view=stats') >= 0) return json(statsOf(url, window.__zeroRange));
      return json({ logs: LOGS });
    }
    if (url.indexOf('/api/play') >= 0) return json({ ok: true });
    return json({ ok: true });
  };

  var realFetch = window.fetch ? window.fetch.bind(window) : null;
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    // 只拦 API：data/*.json（地图数据）等必须照常走真网络，否则应用起不来
    if (url.indexOf('/api/') < 0) return realFetch ? realFetch(input, init) : Promise.reject(new Error('no fetch'));
    // body 也记下来：用于断言"访问上报真的带了游客编号"（需求 3）
    window.__apiCalls.push({ url: url, method: (init && init.method) || 'GET', body: (init && init.body) || null });
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
  /** 游玩统计看板快照与像素（探针里另开的方法：adminTraffic 的字段与语义保持冻结）。 */
  const plays = () => json('window.__probe.adminPlays()');
  const playsPixelOf = (index) => json(`window.__probe.adminPlaysPointPixel(${index})`);
  const clickTab = async (view) => {
    await ev(`(() => {
      var b = Array.prototype.slice.call(document.querySelectorAll('.admin-tab')).filter(function (x) { return x.dataset.view === '${view}'; })[0];
      if (b) b.click();
      return !!b;
    })()`);
    await sleep(800);
  };
  const clickRange = async (range, rangeId = 'admin-traffic-range') => {
    const clicked = await ev(`(() => {
      var b = document.querySelector('#${rangeId} button[data-range="${range}"]');
      if (b) b.click();
      return !!b;
    })()`);
    await sleep(700);
    return clicked;
  };
  const activeRanges = (rangeId = 'admin-traffic-range') => json(`Array.prototype.slice.call(document.querySelectorAll('#${rangeId} button')).filter(function (b) { return b.classList.contains('active'); }).map(function (b) { return b.dataset.range; })`);
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
  const tooltipText = async (needle = '次访问') => {
    const list = (await overlays()) ?? [];
    return list.find((t) => t.includes(needle)) ?? null;
  };

  // ==================== 0. 用真实路径进入「日志记录」 ====================
  console.log('=== 0. 进入管理端「日志记录」（真实点击下拉菜单） ===');
  // 启动时的访问上报必须带**游客编号**（2026-10 需求 3）：同一个浏览器刷新后仍是同一个号
  const visitCalls = (await json(`window.__apiCalls.filter(function (c) { return c.url.indexOf('/api/visit') >= 0; })`)) ?? [];
  const visitBody = visitCalls.length ? JSON.parse(visitCalls[0].body || '{}') : {};
  check('访问上报带 4 位游客编号（首次访问生成并写进 localStorage）', typeof visitBody.visitor === 'string' && /^\d{4}$/.test(visitBody.visitor), { calls: visitCalls.length, visitor: visitBody.visitor });
  const storedVisitor = await ev(`localStorage.getItem('china-admin-visitor-v1')`);
  check('同一浏览器重复访问时编号保持不变（存在 localStorage，刷新复用）', storedVisitor === visitBody.visitor, { stored: storedVisitor, sent: visitBody.visitor });
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

  // ==================== 7. 位置、访问明细与「完整环境」字段 ====================
  console.log('\n=== 7. 日志条：完整 IP / 完整 UA / 环境详情 / 爬虫标记 ===');
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
  check('tab 变成四个子视图（新增「游玩统计」，流量看板仍留在「日志记录」里）', coexist.tabs.join(',') === 'users,logs,plays,announcements', coexist.tabs);
  check('下方访问明细与「加载更多」保持不变', coexist.rows === 4 && coexist.moreVisible && coexist.moreText === '加载更多', coexist);
  check('图表在访问明细之前（同一子视图内、顺序合理）', coexist.chartBeforeList === true);

  /**
   * 逐行读日志条的结构（2026-10 改版后的形状：整行是 `<details>`，外层一行是 `<summary>`，
   * IP / UA / 环境字段都在 `.log-fold` 折叠区里）。
   * 额外读出**外层行**的文本与「环境详情」入口的位置，用来断言"IP/环境不在外层、入口在右边、同一行"。
   */
  const logRows = await json(`(function () {
    var list = document.querySelector('#admin-log-list');
    return Array.prototype.map.call(list.querySelectorAll('.log-row'), function (row) {
      var line = row.querySelector('.log-line');
      var toggle = row.querySelector('.log-env-toggle');
      var user = row.querySelector('.log-user') || row.querySelector('.log-bot');
      var r = function (el) { return el ? el.getBoundingClientRect() : null; };
      var lr = r(line), ur = r(user), tr = r(toggle);
      return {
        text: row.textContent.replace(/\\s+/g, ' ').trim(),
        outerText: line ? line.textContent.replace(/\\s+/g, ' ').trim() : '',
        isDetails: row.tagName === 'DETAILS',
        foldText: (row.querySelector('.log-fold') || {}).textContent || '',
        bot: row.classList.contains('log-row-bot'),
        time: (row.querySelector('.log-time') || {}).textContent || '',
        user: (row.querySelector('.log-user') || {}).textContent || '',
        badge: (row.querySelector('.log-bot') || {}).textContent || '',
        toggle: toggle ? toggle.textContent.trim() : '',
        // 入口与用户名是否在**同一视觉行**、入口是否在更右边
        toggleSameRow: !!(ur && tr) && Math.abs(ur.top - tr.top) < 8 && Math.abs(ur.bottom - tr.bottom) < 8,
        toggleAtRight: !!(ur && tr && lr) && tr.left > ur.right && tr.right <= lr.right + 1,
        ip: (row.querySelector('.log-ip') || {}).textContent || '',
        ua: (row.querySelector('.log-ua') || {}).textContent || '',
        reasons: Array.prototype.map.call(row.querySelectorAll('.log-bot-reason'), function (b) { return b.textContent; }),
        envKeys: Array.prototype.map.call(row.querySelectorAll('.log-env-key'), function (b) { return b.textContent; }),
        envVals: Array.prototype.map.call(row.querySelectorAll('.log-env-val'), function (b) { return b.textContent; }),
        envMissing: !!row.querySelector('.log-env-empty'),
        hasEnvDetail: !!row.querySelector('.log-fold'),
      };
    });
  })()`);
  const [rowA, rowB, rowC, rowD] = logRows;
  const LONG_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.2210.91';
  check('每行都是可展开的 details，且带 时间 / 用户 / IP / UA / 折叠区', logRows.length === 4 && logRows.every((r) => r.time && r.ip && r.ua && r.hasEnvDetail && r.isDetails), logRows.map((r) => ({ time: r.time, ip: r.ip, ua: r.ua.length, details: r.isDetails })));
  check('显示**完整 UA（不截断）**：一字不差等于服务端给的长 UA（旧实现截到 90 字）', rowA.ua === LONG_UA && LONG_UA.length > 90, { got: rowA.ua.length, want: LONG_UA.length });
  check('显示完整 IP + 地理标签（含国家/州/城市）', rowA.ip.includes('203.0.113.7') && rowA.text.includes('美国') && rowA.text.includes('California') && rowA.text.includes('Los Angeles'), rowA.ip);
  check('无 IP 的行显示占位而不是空白/undefined', rowB.ip.includes('—') && !rowB.text.includes('undefined') && !rowB.text.includes('null'), rowB.ip);
  check('region 与 city 同名时去重（「中国 · 上海」不重复）', (rowC.text.match(/上海/g) || []).length === 1, rowC.text);
  check('环境详情逐字段渲染（平台/语言/时区/屏幕+像素比/视口/核心/内存/触控点/厂商）', rowA.envKeys.join('|') === '平台|语言|时区|屏幕|视口|核心|内存|触控点|厂商' && rowA.envVals.includes('Win32') && rowA.envVals.includes('zh-CN (zh-CN,zh,en)') && rowA.envVals.includes('Asia/Shanghai') && rowA.envVals.includes('1920x1080 @2x') && rowA.envVals.includes('8 GB'), { keys: rowA.envKeys, vals: rowA.envVals });
  check('webdriver=true 与 cookie=false 也被渲染出来', rowC.envKeys.includes('WebDriver') && rowC.envVals.includes('true') && rowC.envKeys.includes('Cookie') && rowC.envVals.includes('false'), { keys: rowC.envKeys, vals: rowC.envVals });
  check('env 为 null 的行显示占位（不留空白块）', rowB.envMissing === true, rowB.envMissing);

  // ==================== 7.1 外层不含 IP/环境，展开入口在右侧同一行（2026-10 需求 2） ====================
  console.log('\n=== 7.1 折叠：外层只留一行、IP/环境在折叠区、入口在右边 ===');
  check('IP 与浏览器环境**不在外层行**里（外层只有时间/用户/判定标签）', logRows.every((r) => !r.outerText.includes('203.0.113.7') && !r.outerText.includes('浏览器环境') && !r.outerText.includes('1920x1080')), logRows.map((r) => r.outerText));
  check('IP 与浏览器环境都在折叠区（.log-fold）里', rowA.foldText.includes('203.0.113.7') && rowA.foldText.includes('浏览器环境') && rowA.foldText.includes(LONG_UA), rowA.foldText.slice(0, 80));
  check('每行都有一个「环境详情」展开入口', logRows.every((r) => r.toggle === '环境详情'), logRows.map((r) => r.toggle));
  check('展开入口与用户名**在同一行**（不单独占一行）', logRows.every((r) => r.toggleSameRow), logRows.map((r) => ({ row: r.toggleSameRow, user: r.user })));
  check('展开入口靠**右**（在用户名右侧、不超出行的右边界）', logRows.every((r) => r.toggleAtRight), logRows.map((r) => ({ right: r.toggleAtRight, user: r.user })));
  const expanded = await json(`(function () {
    var row = document.querySelector('#admin-log-list .log-row');
    var wasOpen = row.open;
    var before = row.getBoundingClientRect().height;
    row.querySelector('summary').click();
    return { wasOpen: wasOpen, nowOpen: row.open, before: before, after: row.getBoundingClientRect().height };
  })()`);
  // ⚠ 不能拿折叠区子元素的 getBoundingClientRect 判断"收起了"：新版 Chrome/Edge 用
  //   `::details-content { content-visibility: hidden }` 实现折叠，子元素**仍然有布局尺寸**。
  //   故这里断言 `details.open` 这个真实状态，并用行自身高度佐证（收起时应当明显更矮）。
  check('点击入口真的展开折叠行（默认收起 → 点后 details.open=true、行变高）', expanded.wasOpen === false && expanded.nowOpen === true && expanded.after > expanded.before, expanded);

  // 新口径（2026-09 二次确认 + 2026-10 需求 3）：未登录**当且仅当有判定理由**时是「爬虫」，
  // 且两种都拼上 4 位游客编号。
  check('未登录 + 有判定理由 → 用户名位置显示「爬虫4321」', rowB.user === '' && rowB.badge === '爬虫4321' && rowB.reasons.length > 0, { user: rowB.user, badge: rowB.badge, reasons: rowB.reasons });
  check('未登录 + 没有任何判定理由 → 用户名位置显示「游客8765」', rowD.user === '游客8765' && rowD.badge === '' && rowD.reasons.length === 0, { user: rowD.user, badge: rowD.badge });
  check('匿名游客行没有爬虫描边（.log-row-bot 只在判定命中时出现）', rowD.bot === false, logRows.map((r) => r.bot));
  check('爬虫行有醒目标记（.log-row-bot 描边 + .log-bot 徽标）', rowB.bot === true && rowC.bot === true && rowA.bot === false, logRows.map((r) => r.bot));
  check('判定标签按机器标签本地化（headless / keyword:curl / automation）', rowB.reasons.join('|') === '无头浏览器|关键词 curl' && (rowC.reasons.join('|') === '自动化标记' || rowC.reasons.join('|') === '自动化标记|自动化标记'), { rowB: rowB.reasons, rowC: rowC.reasons });
  check('登录用户行的用户名是登录名（不带游客编号）', rowA.user === 'admintest' && rowC.user === 'probeuser', { a: rowA.user, c: rowC.user });
  await shot('admin-traffic-8-logs-env.png');

  // ==================== 7.5「加载更多」与首屏共用同一个行渲染函数 ====================
  console.log('\n=== 7.5 翻页追加的行与首屏同构 ===');
  const paged = await json(`(function () {
    var more = document.getElementById('admin-log-more');
    if (more) more.click();
    return true;
  })()`);
  await sleep(900);
  const appended = await json(`(function () {
    var list = document.querySelector('#admin-log-list');
    var rows = Array.prototype.slice.call(list.querySelectorAll('.log-row'));
    var last = rows[rows.length - 1];
    return { count: rows.length, lastHasEnv: !!last.querySelector('.log-fold'), lastHasIp: !!last.querySelector('.log-ip'), lastHasUa: !!last.querySelector('.log-ua'), lastIsDetails: last.tagName === 'DETAILS', lastToggle: !!last.querySelector('.log-env-toggle') };
  })()`);
  check('点「加载更多」后追加的行同样是"折叠行 + IP / UA / 环境详情"结构（首屏与翻页共用同一个行渲染函数）', paged === true && appended.count === 8 && appended.lastHasEnv && appended.lastHasIp && appended.lastHasUa && appended.lastIsDetails && appended.lastToggle, appended);

  // ==================== 8. 游玩统计子视图 ====================
  console.log('\n=== 8. 游玩统计（与日志逐字同构：曲线图 + 条目 + 范围按钮 + 加载更多） ===');
  await ev(`(() => { window.__zeroRange = ''; return true })()`);
  await clickTab('plays');
  const playsBase = await plays();
  check('点「游玩统计」tab 进入 plays 视图', playsBase.view === 'plays', playsBase.view);
  check('游玩统计图表容器非 0 高、已挂载且有 canvas（与日志同一套图表）', playsBase.mounted === true && playsBase.height > 100 && playsBase.canvasCount >= 1, { height: playsBase.height, canvas: playsBase.canvasCount });
  check('游玩统计默认「近七天」= 7 个点、粒度按天，x 轴刻度是日期', playsBase.range === 'week' && playsBase.unit === 'day' && playsBase.pointCount === 7 && playsBase.option?.xAxis.join(',') === '9/10,9/11,9/12,9/13,9/14,9/15,9/16', { counts: playsBase.option?.counts, xAxis: playsBase.option?.xAxis });
  const playStatsCalls = (await json(`window.__apiCalls.filter(function (c) { return c.url.indexOf('/api/admin/plays') >= 0 && c.url.indexOf('view=stats') >= 0; })`)) ?? [];
  check('进入游玩统计即请求 /api/admin/plays?view=stats&range=week（不是复用访问日志接口）', playStatsCalls.length >= 1 && playStatsCalls[0].url.includes('range=week'), playStatsCalls.map((c) => c.url));
  const playCalls = (await json(`window.__apiCalls.filter(function (c) { return c.url.indexOf('/api/admin/plays') >= 0 && c.url.indexOf('view=stats') < 0; })`)) ?? [];
  check('同时请求了游玩条目列表 /api/admin/plays?before=0', playCalls.length >= 1 && playCalls[0].url.includes('before=0'), playCalls.map((c) => c.url));

  const playDom = await json(`(function () {
    var body = document.getElementById('admin-body');
    var list = document.getElementById('admin-play-list');
    var more = document.getElementById('admin-play-more');
    var rows = Array.prototype.slice.call(list.querySelectorAll('.log-row'));
    return {
      sectionTitles: Array.prototype.map.call(body.querySelectorAll('.admin-section-title'), function (s) { return s.textContent.trim(); }),
      hasLogsChartId: !!body.querySelector('#admin-traffic'),
      hasPlaysChartId: !!body.querySelector('#admin-plays'),
      hasPlaysRange: !!body.querySelector('#admin-plays-range'),
      hasPlaysEmpty: !!body.querySelector('#admin-plays-empty'),
      rowCount: rows.length,
      rows: rows.map(function (r) {
        return {
          time: (r.querySelector('.log-time') || {}).textContent || '',
          user: (r.querySelector('.log-user') || {}).textContent || '',
          mode: (r.querySelector('.log-mode') || {}).textContent || '',
          scope: (r.querySelector('.log-scope') || {}).textContent || '',
          source: (r.querySelector('.log-source') || {}).textContent || '',
          isPlain: r.classList.contains('log-row-plain'),
          hasFold: !!r.querySelector('.log-fold'),
        };
      }),
      moreVisible: !!more && getComputedStyle(more).display !== 'none',
      moreText: more ? more.textContent.trim() : '',
      rangeTexts: Array.prototype.map.call(document.querySelectorAll('#admin-plays-range button'), function (b) { return b.textContent; }),
      segmented: (function () { var r = document.getElementById('admin-plays-range'); return !!r && r.className.indexOf('mode-segmented') >= 0; })(),
    };
  })()`);
  check('段落标题与日志同构（游玩量统计 / 最近游玩）', playDom.sectionTitles.join('|') === '游玩量统计|最近游玩', playDom.sectionTitles);
  check('共用同一套范围按钮样式（.mode-segmented + 近一天/近七天/近一个月）', playDom.segmented && playDom.rangeTexts.join('|') === '近一天|近七天|近一个月', playDom.rangeTexts);
  check('图表容器用**另一组 id**（#admin-plays / #admin-plays-empty），日志的 #admin-traffic 不再同时存在', playDom.hasPlaysChartId && playDom.hasPlaysEmpty && playDom.hasPlaysRange && !playDom.hasLogsChartId, playDom);
  check('条目：时间 / **游客编号** / 模式名 / **出题范围** / 来源 五项齐全（2026-10 需求 5）', playDom.rowCount === 3 && playDom.rows.every((r) => r.time && r.user && r.mode && r.scope && r.source), playDom.rows);
  check('模式名复用 modes/capabilities 的模式名（输入模式 / 拼图模式），未知模式原样显示', playDom.rows[0].mode === '输入模式' && playDom.rows[1].mode === '拼图模式' && playDom.rows[2].mode === 'unknown_mode', playDom.rows.map((r) => r.mode));
  check('出题范围来自服务端展示名；老行没有范围列时给占位', playDom.rows[0].scope === '世界' && playDom.rows[1].scope === '云南省' && playDom.rows[2].scope === '—', playDom.rows.map((r) => r.scope));
  check('来源区分 开始按钮 / Tab 重置（Tab 次数计入统计）', playDom.rows[0].source === '开始按钮' && playDom.rows[1].source === 'Tab 重置', playDom.rows.map((r) => r.source));
  check('未登录的游玩条目显示「游客1234」而**不是「未登录」**（2026-10 需求 5）', playDom.rows[1].user === '游客1234' && playDom.rows.every((r) => r.user !== '未登录'), playDom.rows.map((r) => r.user));
  check('登录用户的游玩条目仍显示用户名（不带编号）', playDom.rows[0].user === 'admintest' && playDom.rows[2].user === 'probeuser', playDom.rows.map((r) => r.user));
  check('游玩条目不是折叠行（没有 IP/环境折叠区，与日志结构区分开）', playDom.rows.every((r) => r.isPlain && !r.hasFold), playDom.rows.map((r) => ({ plain: r.isPlain, fold: r.hasFold })));
  check('「加载更多」按钮复用 .board-load-more 且文案与日志一致', playDom.moreVisible && playDom.moreText === '加载更多', { visible: playDom.moreVisible, text: playDom.moreText });

  // tooltip 口径：同一张图，量词换成「次游玩」
  await moveTo(6, 6);
  const playPx = await playsPixelOf(4);
  if (playPx) {
    await moveTo(playPx[0], playPx[1]);
    const playTip = await tooltipText('次游玩');
    check('游玩统计 tooltip 逐字正确：「9月14日 · 35 次游玩」（不是「次访问」）', playTip === '9月14日 · 35 次游玩' && (await tooltipText('次访问')) === null, playTip);
    await shot('admin-traffic-9-plays-tooltip.png');
  } else {
    check('游玩统计 tooltip 逐字正确：「9月14日 · 35 次游玩」（不是「次访问」）', false, '取不到标记点像素');
  }
  await moveTo(6, 6);

  // 范围切换：只刷新图表 + 重新请求 plays 统计 + 不重建 #admin-body
  await ev(`(() => { document.getElementById('admin-body').dataset.probeMark = 'plays-keep-me'; return true })()`);
  const clickedPlaysDay = await clickRange('day', 'admin-plays-range');
  const playsDay = await plays();
  const playsDayMark = await ev(`(() => document.getElementById('admin-body').dataset.probeMark || '')()`);
  const playsDayCalls = (await json(`window.__apiCalls.filter(function (c) { return c.url.indexOf('/api/admin/plays') >= 0 && c.url.indexOf('range=day') >= 0; })`)) ?? [];
  check('游玩统计范围按钮可切「近一天」= 24 点、粒度按小时、真去拉了 day 范围', clickedPlaysDay === true && playsDay.unit === 'hour' && playsDay.pointCount === 24 && playsDay.option?.xAxis.length === 24 && playsDayCalls.length >= 1, { unit: playsDay.unit, points: playsDay.pointCount, calls: playsDayCalls.length });
  check('切范围**不重建** #admin-body（局部刷新，不丢滚动位置）', playsDayMark === 'plays-keep-me', playsDayMark);
  check('游玩统计的按钮选中态跟随', (await activeRanges('admin-plays-range')).join(',') === 'day');
  await shot('admin-traffic-10-plays-day.png');

  // 空态：游玩统计有自己的空态文案（admin.noPlayStats）
  console.log('\n=== 9. 游玩统计空态 ===');
  await ev(`(() => { window.__zeroPlayRange = 'day'; return true })()`);
  await clickRange('week', 'admin-plays-range');
  await clickRange('day', 'admin-plays-range');
  const playsEmpty = await plays();
  const playsEmptyText = await ev(`(() => { var el = document.getElementById('admin-plays-empty'); return el ? el.textContent.trim() : ''; })()`);
  check('游玩统计空态显示 admin.noPlayStats（「暂无游玩数据」）且时间窗口仍在', playsEmpty.emptyVisible === true && playsEmptyText === '暂无游玩数据' && playsEmpty.pointCount === 24, { text: playsEmptyText, points: playsEmpty.pointCount });
  check('游玩统计空态与日志空态是两套文案（不串用 admin.noStats）', playsEmptyText !== '暂无统计数据', playsEmptyText);
  await shot('admin-traffic-11-plays-empty.png');
  await ev(`(() => { window.__zeroPlayRange = ''; return true })()`);
  await clickRange('week', 'admin-plays-range');
  check('恢复有数据后空态自动收起', (await plays()).emptyVisible === false);

  // 离开 plays 视图：两个容器的实例都被换掉，不残留
  await clickTab('logs');
  const backToLogs = await traffic();
  const playsGone = await plays();
  check('切回日志视图后：日志图表重新挂上、游玩容器不再存在（实例随 DOM 一起销毁）', backToLogs.mounted === true && backToLogs.canvasCount >= 1 && playsGone.rect === null && playsGone.canvasCount === 0, { logs: backToLogs.canvasCount, playsRect: playsGone.rect });

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
