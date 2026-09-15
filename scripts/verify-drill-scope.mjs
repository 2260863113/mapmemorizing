/**
 * 本轮验收脚本（运行时，真实浏览器 + 真实指针事件）：全局设置「下钻后隐藏无关地区」。
 *
 * 需求口径（用户 2026-09）：
 *   1. 全局设置里新增开关，**默认打开**；
 *   2. 打开时 = 现在的样子：下钻到次级区域后，无关地区完全不可见；
 *   3. 关闭时：无关地区**依然显示**，但不可交互，且填充为**比空白底色更深一档的浅灰**；
 *   4. 关闭时下钻到省份，**依然保持五级精细度分段**（不强制最无损档）。
 *
 * 为什么必须运行时验（而不是只靠单测）：
 *   · 「范围外的面到底画没画」只有读回 ECharts 真正生效的 `geo.regions` 才算数；
 *   · 「关掉开关后下钻是不是还强制 lossless」要看真正换到哪张地图档；
 *   · 「灰区不可交互」必须用**真实鼠标事件**打上去，看画布有没有反应。
 * 单测（`src/map/layers.test.ts` / `src/map/tiers.test.ts` / `src/store.test.ts`）锁的是纯逻辑，
 * 本脚本锁的是「这两者接起来之后，用户看到与点到的到底是什么」。
 *
 * 用 Edge 而不是 Chrome：与其余验收脚本一致（本机 Chrome 过旧，不支持 ES module）。
 *
 * 用法：npm run build && node scripts/verify-drill-scope.mjs
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
const PROVINCE = '440000'; // 广东省：既有下级单位、又有邻省，是本需求最典型的样例
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 与 `src/map/tiers.ts` 同一套阈值（此处独立重算：验收脚本要自己能判断"档位是不是跟着 zoom 走"）。 */
const tierOfZoomBand = (z) => (z < 2 ? 'ultra' : z < 6 ? 'pro' : z < 10 ? 'fine' : z < 14 ? 'plus' : 'lossless');
/** 亮度加权近似（0.299R + 0.587G + 0.114B）：用于「灰色比空白更深」这一条。 */
const luma = (color) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(color).trim());
  if (!m) return NaN;
  const n = parseInt(m[1], 16);
  return 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
};
const isTransparent = (c) => !c || c === 'rgba(0,0,0,0)' || c === 'transparent';

/**
 * 画布指纹：稀疏采样各 canvas 的像素，用来判断「悬停有没有让地图重绘」。
 *
 * 注意 ECharts/zrender 在本项目里建了**两张** canvas：0 = 主画布（地图就在这层），
 * 1 = 悬停层（emphasis 高亮画在这层，平时全透明）—— 实测悬停本省面时只有第 1 张的指纹变。
 */
