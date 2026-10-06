/**
 * 手机端访问门槛的运行时验收（2026-10 需求）：真实浏览器 + **真实手机 UA/触屏模拟**。
 *
 * 需求口径（用户原话）：
 *   「当用户用手机访问时，在加载之前，窗口询问『请用电脑端访问』，下方添加按钮『继续访问』，
 *     如果用户点击继续访问，那么在手机端，用户在手机上看的内容是电脑视图显示，
 *     而不是 ui 错乱的手机视图。」
 *
 * 为什么必须运行时验：单测（`src/mobileGate.test.ts`）只能钉住"内联副本与常量一致"与
 * `isPhoneClient` 的判定，覆盖不到三件真正决定观感的事：
 *   1. 门槛**是否真的在首屏就弹出来**（内联脚本必须在 bundle 之前生效）；
 *   2. 点「继续访问」后 **layout viewport 是不是真的变成了桌面宽度**（`clientWidth===1280`）——
 *      这正是"电脑视图而不是错乱的手机视图"的客观判据；
 *   3. 选择是否被记住（同一浏览器第二次访问不再打扰）。
 * 故这里用 CDP 的 `Emulation.setUserAgentOverride` + `setDeviceMetricsOverride(mobile:true)`
 * + `setTouchEmulationEnabled` 造一个"手机"，再用真实点击按下按钮。
 *
 * 用法：npm run build && node scripts/verify-mobile-gate.mjs
 *      node scripts/verify-mobile-gate.mjs --prod      # 直连线上（https://mapmemory.cn/），跳过本地静态服
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BROWSER = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9995;
const CDP = 9996;
const OUT = path.join(ROOT, 'docs', 'shots');
fs.mkdirSync(OUT, { recursive: true });

/** `--prod`：直连线上站点验收（本地静态服与 dist 都不参与），用于部署后确认门槛真的在线上生效。 */
const PROD = process.argv.includes('--prod');
const BASE = PROD ? 'https://mapmemory.cn' : `http://127.0.0.1:${PORT}`;