const CANVAS_HASH = `(function () {
  var out = [];
  var list = document.querySelectorAll('#map canvas');
  for (var k = 0; k < list.length; k++) {
    var c = list[k];
    var d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    var h = 2166136261;
    for (var i = 0; i < d.length; i += 28) { // 每 7 个像素采一次（RGBA）
      h = ((h ^ d[i]) * 16777619) >>> 0;
      h = ((h ^ d[i + 1]) * 16777619) >>> 0;
      h = ((h ^ d[i + 2]) * 16777619) >>> 0;
    }
    out.push(k + ':' + c.width + 'x' + c.height + ':' + h);
  }
  return out.join('|');
})()`;

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : '  → ' + JSON.stringify(detail)}`);
};

const server = spawn(process.execPath, [path.join(ROOT, 'scripts', 'static-server.mjs'), String(PORT), path.join(ROOT, 'dist')], { stdio: 'ignore' });
await sleep(1200);
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-drill-'));
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

  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression: `(async () => (${expression}))()`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed');
    return r.result.value;
  };
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    const f = path.join(OUT, name);
    fs.writeFileSync(f, Buffer.from(r.data, 'base64'));
    console.log('  截图', path.relative(ROOT, f));
  };
  /** 真实指针事件（CSS 像素、相对视口左上角）。 */
  const mouse = (type, x, y, button = 'none') =>
    send('Input.dispatchMouseEvent', { type, x, y, button, buttons: button === 'left' ? 1 : 0, clickCount: type === 'mouseMoved' ? 0 : 1 });
  const moveTo = async (x, y) => { await mouse('mouseMoved', x, y); await sleep(220); };
  const clickAt = async (x, y) => {
    await moveTo(x, y);
    await mouse('mousePressed', x, y, 'left');
    await mouse('mouseReleased', x, y, 'left');
    await sleep(450);
  };
  /** 等应用与探针就绪。 */
  const loadPage = async (url) => {
    await send('Page.navigate', { url });
    for (let i = 0; i < 90; i++) {
      await sleep(500);
      if ((await ev('typeof window.__probe').catch(() => 'no')) === 'object') break;
    }
    await sleep(600);
  };
  const shade = () => ev('JSON.stringify(window.__probe.drillShade())').then(JSON.parse);
  const world = () => ev('JSON.stringify(window.__probe.renderedRegions())').then(JSON.parse);
  const canvasHash = () => ev(CANVAS_HASH);
  /** 打开设置面板 → 设置开关 → 保存（走真实 UI 路径，不是直接改对象）。 */
  const setToggleThroughUi = async (on) => {
    await ev(`(() => { document.getElementById('btn-settings').click(); return true })()`);
    await sleep(350);
    await ev(`(() => {
      var box = document.getElementById('set-hide-unrelated-drill');
      if (box.checked !== ${on}) box.click();
      document.getElementById('set-save').click();
      return true;
    })()`);
    await sleep(600);
  };
  const storedSetting = () => ev(`(() => {
    var raw = localStorage.getItem('china-admin-settings-v1');
    return raw ? JSON.parse(raw).hideUnrelatedOnDrill : null;
  })()`);

  /**
   * 取画布上某点**真正看到的颜色**：canvas 坐标（探针给的 pixel），5×5 窗口取众数（避开描边与抗锯齿）。
   *
   * 注意两点（都是实测踩出来的）：
   *   1. 画布不止一张：zrender 建了 2 张（一张专门放悬停高亮，平时全透明），故逐张取样、
   *      取**最下面一张在该点有内容的**；
   *   2. 地图空白处**画布本身是透明的**，用户看到的空白色来自 CSS（`#map { background: var(--map-bg) }`），
   *      所以"都没画"时要回落到容器的计算背景色 —— 否则会把空白读成"没有颜色"。
   */
  const patchColor = (cx, cy) => ev(`(function () {
    var out = { canvas: -1, color: '', stack: [] };
    document.querySelectorAll('#map canvas').forEach(function (c, k) {
      var d = c.getContext('2d').getImageData(${cx - 2}, ${cy - 2}, 5, 5).data;
      var counts = {}, best = '', bestN = 0;
      for (var i = 0; i < d.length; i += 4) {
        if (d[i + 3] < 200) continue;
        var hex = '#' + [d[i], d[i + 1], d[i + 2]].map(function (v) { return ('0' + v.toString(16)).slice(-2); }).join('');
        counts[hex] = (counts[hex] || 0) + 1;
      }
      for (var kk in counts) if (counts[kk] > bestN) { bestN = counts[kk]; best = kk; }
      out.stack.push({ canvas: k, color: best, n: bestN });
      if (out.canvas < 0 && bestN > 0) { out.canvas = k; out.color = best; }
    });
    if (!out.color) { out.color = getComputedStyle(document.getElementById('map')).backgroundColor; out.canvas = 'css'; }
    return out;
  })()`);

  /** `rgb(r, g, b)` / `#rrggbb` → `#rrggbb`（CSS 背景色与画布像素统一成一种写法再比较）。 */
  const toHex = (color) => {
    const s = String(color).trim();
    const m = /^rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(s);
    if (m) return '#' + m.slice(1, 4).map((v) => Number(v).toString(16).padStart(2, '0')).join('');
    return s.toLowerCase();
  };

  /**
   * 整幅地图的**颜色直方图**（每 25px 取一格，取该格的主色，键已归一成 `#rrggbb`）。
   *
   * 为什么用直方图而不是单个取样点：地图上还叠着地名标签（白衬底）与省界粗线，
   * 单点很可能正好落在标签上（实测就是这么踩到的）。直方图看的是**整片区域的面积**：
   * 同一台相机、同样的取样格，前后两次只差一个设置，多出来的浅灰格数就应当等于少掉的空白格数。
   */
  const histogram = async () => {
    const raw = await ev(`(function () {
      var canvases = document.querySelectorAll('#map canvas');
      var W = canvases[0].width, H = canvases[0].height;
      var counts = {};
      function sample(x, y) {
        for (var c = 0; c < canvases.length; c++) {
          var d = canvases[c].getContext('2d').getImageData(x, y, 3, 3).data;
          var inner = {};
          for (var i = 0; i < d.length; i += 4) {
            if (d[i + 3] < 200) continue;
            var hex = '#' + [d[i], d[i + 1], d[i + 2]].map(function (v) { return ('0' + v.toString(16)).slice(-2); }).join('');
            inner[hex] = (inner[hex] || 0) + 1;
          }
          var best = '', bestN = 0;
          for (var k in inner) if (inner[k] > bestN) { bestN = inner[k]; best = k; }
          if (bestN > 0) return best;
        }
        return getComputedStyle(document.getElementById('map')).backgroundColor;
      }
      for (var y = 4; y < H; y += 25) for (var x = 4; x < W; x += 25) { var s = sample(x, y); counts[s] = (counts[s] || 0) + 1; }
      return counts;
    })()`);
    return Object.fromEntries(Object.entries(raw).map(([k, v]) => [toHex(k), v]));
  };

  // ==================== 第 1 页：中国档（深链：市级 + 下钻广东省） ====================
  await loadPage(`http://127.0.0.1:${PORT}/?probe=1&g=city&p=${PROVINCE}`);
  const base = await shade();
  check('基线有效：深链进来确实停在「下钻广东省」', base.drilledProvince === PROVINCE, { drilledProvince: base.drilledProvince, setting: base.setting });

  console.log('\n=== 1. 全局设置面板：新增「下钻后隐藏无关地区」 ===');
  await ev(`(() => { document.getElementById('btn-settings').click(); return true })()`);
  await sleep(400);
  const panel = JSON.parse(await ev(`JSON.stringify((function () {
    var box = document.getElementById('set-hide-unrelated-drill');
    var row = box ? box.closest('.row') : null;
    var label = row ? row.querySelector('.row-label') : null;
    var section = row ? row.previousElementSibling : null;
    var rb = row ? row.getBoundingClientRect() : null;
    var lb = label ? label.getBoundingClientRect() : null;
    var cb = box ? box.getBoundingClientRect() : null;
    return {
      exists: !!box,
      checked: box ? box.checked : null,
      labelText: label ? label.textContent.trim() : '',
      sectionTitle: section ? section.textContent.trim() : '',
      leftAligned: !!(rb && lb) && Math.abs(lb.left - rb.left) < 2,
      controlRight: !!(rb && cb) && Math.abs(cb.right - rb.right) < 2,
      controlRightOfText: !!(lb && cb) && cb.left >= lb.right - 1,
    };
  })())`));
  check('设置面板新增「下钻后隐藏无关地区」开关（位于「地图下钻」分区）', panel.exists && panel.labelText.startsWith('下钻后隐藏无关地区') && panel.sectionTitle === '地图下钻', panel);
  check('默认打开', panel.checked === true, panel.checked);
  check('新设置行与其余行同样的排版（文字左对齐、控件右对齐）', panel.leftAligned && panel.controlRight && panel.controlRightOfText);
  await shot('drill-scope-1-settings.png');
  // 关掉面板再看地图：面板是浮层，开着会挡住 elementFromPoint 与画布像素取样
  await ev(`(() => { document.getElementById('set-cancel').click(); return true })()`);
  await sleep(300);

  console.log('\n=== 2. 打开（默认）：观感与历史完全一致 ===');
  const on = base;
  check('范围外的面不可见（透明）但仍登记为 silent', isTransparent(on.outScope.areaColor) && on.outScope.silent === true, on.outScope);
  check('本省的面正常上色且可交互', !isTransparent(on.inScope.areaColor) && on.inScope.silent === false, on.inScope);
  check('省界线只画本省（其余省的省界都不画）', on.provinceLineProvinces.join(',') === PROVINCE && on.provinceLineCount > 0, { provinces: on.provinceLineProvinces, count: on.provinceLineCount });
  check('下钻强制最精细档 lossless（且当前 zoom < 14，说明确实是"强制"而不是阈值自然到了）', on.tier === 'lossless' && on.zoom < 14, { tier: on.tier, zoom: +on.zoom.toFixed(2), band: tierOfZoomBand(on.zoom) });
  await shot('drill-scope-2-drill-hidden.png');

  // 两个落点（本省面 / 省外那片区域）在两种设置下位置不变，故先算出来、后面用**同一个像素点**做前后对比
  const rect = JSON.parse(await ev(`JSON.stringify((function () {
    var c = document.querySelector('#map canvas');
    var r = c.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  })())`));
  /** 把探针给的数据坐标像素换算成视口像素，并确认那个点确实落在画布上（不是被按钮/侧栏盖住）。 */
  const toHit = async (p) => {
    if (!p || !p.pixel) return null;
    const x = Math.round(rect.left + p.pixel[0]);
    const y = Math.round(rect.top + p.pixel[1]);
    if (x < rect.left + 2 || x > rect.left + rect.width - 2 || y < rect.top + 2 || y > rect.top + rect.height - 2) return null;
    const tag = await ev(`(() => { var e = document.elementFromPoint(${x}, ${y}); return e ? e.tagName + '.' + (e.className || '') : 'none'; })()`);
    return /^CANVAS/.test(tag) ? { x, y, cx: p.pixel[0], cy: p.pixel[1], name: p.name, tag } : null;
  };
  const inHit = await toHit(on.pixels.inScope);
  let outHit = null;
  for (const cand of on.pixels.outScope) {
    outHit = await toHit(cand);
    if (outHit) break;
  }
  check('拿得到两个可派的指针落点（本省面 + 省外那片区域，且都打在画布上）', !!inHit && !!outHit, { inScope: inHit, outScope: outHit });

  // 像素级验收：打开时那片区域是「空白」，关闭后应当变成「浅灰」
  await moveTo(6, 6); // 先把指针移出地图，免得悬停高亮混进像素
  await sleep(250);
  const onInPixel = inHit ? await patchColor(inHit.cx, inHit.cy) : null;
  const onHist = await histogram();
  check('打开时：整幅地图上**一格浅灰都没有**（其他地区完全不可见）', (onHist['#b0b5bd'] ?? 0) === 0, { 浅灰格: onHist['#b0b5bd'] ?? 0, 空白格: onHist['#d1d5db'] ?? 0 });
  check('打开时：本省面画的是自己的颜色（不是空白底色）', !!onInPixel && toHex(onInPixel.color) !== '#d1d5db', onInPixel);

  console.log('\n=== 3. 关闭：依然显示其他地区（浅灰、不可交互）===');
  await setToggleThroughUi(false);
  const off = await shade();
  check('保存后立即持久化到设置档', (await storedSetting()) === false);
  check('范围外的面不再透明（看得见其他地区）', !isTransparent(off.outScope.areaColor), off.outScope);
  // 本轮口径的**独立重述**（不引用源码常量）：浅灰 #b0b5bd，地图空白底色 #d1d5db。
  // 颜色被人有意改动时这里会红，正好逼着一起改口径并复核观感。
  check('灰是「比空白底色更深一档的浅灰」', off.outScope.areaColor === '#b0b5bd' && luma('#b0b5bd') < luma('#d1d5db'), {
    fill: off.outScope.areaColor,
    空白底色: '#d1d5db',
    亮度: [+luma(off.outScope.areaColor).toFixed(1), +luma('#d1d5db').toFixed(1)],
  });
  check('范围外的面**仍然不可交互**（silent：不响应悬停与点击）', off.outScope.silent === true, off.outScope);
  check('范围外照画省界（邻省省界还在，否则整片灰看不出分界）', off.provinceLineProvinces.length > 1 && off.provinceLineProvinces.includes(PROVINCE), { provinces: off.provinceLineProvinces.length, count: off.provinceLineCount });
  check('本省的面不受影响（照常上色 + 可交互）', !isTransparent(off.inScope.areaColor) && off.inScope.silent === false, off.inScope);
  check('不再强制最无损档：档位跟着 zoom 走（五级分段）', off.tier === tierOfZoomBand(off.zoom) && off.tier !== 'lossless', { tier: off.tier, zoom: +off.zoom.toFixed(2), band: tierOfZoomBand(off.zoom) });
  await shot('drill-scope-3-drill-shown.png');

  // 同一幅地图的前后对比：多出一大片浅灰，而本省面一个像素都没变
  const offInPixel = inHit ? await patchColor(inHit.cx, inHit.cy) : null;
  const offHist = await histogram();
  const onBlank = onHist['#d1d5db'] ?? 0;
  const offBlank = offHist['#d1d5db'] ?? 0;
  const offGray = offHist['#b0b5bd'] ?? 0;
  check('像素级：关闭后地图上出现一大片浅灰（用户看得见的"其他地区"）', offGray > 100, { 浅灰格: offGray, 空白格: offBlank });
  check(
    '像素级：多出来的浅灰 ≈ 少掉的空白（同一片区域只是换了颜色，不是凭空多画了一块）',
    Math.abs(onBlank - offBlank - offGray) <= Math.max(20, offGray * 0.2),
    { 打开时空白: onBlank, 关闭后空白: offBlank, 关闭后浅灰: offGray, 差值: onBlank - offBlank - offGray },
  );
  check(`像素级：本省面在两种设置下逐像素一致（关闭开关不影响本省；取样点 ${inHit?.name ?? '?'}）`, !!onInPixel && onInPixel.color === offInPixel?.color, { 打开时: onInPixel?.color, 关闭后: offInPixel?.color, 省外取样点: outHit?.name });

  console.log('\n=== 4. 真实指针：灰区确实点不动、悬停无反应 ===');
  if (inHit && outHit) {
    await moveTo(6, 6); // 移出地图，作为"没有任何悬停"的基线
    await sleep(250);
    const hBase = await canvasHash();
    await moveTo(outHit.x, outHit.y);
    const hGray = await canvasHash();
    await moveTo(6, 6);
    await sleep(250);
    const hBack = await canvasHash();
    await moveTo(inHit.x, inHit.y);
    const hIn = await canvasHash();
    await moveTo(6, 6);
    await sleep(250);
    const hAfter = await canvasHash();
    check('对照：悬停**本省**面会让画布重绘（说明这条断言方法本身有效）', hIn !== hBase, { base: hBase, inScope: hIn });
    check(`悬停省外灰面（${outHit.name}）画布毫无变化 → 不响应悬停`, hGray === hBase, { base: hBase, gray: hGray });
    check('移开后画布回到基线（没有残留高亮）', hBack === hBase && hAfter === hBase, { base: hBase, back: hBack, after: hAfter });
    check('灰区不给 tooltip/高亮 DOM：地图容器里没有新增的浮层文本', (await ev(`(() => {
      var texts = [];
      document.querySelectorAll('#map div').forEach(function (d) {
        var s = getComputedStyle(d);
        if (s.position === 'absolute' && s.display !== 'none' && s.visibility !== 'hidden' && (d.textContent || '').trim()) texts.push(d.textContent.trim().slice(0, 20));
      });
      return texts.length;
    })()`)) === 0);
  }

  console.log('\n=== 5. 暗主题下灰区同样可见且区别于底色 ===');
  await ev(`(() => { document.getElementById('btn-theme').click(); return true })()`);
  await sleep(700);
  const dark = await shade();
  check('暗主题：范围外的面仍非透明，且不是底色本身（不会"消失"）', !isTransparent(dark.outScope.areaColor) && dark.outScope.areaColor !== '#374151', { areaColor: dark.outScope.areaColor });
  await shot('drill-scope-4-dark.png');
  await ev(`(() => { document.getElementById('btn-theme').click(); return true })()`);
  await sleep(700);

  console.log('\n=== 6. 点灰区 = 点空白（返回上一层），不会被当成可答题/可下钻的面 ===');
  const beforeClick = (await shade()).drilledProvince;
  await clickAt(outHit.x, outHit.y);
  const afterClick = (await shade()).drilledProvince;
  check('点灰区后确实触发了"返回上一层"（说明它等同点空白，而不是一个可交互的面）', beforeClick === PROVINCE && afterClick === null, { beforeClick, afterClick });

  // ==================== 第 2 页：世界档（启动即按已存设置生效） ====================
  console.log('\n=== 7. 世界档：启动时按已存设置生效 ===');
  await loadPage(`http://127.0.0.1:${PORT}/?probe=1&g=world&c=AS`);
  const wOff = await world();
  check('页面刚加载就已按设置档生效（setting=false，无需再点一次设置）', wOff.setting === false, { setting: wOff.setting });
  check('世界档关闭：其他洲的面灰显可见（不再透明）', !wOff.france.transparent && !wOff.brazil.transparent, { france: wOff.france, brazil: wOff.brazil });
  check('世界档关闭：其他洲的面**仍然 silent**（可见但不可交互）', wOff.outOfScopeSilent === true, { france: wOff.france, brazil: wOff.brazil });
  check('世界档关闭：其他洲的面照画国界（否则整片灰糊成一块）', wOff.france.borderWidth > 0 && wOff.brazil.borderWidth > 0, { france: wOff.france.borderWidth, brazil: wOff.brazil.borderWidth });
  check('世界档关闭：本洲的国面照常上色', wOff.inScopePainted === true, wOff.china);
  await shot('drill-scope-5-world-shown.png');

  console.log('\n=== 8. 世界档：重新打开后回到默认观感（回归闸门）===');
  await setToggleThroughUi(true);
  const wOn = await world();
  check('打开后：范围外的面恢复透明（默认观感不变）', wOn.outOfScopeBlank === true, { france: wOn.france, brazil: wOn.brazil });
  check('打开后：本洲国面照常上色', wOn.inScopePainted === true, wOn.china);
  await shot('drill-scope-6-world-hidden.png');

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