/** 与 src/mobileGate.ts 的常量逐字一致（本脚本只读，不改）。 */
const GATE_KEY = 'china-admin-mobile-gate-v1';
const DESKTOP_VIEWPORT = 'width=1280';
const GATE_CLASS = 'mobile-gate';

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Mobile/15E148 Safari/604.1';
const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';
const GOOGLEBOT_MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : '  → ' + JSON.stringify(detail)}`);
};

const server = PROD
  ? null
  : spawn(process.execPath, [path.join(ROOT, 'scripts', 'static-server.mjs'), String(PORT), path.join(ROOT, 'dist')], { stdio: 'ignore' });
await sleep(PROD ? 0 : 1200);
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-mobile-gate-'));
const browser = spawn(
  BROWSER,
  ['--headless=new', '--disable-gpu', '--no-first-run', `--user-data-dir=${userDir}`, `--remote-debugging-port=${CDP}`, '--window-size=1440,900', '--force-device-scale-factor=1', 'about:blank'],
  { stdio: 'ignore' },
);

let ws; let id = 0; const pending = new Map();
const send = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })); });

try {
  let target = null;
  for (let i = 0; i < 60; i++) {
    await sleep(400);
    try {
      const l = await fetch(`http://127.0.0.1:${CDP}/json/list`).then((r) => r.json());
      target = l.find((t) => t.type === 'page');
      if (target?.webSocketDebuggerUrl) break;
    } catch { /* wait */ }
  }
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  ws.addEventListener('message', (event) => {
    const m = JSON.parse(event.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
    }
  });
  await send('Runtime.enable');
  await send('Page.enable');

  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression: `(async () => (${expression}))()`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed');
    return r.result.value;
  };
  const asJson = (expression) => ev(`JSON.stringify(${expression})`).then((s) => JSON.parse(s));
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, 'base64'));
    console.log('  截图', path.relative(ROOT, path.join(OUT, name)));
  };
  const clickContinue = () =>
    ev(`(function () { var b = document.getElementById('mobile-gate-continue'); if (!b) return false; b.click(); return true; })()`);
  const readGate = () =>
    asJson(`(function () {
      var html = document.documentElement;
      var gate = document.getElementById('mobile-gate');
      var app = document.getElementById('app');
      var btn = document.getElementById('mobile-gate-continue');
      var meta = document.getElementById('viewport-meta');
      var gs = gate ? getComputedStyle(gate) : null;
      var as = app ? getComputedStyle(app) : null;
      return {
        hasClass: html.classList.contains('${GATE_CLASS}'),
        gateVisible: !!gs && gs.display !== 'none' && gs.visibility !== 'hidden',
        gateText: gate ? gate.textContent.replace(/\\s+/g, ' ').trim() : '',
        title: (document.getElementById('mobile-gate-title') || {}).textContent || '',
        button: btn ? btn.textContent.trim() : '',
        appVisibility: as ? as.visibility : '',
        viewport: meta ? meta.getAttribute('content') : '',
        clientWidth: html.clientWidth,
        bodyWidth: document.body.clientWidth,
      };
    })()`);
  /** 手机模拟：UA + 移动端 metrics（mobile:true 会让 CSS 按设备宽度排版）+ 触屏。 */
  const emulatePhone = async (ua) => {
    await send('Emulation.setUserAgentOverride', { userAgent: ua, platform: 'iPhone' });
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
    await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  };
  const emulateDesktop = async () => {
    await send('Emulation.setUserAgentOverride', { userAgent: DESKTOP_UA, platform: 'Win32' });
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await send('Emulation.setTouchEmulationEnabled', { enabled: false });
  };
  /**
   * 打开页面。
   *
   * `waitFor` 刻意区分两种时机，因为**这是本轮抓到的真实缺陷所在**：
   *   · `'dom'`：只等静态 DOM（`#app` 与模式 tab）—— 此时主 bundle（type=module，延迟执行）
   *     可能还在跑、`DOMContentLoaded` 还没触发。遮罩与按钮**此刻已经可见可点**，
   *     所以门槛的点击处理器必须**已经挂上**（用即时事件委托，而不是挂在 DOMContentLoaded 上）。
   *     旧实现挂在 DOMContentLoaded 上，在生产（慢网）就是这个窗口里"点按钮没反应"。
   *   · `'load'`：等到 `document.readyState === 'complete'`。
   */
  const openPage = async (waitFor = 'dom') => {
    await send('Page.navigate', { url: `${BASE}/` });
    for (let i = 0; i < 90; i++) {
      await sleep(300);
      const ready = await ev(`document.readyState`).catch(() => 'loading');
      if (waitFor === 'load') {
        if (ready === 'complete') break;
        continue;
      }
      const domReady = await ev(`!!document.getElementById('app') && !!document.querySelector('#mode-tabs button')`).catch(() => false);
      if (domReady === true) break;
    }
    await sleep(waitFor === 'load' ? 500 : 150);
  };
  const openAndWait = () => openPage('load');

  // ==================== 1. 桌面：什么都不该发生 ====================
  console.log('=== 1. 桌面浏览器：不弹门槛、viewport 不动 ===');
  await emulateDesktop();
  await ev('localStorage.clear()').catch(() => {});
  await openAndWait();
  const desktop = await readGate();
  check('桌面 UA 下没有门槛（html.mobile-gate 不存在）', desktop.hasClass === false, desktop.hasClass);
  check('桌面下 #app 正常可见', desktop.appVisibility === 'visible', desktop.appVisibility);
  check('桌面下 viewport 仍是 device-width（没有被改成桌面宽度）', desktop.viewport.includes('device-width'), desktop.viewport);
  check('桌面下布局视口就是窗口宽度（1440）', desktop.clientWidth === 1440, desktop.clientWidth);

  // ==================== 2. 手机首次访问：门槛在首屏弹出、且已经按电脑视图排版 ====================
  console.log('\n=== 2. 手机首次访问：门槛弹出 + 电脑 viewport + 加载完成前就能点 ===');
  await emulatePhone(IPHONE_UA);
  await ev('localStorage.clear()').catch(() => {});
  // 限速到约 150KB/s：让 1.3MB 的主 bundle 需要好几秒才能执行完，从而**稳定复现**
  // "遮罩已可见可点、但 DOMContentLoaded 还没触发"的那个窗口（本地不营造这个条件太快，测不到）。
  await send('Network.enable');
  await send('Network.emulateNetworkConditions', { offline: false, latency: 400, downloadThroughput: 150 * 1024, uploadThroughput: 150 * 1024 });
  // 刻意**只等静态 DOM**：这时主 bundle 还在下载/执行，遮罩却已经可见可点
  await openPage('dom');
  const phone = await readGate();
  const earlyReady = await ev(`document.readyState`);
  check('门槛生效时页面**还没加载完**（这才是真实用户会遇到的最早时机）', earlyReady !== 'complete', earlyReady);
  check('手机 UA + 触屏 → 门槛生效（html.mobile-gate 存在）', phone.hasClass === true, phone.hasClass);
  check('门槛真的显示出来（不是藏在 DOM 里）', phone.gateVisible === true, { visible: phone.gateVisible });
  check('标题就是「请用电脑端访问」', phone.title === '请用电脑端访问', phone.title);
  check('下方按钮就是「继续访问」', phone.button === '继续访问', phone.button);
  check('门槛生效时 #app 被隐藏（visibility: hidden，仍保留布局供图表测量）', phone.appVisibility === 'hidden', phone.appVisibility);
  check('手机上一开始就按电脑 viewport 排版（width=1280，不是 device-width）', phone.viewport === DESKTOP_VIEWPORT, phone.viewport);
  check('布局视口宽度 = 1280（这就是"电脑视图"而非错乱手机视图的客观判据）', phone.clientWidth === 1280, { clientWidth: phone.clientWidth, body: phone.bodyWidth });
  await shot('mobile-gate-1-phone-blocked.png');

  // ==================== 3. 点「继续访问」：放行 + 电脑视图 + 记住选择 ====================
  console.log('\n=== 3. 点「继续访问」：放行、电脑视图、记住选择 ===');
  const clicked = await clickContinue();
  await sleep(600);
  const after = await readGate();
  check(`按钮在**页面还没加载完**时（readyState=${earlyReady}）就可用 —— 处理器不依赖 DOMContentLoaded`, clicked === true && after.hasClass === false, { clicked, hasClass: after.hasClass, readyState: earlyReady });
  check('放行后 #app 恢复可见（能看到内容了）', after.appVisibility === 'visible', after.appVisibility);
  check('放行后仍是电脑 viewport（width=1280）—— 用户看到的是电脑视图', after.viewport === DESKTOP_VIEWPORT && after.clientWidth === 1280, { viewport: after.viewport, clientWidth: after.clientWidth });
  check('门槛遮罩不再显示', after.gateVisible === false, after.gateVisible);
  const stored = await ev(`localStorage.getItem('${GATE_KEY}')`);
  check('选择被记进 localStorage（下次不再打扰）', stored === 'continue', stored);
  // 顺带确认放行后应用是真的能用（地图画布按**桌面宽度**铺开），而不是"放行了一个空白页"。
  // 这里刻意断言 canvas 宽度 == 布局视口宽度（1280），而不是断言"有个画布"：
  // 手机视图下画布会是 390 宽 —— 那正是需求要避免的"错乱手机视图"。
  // 先把限速恢复（否则 1.3MB 要等十几秒），再等主 bundle 真的把地图画出来。
  await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  for (let i = 0; i < 90; i++) {
    await sleep(400);
    if ((await ev(`!!document.querySelector('#map canvas')`).catch(() => false)) === true) break;
  }
  const usable = await asJson(`(function () {
    var canvas = document.querySelector('#map canvas');
    var rect = canvas ? canvas.getBoundingClientRect() : null;
    return { hasCanvas: !!canvas, w: rect ? Math.round(rect.width) : 0, h: rect ? Math.round(rect.height) : 0, tabs: document.querySelectorAll('#mode-tabs button').length };
  })()`);
  check(
    '放行后应用按**桌面宽度**铺开（地图画布宽度 = 布局视口 1280，模式 tab 在）',
    usable.hasCanvas && usable.w === after.clientWidth && usable.h > 200 && usable.tabs === 4,
    usable,
  );
  await shot('mobile-gate-2-phone-continued.png');

  // ==================== 4. 同一浏览器第二次访问：不再打扰 ====================
  console.log('\n=== 4. 同一浏览器再次访问：不再打扰（仍按电脑视图） ===');
  await openAndWait();
  const again = await readGate();
  check('第二次访问不再弹门槛', again.hasClass === false && again.appVisibility === 'visible', { hasClass: again.hasClass, visibility: again.appVisibility });
  check('第二次访问仍按电脑 viewport 排版', again.viewport === DESKTOP_VIEWPORT && again.clientWidth === 1280, { viewport: again.viewport, clientWidth: again.clientWidth });

  // ==================== 5. 手机爬虫：不弹门槛（SEO 要抓正文） ====================
  console.log('\n=== 5. 手机爬虫（Googlebot-Smartphone）：不弹门槛 ===');
  await emulatePhone(GOOGLEBOT_MOBILE_UA);
  await ev('localStorage.clear()').catch(() => {});
  await openAndWait();
  const bot = await readGate();
  check('爬虫 UA 下没有门槛，#app 直接可见', bot.hasClass === false && bot.appVisibility === 'visible', { hasClass: bot.hasClass, visibility: bot.appVisibility });
  check('爬虫下 viewport 保持 device-width（可爬的是移动布局的正文）', bot.viewport.includes('device-width'), bot.viewport);
} catch (err) {
  check('脚本执行未抛错', false, String(err));
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  browser.kill();
  server?.kill();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n===== ${results.length - failed.length}/${results.length} 通过 =====`);
for (const f of failed) console.log(`  - ${f.name}: ${JSON.stringify(f.detail)}`);
process.exit(failed.length ? 1 : 0);
