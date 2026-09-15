/**
 * 本轮（UI 收尾）验收脚本：真实浏览器里跑一遍六条需求，并留下截图供目测。
 *
 *   1. 熟练度分析左下角「设置」→「隐藏地图标签」
 *   2. 熟练度分析阶梯分界线 -10 / -5 / -1 / 0 / +1 / +5 / +10（纯函数，单测覆盖；这里只截图看配色）
 *   3. 自由模式沿用「世界/省级/市级」但不支持下钻
 *   4. 全局设置可调「世界边界」
 *   5. 黑夜/白天模式按钮位于全局「设置」左侧
 *   6. 按钮样式已回滚为原样；只有设置界面的开关改成 DSH 设置页样式
 *      （暗主题：关=左侧白点、开=全白；明主题正好相反）
 *   7. 自由模式与熟练度分析的地图**默认显示地图标签**（含世界全景，阈值 0）
 *
 * 用法：npm run build && node scripts/verify-round3.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BROWSER = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9993;
const CDP = 9994;
const OUT = path.join(ROOT, 'docs', 'shots');
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn(process.execPath, [path.join(ROOT, 'scripts', 'static-server.mjs'), String(PORT), path.join(ROOT, 'dist')], { stdio: 'ignore' });
await sleep(1200);
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-r3-'));
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
    const f = path.join(OUT, name);
    fs.writeFileSync(f, Buffer.from(r.data, 'base64'));
    console.log('  截图', path.relative(ROOT, f));
  };

  for (let i = 0; i < 90; i++) {
    await sleep(500);
    if ((await ev('typeof window.__probe').catch(() => 'no')) === 'object') break;
  }
  const ui = () => ev('JSON.stringify(window.__probe.round3Ui())').then((s) => JSON.parse(s));

  // ---------------- 需求 5：主题按钮在设置按钮左侧 ----------------
  const order = JSON.parse(await ev(`JSON.stringify((function(){
    var theme = document.getElementById('btn-theme');
    var set = document.getElementById('btn-settings');
    var pos = theme.compareDocumentPosition(set);
    return {
      themeText: theme.textContent,
      themeExists: !!theme,
      themeBeforeSettings: !!(pos & Node.DOCUMENT_POSITION_FOLLOWING),
      sameRow: Math.abs(theme.getBoundingClientRect().top - set.getBoundingClientRect().top) < 4,
      themeLeftOfSettings: theme.getBoundingClientRect().right <= set.getBoundingClientRect().left + 1,
    };
  })())`));
  check('黑夜模式按钮存在且位于设置按钮左侧同行', order.themeExists && order.themeBeforeSettings && order.sameRow && order.themeLeftOfSettings, order);
  check('按钮初始文案为「黑夜模式」（当前是白天模式）', order.themeText === '黑夜模式', order.themeText);

  await ev(`(() => { document.getElementById('btn-theme').click(); return true })()`);
  await sleep(600);
  const dark = JSON.parse(await ev(`JSON.stringify({
    bodyDark: document.body.classList.contains('theme-dark'),
    stored: JSON.parse(localStorage.getItem('china-admin-settings-v1')||'{}').darkMode,
    label: document.getElementById('btn-theme').textContent
  })`));
  check('点击后进入黑夜模式并持久化，按钮文案改为「白天模式」', dark.bodyDark === true && dark.stored === true && dark.label === '白天模式', dark);

  // ---------------- 按钮样式已回滚（恢复原样式，不留胶囊痕迹） ----------------
  const style = JSON.parse(await ev(`JSON.stringify((function(){
    var cs = function(sel){ var e = document.querySelector(sel); if(!e) return null; var s = getComputedStyle(e); return { h: s.height, r: s.borderTopLeftRadius, pad: s.padding, font: s.fontSize, borderW: s.borderTopWidth, borderS: s.borderTopStyle, bg: s.backgroundColor, bgImage: s.backgroundImage.slice(0, 40), weight: s.fontWeight }; };
    // --accent 随主题变化（明 #10b981 / 暗 #34d399），换算成 rgb 便于比对
    var acc = getComputedStyle(document.body).getPropertyValue('--accent').trim();
    var hex = /^#([0-9a-f]{6})$/i.exec(acc);
    var accentRgb = hex ? 'rgb(' + [1,3,5].map(function(i){ return parseInt(hex[1].slice(i-1, i+1), 16); }).join(', ') + ')' : acc;
    return { accentRgb: accentRgb, settings: cs('#btn-settings'), tab: cs('#mode-tabs button'), action: cs('.mode-action'), seg: cs('.mode-segmented button'), segActive: cs('.mode-segmented button.active'), primary: cs('#summary-restart'), select: cs('#set-city-boundary-tone') };
  })())`));
  const radius8 = (s) => s && s.r === '8px';
  check('顶栏/浮层按钮恢复原有 8px 圆角与 1px 描边（不再是胶囊）', radius8(style.settings) && radius8(style.action) && style.settings.borderW === '1px' && style.action.borderW === '1px', { settings: style.settings, action: style.action });
  check('模式页签恢复原有 8px 圆角 + 1px 描边', radius8(style.tab) && style.tab.borderW === '1px', style.tab);
  check('分段按钮恢复原容器（小圆角，非胶囊组）', style.seg && parseFloat(style.seg.r) <= 10, style.seg);
  check('分段选中项恢复原深色填充（渐变，非浅色胶囊）', style.segActive && style.segActive.bgImage.indexOf('gradient') >= 0, style.segActive);
  check('主按钮恢复原绿色实心（--accent）', style.primary && style.primary.bg === style.accentRgb, { primary: style.primary?.bg, accent: style.accentRgb });
  check('下拉框恢复原有 8px 圆角描边样式', radius8(style.select) && style.select.borderW === '1px', style.select);

  // ---------------- 需求 4 + 6：全局设置面板 ----------------
  await ev(`(() => { document.getElementById('btn-settings').click(); return true })()`);
  await sleep(500);
  const rows = JSON.parse(await ev(`JSON.stringify((function(){
    var panel = document.getElementById('settings-panel');
    var out = { worldSelect: !!document.getElementById('set-world-boundary-tone'), darkToggleGone: !document.getElementById('set-dark-mode'), rows: [] };
    Array.prototype.slice.call(panel.querySelectorAll('.row')).forEach(function(row){
      var label = row.querySelector('.row-label');
      var control = row.querySelector('select, input[type=checkbox]');
      if (!label || !control) { out.rows.push({ text: (row.textContent||'').trim(), aligned: false }); return; }
      var rb = row.getBoundingClientRect(), lb = label.getBoundingClientRect(), cb = control.getBoundingClientRect();
      out.rows.push({
        text: label.textContent.trim(),
        textLeftAligned: Math.abs(lb.left - rb.left) < 2 && lb.width > rb.width / 2,
        controlRightAligned: Math.abs(cb.right - rb.right) < 2,
        controlRightOfText: cb.left >= lb.right - 1,
        control: control.tagName.toLowerCase() + (control.id ? '#' + control.id : '')
      });
    });
    return out;
  })())`));
  check('设置面板新增「世界边界」下拉', rows.worldSelect, rows.worldSelect);
  check('黑夜模式开关已从设置面板移出（改由顶栏按钮控制）', rows.darkToggleGone, rows.darkToggleGone);
  const alignOk = rows.rows.length > 0 && rows.rows.every((r) => r.textLeftAligned && r.controlRightAligned && r.controlRightOfText);
  check('设置行：文字左对齐、控件右对齐且位于文字右侧', alignOk, rows.rows);

  // ---------------- 开关：DSH 设置页样式（暗主题） ----------------
  const switchStyle = () => ev(`JSON.stringify((function(){
    var el = document.getElementById('set-ignore-tiny');
    var s = getComputedStyle(el);
    var knob = getComputedStyle(el, '::before');
    return {
      checked: el.checked,
      w: s.width, h: s.height, radius: s.borderTopLeftRadius, pad: s.padding, borderW: s.borderTopWidth,
      track: s.backgroundColor,
      knobW: knob.width, knobH: knob.height, knobRadius: knob.borderTopLeftRadius, knobBg: knob.backgroundColor, knobTransform: knob.transform
    };
  })())`).then(JSON.parse);

  const swOffDark = await switchStyle();
  check('开关几何对齐 DSH（36×20 / 圆角 10 / 2px 内边距 / 16px 圆形滑块 / 无边框）',
    swOffDark.w === '36px' && swOffDark.h === '20px' && swOffDark.radius === '10px' && swOffDark.pad === '2px'
      && swOffDark.borderW === '0px' && swOffDark.knobW === '16px' && swOffDark.knobH === '16px' && swOffDark.knobRadius === '50%',
    swOffDark);
  check('黑夜模式·关闭：轨道为半透明底、滑块在左侧且为白色',
    swOffDark.checked === false && swOffDark.track === 'rgba(255, 255, 255, 0.16)' && swOffDark.knobBg === 'rgb(249, 250, 251)',
    swOffDark);

  await ev(`(() => { document.getElementById('set-ignore-tiny').click(); return true })()`);
  await sleep(300);
  const swOnDark = await switchStyle();
  check('黑夜模式·打开：轨道转为全白、滑块右移 16px（同为白 → 视觉全白）',
    swOnDark.checked === true && swOnDark.track === 'rgb(249, 250, 251)' && swOnDark.knobBg === 'rgb(249, 250, 251)'
      && /matrix\(1,\s*0,\s*0,\s*1,\s*16,\s*0\)/.test(swOnDark.knobTransform),
    swOnDark);
  await ev(`(() => { document.getElementById('set-ignore-tiny').click(); return true })()`); // 还原为关闭
  await sleep(250);
  await shot('round3-1-settings-dark.png');

  // 改世界边界 → 保存 → 渲染器生效
  await ev(`(() => { document.getElementById('set-world-boundary-tone').value = 'dark'; document.getElementById('set-save').click(); return true })()`);
  await sleep(600);
  const world = await ui();
  const storedWorld = await ev(`JSON.parse(localStorage.getItem('china-admin-settings-v1')||'{}').worldBoundaryTone`);
  check('保存后世界边界深浅写入设置并作用到渲染器', world.boundaries.world === 'dark' && storedWorld === 'dark', { renderer: world.boundaries, stored: storedWorld });
  // 还原为中间灰，避免影响后续截图
  await ev(`(() => { localStorage.setItem('china-admin-settings-v1', JSON.stringify(Object.assign(JSON.parse(localStorage.getItem('china-admin-settings-v1')||'{}'), { worldBoundaryTone: 'mid' }))); return true })()`);

  // ---------------- 需求 1：熟练度分析左下角设置 ----------------
  await ev(`(() => { document.getElementById('btn-free').click(); return true })()`);
  await sleep(900);
  const analysisBtn = JSON.parse(await ev(`JSON.stringify((function(){
    var b = document.getElementById('btn-mode-settings');
    var info = document.getElementById('mode-info');
    var rb = b.getBoundingClientRect();
    return { visible: !b.classList.contains('hidden'), text: b.textContent, inLowerLeft: rb.left < 200 && rb.bottom > window.innerHeight - 160 };
  })())`));
  check('熟练度分析左下角出现「设置」按钮', analysisBtn.visible && analysisBtn.inLowerLeft, analysisBtn);
  const analysisCity = await ui();
  check('熟练度分析·地级档：默认即显示地名标签（阈值 0，全景也画标签）',
    analysisCity.labels?.hideLabels === false && analysisCity.labels?.showAllLabels === true
      && analysisCity.labels?.labelZoomThreshold === 0 && analysisCity.labelCounts.city >= 300,
    { labels: analysisCity.labels, counts: analysisCity.labelCounts, zoom: analysisCity.zoom });
  await shot('round3-2-analysis-city.png');

  await ev(`(() => { document.getElementById('btn-mode-settings').click(); return true })()`);
  await sleep(400);
  const panel = JSON.parse(await ev(`JSON.stringify((function(){
    var el = document.getElementById('mode-settings-panel');
    var row = el.querySelector('.mode-setting-toggle');
    var label = row && row.querySelector('.row-label');
    var input = row && row.querySelector('input[type=checkbox]');
    var rb = row.getBoundingClientRect(), lb = label.getBoundingClientRect(), cb = input.getBoundingClientRect();
    return {
      title: (el.querySelector('h3')||{}).textContent,
      toggleLabel: label && label.textContent.trim(),
      textLeftAligned: Math.abs(lb.left - rb.left) < 2,
      controlRightAligned: Math.abs(cb.right - rb.right) < 2,
      controlRightOfText: cb.left >= lb.right - 1,
    };
  })())`));
  check('设置浮层含「隐藏地图标签」开关，且文字左对齐、开关右对齐', panel.toggleLabel === '隐藏地图标签' && panel.textLeftAligned && panel.controlRightAligned && panel.controlRightOfText, panel);
  await shot('round3-3-analysis-mode-settings.png');

  await ev(`(() => { document.querySelector('#mode-settings-panel input[type=checkbox][data-key="hide-labels"]').click(); return true })()`);
  await sleep(600);
  const hidden = await ui();
  check('打开「隐藏地图标签」后渲染状态 hideLabels=true、地级标签关闭', hidden.labels?.hideLabels === true && hidden.labels?.showAllLabels === false, hidden.labels);
  await shot('round3-4-analysis-labels-hidden.png');
  await ev(`(() => { document.querySelector('#mode-settings-panel input[type=checkbox][data-key="hide-labels"]').click(); return true })()`);
  await sleep(400);
  const shown = await ui();
  check('关闭后恢复显示标签', shown.labels?.hideLabels === false && shown.labels?.showAllLabels === true, shown.labels);
  await ev(`(() => { document.getElementById('mode-settings-panel').classList.add('hidden'); return true })()`);

  // ---------------- 需求 3（2026-09）：自由模式下线，浏览标签并入前四个模式 ----------------
  // 口径：未开始显示全量地名（阈值 0）、开始后清空（已作答绿/红保留）、结束（结算/重置）后复现。
  const tabs = JSON.parse(await ev(`JSON.stringify(Array.prototype.map.call(document.querySelectorAll('#mode-tabs button'), function(b){ return b.textContent; }))`));
  check('模式标签页只剩四个（自由模式已下线）', tabs.join('/') === '点击模式/输入模式/拼图模式/无尽闯关', tabs);

  await ev(`(() => { document.querySelector('#mode-tabs button[data-mode="click"]').click(); return true })()`);
  await sleep(700);
  await ev(`(() => { document.getElementById('granularity-city').click(); return true })()`);
  await sleep(900);
  const browseCity = await ui();
  check('点击模式·市级未开始：全部地名标签显示（阈值 0，全景也画标签）',
    browseCity.labels.showAllLabels === true && browseCity.labels.labelZoomThreshold === 0 && browseCity.labelCounts.city >= 300,
    { labels: browseCity.labels, counts: browseCity.labelCounts, zoom: browseCity.zoom });
  await shot('round3-5-browse-city.png');

  await ev(`(() => { document.getElementById('granularity-province').click(); return true })()`);
  await sleep(900);
  const browseProv = await ui();
  check('点击模式·省级全国未开始：省名标签全量显示（省级地图且不支持下钻）',
    browseProv.view.provinceMode === true && browseProv.labels.showAllProvinceLabels === true && browseProv.labelCounts.province >= 30,
    { view: browseProv.view, labels: browseProv.labels, counts: browseProv.labelCounts });
  await shot('round3-6-browse-province.png');

  await ev(`(() => { document.getElementById('granularity-world').click(); return true })()`);
  await sleep(900);
  const browseWorld = await ui();
  check('点击模式·世界档未开始：国名标签全量显示（阈值 0）',
    browseWorld.view.worldMode === true && browseWorld.labels.worldShowAllLabels === true
      && browseWorld.labels.worldLabelZoomThreshold === 0 && browseWorld.labelCounts.world >= 190,
    { view: browseWorld.view, labels: browseWorld.labels, counts: browseWorld.labelCounts });
  await shot('round3-7-browse-world.png');

  // 回到省级全国：开始答题 → 全量标签清空；已作答的绿/红标签必须保留
  await ev(`(() => { document.getElementById('granularity-province').click(); return true })()`);
  await sleep(900);
  await ev(`(() => { document.getElementById('click-start').click(); return true })()`);
  await sleep(800);
  const afterStart = await ui();
  check('开始答题后全量标签清空（省级全国不再常显省名）',
    afterStart.labels.showAllProvinceLabels === false && afterStart.labels.showAllLabels === false,
    afterStart.labels);
  await ev(`window.__probe.answerCurrent()`);
  await sleep(600);
  const answered = await ui();
  const answeredTexts = JSON.parse(await ev(`JSON.stringify(window.__probe.namingTexts().provinceLabels)`));
  check('已作答单位的绿/红标签保留（答题反馈不退化）',
    answered.labelCounts.province === 1 && answeredTexts.length === 1, { counts: answered.labelCounts, texts: answeredTexts });

  // 重置（第一次点击是二次确认）→ 省级全国进行中会弹结算卡片 → 卡片出现即算「已结束」→ 标签复现
  await ev(`(() => { document.getElementById('btn-reset').click(); return true })()`);
  await sleep(200);
  await ev(`(() => { document.getElementById('btn-reset').click(); return true })()`);
  await sleep(900);
  const settled = JSON.parse(await ev(`JSON.stringify({
    cardOpen: !document.getElementById('settlement').classList.contains('hidden'),
    labels: window.__probe.round3Ui().labels
  })`));
  check('结算卡片弹出即复现全量标签', settled.cardOpen === true && settled.labels.showAllProvinceLabels === true, settled);
  // 结算卡片「提交成绩」按钮：白字灰底（2026-09 用户口径）。绿底白字只有 1.92:1，故这里直接量对比度。
  // 灰值按主题不同（明 rgb(55,65,81) / 暗 rgb(71,85,105)），故与 CSS 令牌比对而不是写死颜色。
  const settleBtn = JSON.parse(await ev(`JSON.stringify((function(){
    function srgb(c){ c = c/255; return c <= 0.03928 ? c/12.92 : Math.pow((c+0.055)/1.055, 2.4); }
    function lum(rgb){ var m = rgb.match(/\\d+/g).map(Number); return 0.2126*srgb(m[0]) + 0.7152*srgb(m[1]) + 0.0722*srgb(m[2]); }
    var b = document.getElementById('settlement-submit'), s = getComputedStyle(b);
    // 令牌从**元素自身**读：明主题定义在 :root、暗主题在 body.theme-dark，读 documentElement 只会拿到明主题值
    var token = s.getPropertyValue('--control-active-bg').trim();
    var l1 = lum(s.color), l2 = lum(s.backgroundColor);
    var ratio = (Math.max(l1,l2) + 0.05) / (Math.min(l1,l2) + 0.05);
    return { text: s.color, bg: s.backgroundColor, token: token, bgImage: s.backgroundImage, ratio: Math.round(ratio*100)/100 };
  })())`));
  check('结算卡片「提交成绩」：白字灰底（= --control-active-bg，与分段按钮选中态同色）且对比度 ≥ 3.5:1',
    settleBtn.text === 'rgb(255, 255, 255)' && settleBtn.bg === settleBtn.token && settleBtn.ratio >= 3.5,
    settleBtn);
  await ev(`(() => { document.getElementById('settlement-close').click(); return true })()`);
  await sleep(800);
  const afterReset = await ui();
  check('关闭结算卡片（= 重置回开始状态）后标签仍在', afterReset.labels.showAllProvinceLabels === true, afterReset.labels);

  // 无尽闯关未开始：显示地名（不再是空白地图 + 价格）
  await ev(`(() => { document.querySelector('#mode-tabs button[data-mode="endless"]').click(); return true })()`);
  await sleep(1000);
  const endlessPre = await ui();
  check('无尽闯关未开始：显示全部地级市名（自由模式并入后的口径）',
    endlessPre.labels?.showAllLabels === true && endlessPre.labels?.labelZoomThreshold === 0 && endlessPre.labelCounts.city >= 300,
    { labels: endlessPre.labels, counts: endlessPre.labelCounts });

  // 全局开关关掉 → 未开始也不显示；再打开 → 复现
  const setBrowseLabels = async (on) => {
    await ev(`(() => { document.getElementById('btn-settings').click(); return true })()`);
    await sleep(400);
    await ev(`(() => {
      var cb = document.getElementById('set-show-browse-labels');
      if (cb.checked !== ${on}) cb.click();
      document.getElementById('set-save').click();
      return true;
    })()`);
    await sleep(800);
  };
  await setBrowseLabels(false);
  const switchOff = await ui();
  check('关掉全局「未开始时显示地图标签」后，未开始也不显示地名',
    switchOff.labels?.showAllLabels === false, switchOff.labels);
  await setBrowseLabels(true);
  const switchOn = await ui();
  check('重新打开该开关后标签复现', switchOn.labels?.showAllLabels === true, switchOn.labels);

  // ---------------- 未开始的按钮纵向布局（2026-09 用户口径）----------------
  // 顺序：… → 大洲 → 次区域 → 世界/省级/市级 → 重置；重置独占最后一行、与大洲/粒度行左对齐。
  const layout = async () => JSON.parse(await ev(`JSON.stringify((function(){
    function r(id){ var el = document.getElementById(id); if (!el) return null;
      var cs = getComputedStyle(el); var b = el.getBoundingClientRect();
      return { hidden: el.classList.contains('hidden') || cs.display === 'none' || b.width < 2,
               x: Math.round(b.left), y: Math.round(b.top), bottom: Math.round(b.bottom) }; }
    return { continent: r('continent-toggle'), subregion: r('subregion-toggle'),
             granularity: r('granularity-toggle'), reset: r('btn-reset'),
             skip: r('btn-skip'), end: r('btn-end'),
             granularityBreak: r('granularity-break'), resetBreak: r('reset-break') };
  })())`));

  await ev(`(() => { document.querySelector('#mode-tabs button[data-mode="click"]').click(); return true })()`);
  await sleep(700);
  await ev(`(() => { document.getElementById('granularity-world').click(); return true })()`);
  await sleep(700);
  await ev(`(() => { document.getElementById('continent-AS').click(); return true })()`);
  await sleep(1000);
  const L1 = await layout();
  check('未开始·世界档：纵向顺序为 大洲 → 次区域 → 世界/省级/市级 → 重置（各行严格递降）',
    !L1.continent.hidden && !L1.subregion.hidden && !L1.granularity.hidden && !L1.reset.hidden
      && L1.continent.bottom <= L1.subregion.y && L1.subregion.bottom <= L1.granularity.y
      && L1.granularity.bottom <= L1.reset.y,
    L1);
  check('未开始：重置独占最后一行，且与大洲/粒度行左对齐',
    Math.abs(L1.reset.x - L1.granularity.x) < 2 && Math.abs(L1.granularity.x - L1.continent.x) < 2,
    { resetX: L1.reset.x, granularityX: L1.granularity.x, continentX: L1.continent.x });

  await ev(`(() => { document.getElementById('granularity-city').click(); return true })()`);
  await sleep(1000);
  const L2 = await layout();
  check('未开始·市级档（无下钻行）：粒度行仍在重置上面、两行都左对齐',
    !L2.granularity.hidden && !L2.reset.hidden && L2.granularity.bottom <= L2.reset.y
      && Math.abs(L2.granularity.x - L2.reset.x) < 2,
    L2);
  check('未开始·市级档：下钻行与其换行占位都收起（不留空行）',
    L2.continent.hidden === true && L2.subregion.hidden === true, { continent: L2.continent, subregion: L2.subregion });

  // 开始答题后：布局一字不变（跳过·暂停·重置 同一行），两个新占位收起
  await ev(`(() => { document.getElementById('granularity-province').click(); return true })()`);
  await sleep(900);
  await ev(`(() => { document.getElementById('click-start').click(); return true })()`);
  await sleep(900);
  const L3 = await layout();
  check('开始后：跳过·暂停·重置 回到同一行、顺序不变（开始后的布局一字未改）',
    L3.skip.hidden === false && L3.end.hidden === false && L3.reset.hidden === false
      && L3.skip.y === L3.end.y && L3.end.y === L3.reset.y
      && L3.skip.x < L3.end.x && L3.end.x < L3.reset.x,
    L3);
  check('开始后：两个换行占位收起', L3.granularityBreak.hidden === true && L3.resetBreak.hidden === true,
    { granularityBreak: L3.granularityBreak, resetBreak: L3.resetBreak });

  // 复位：重置回开始状态（二次确认）并收掉可能弹出的结算卡片，免得影响后续检查
  await ev(`(() => { document.getElementById('btn-reset').click(); return true })()`);
  await sleep(250);
  await ev(`(() => { document.getElementById('btn-reset').click(); return true })()`);
  await sleep(700);
  await ev(`(() => { var c = document.getElementById('settlement-close'); if (c) c.click(); return true })()`);
  await sleep(600);
  const L4 = await layout();
  check('重置回开始状态后：布局回到「粒度行 → 重置」两行',
    L4.granularity.bottom <= L4.reset.y && Math.abs(L4.granularity.x - L4.reset.x) < 2, L4);

  // ---------------- 需求 4（2026-09）：游客点右上角直接进登录界面 ----------------
  await ev(`(() => { document.getElementById('user-center').click(); return true })()`);
  await sleep(500);
  const guestLogin = JSON.parse(await ev(`JSON.stringify({
    overlayOpen: !document.getElementById('auth-panel').classList.contains('hidden'),
    hasLoginForm: !!document.getElementById('auth-login-name') && !!document.getElementById('auth-login-submit')
  })`));
  check('游客点右上角直接打开登录界面（不再是"菜单里全是禁用项"）', guestLogin.overlayOpen === true && guestLogin.hasLoginForm === true, guestLogin);
  await ev(`(() => { document.getElementById('auth-cancel').click(); return true })()`);
  await sleep(300);

  // ---------------- 需求 5（2026-09）：未登录写留言被拦下，但草稿不丢 ----------------
  // 静态服务器没有 /api，故先把 board 接口打桩，让留言板能渲染出输入框
  await ev(`(() => {
    var real = window.fetch.bind(window);
    window.fetch = function (u, o) {
      if (String(u).indexOf('/api/board') === 0 || String(u).indexOf('/api/board') > -1) {
        return Promise.resolve(new Response(JSON.stringify({ posts: [] }), { status: 200, headers: { 'content-type': 'application/json' } }));
      }
      return real(u, o);
    };
    return true;
  })()`);
  await ev(`(() => { document.getElementById('btn-board').click(); return true })()`);
  await sleep(900);
  await ev(`(() => {
    var ta = document.getElementById('board-new-content');
    ta.value = '验收草稿';
    ta.dispatchEvent(new Event('input'));
    return true;
  })()`);
  await ev(`(() => { document.getElementById('board-new-submit').click(); return true })()`);
  await sleep(600);
  const draft = JSON.parse(await ev(`JSON.stringify({
    overlayOpen: !document.getElementById('auth-panel').classList.contains('hidden'),
    stored: localStorage.getItem('china-admin-board-draft-v1')
  })`));
  check('未登录发帖：弹出登录界面，且草稿已落本地（登录后自动发布、放弃登录也不丢）',
    draft.overlayOpen === true && draft.stored === '验收草稿', draft);
  await ev(`(() => { document.getElementById('auth-cancel').click(); return true })()`);
  await sleep(300);
  await ev(`(() => { document.querySelector('#mode-tabs button[data-mode="click"]').click(); return true })()`);
  await sleep(600);

  // ---------------- 需求 2：阶梯断点 + 分析模式世界档标签默认显示 ----------------
  await ev(`(() => { document.getElementById('btn-free').click(); return true })()`);
  await sleep(600);
  const colors = JSON.parse(await ev(`JSON.stringify((function(){
    var m = document.querySelector('#analysis-granularity-toggle button[data-analysis-granularity="city"]');
    return { cityActive: m && m.classList.contains('active') };
  })())`));
  check('熟练度分析仍可用（地级档激活）', colors.cityActive === true, colors);
  await ev(`(() => { document.getElementById('analysis-granularity-world').click(); return true })()`);
  await sleep(900);
  const analysisWorld = await ui();
  check('熟练度分析·世界档：国名标签默认显示（阈值 0，全景也画国名）',
    analysisWorld.labels?.worldShowAllLabels === true && analysisWorld.labels?.worldLabelZoomThreshold === 0
      && analysisWorld.labelCounts.world >= 190,
    { labels: analysisWorld.labels, counts: analysisWorld.labelCounts, zoom: analysisWorld.zoom });
  await ev(`(() => { document.getElementById('analysis-granularity-city').click(); return true })()`);
  await sleep(700);
  await ev(`(() => { document.getElementById('btn-free').click(); return true })()`);
  await sleep(500);
  await shot('round3-8-analysis-after.png');

  // ---------------- 客观视觉体检：胶囊形状 / 对比度 / 裁切 / 重叠 ----------------
  await ev(`(() => { document.getElementById('btn-free').click(); return true })()`);
  await sleep(700);
  const audit = JSON.parse(await ev(`JSON.stringify((function(){
    function srgb(c){ c = c/255; return c <= 0.03928 ? c/12.92 : Math.pow((c+0.055)/1.055, 2.4); }
    function lum(rgb){ return 0.2126*srgb(rgb[0]) + 0.7152*srgb(rgb[1]) + 0.0722*srgb(rgb[2]); }
    function parse(c){
      var m = /rgba?\\(([^)]+)\\)/.exec(c); if(!m) return null;
      var p = m[1].split(',').map(function(x){ return parseFloat(x); });
      return { rgb: [p[0],p[1],p[2]], a: p.length > 3 ? p[3] : 1 };
    }
    // 半透明底色按「叠在给定背景之上」近似合成
    function over(fg, bg){ return { rgb: fg.rgb.map(function(v,i){ return v*fg.a + bg[i]*(1-fg.a); }), a: 1 }; }
    function pageBg(){
      var b = getComputedStyle(document.body).backgroundColor;
      var p = parse(b);
      return p && p.a > 0 ? p.rgb : [255,255,255];
    }
    function ratio(textColor, bgColor){
      var l1 = lum(textColor), l2 = lum(bgColor);
      var hi = Math.max(l1,l2), lo = Math.min(l1,l2);
      return (hi + 0.05) / (lo + 0.05);
    }
    var bg = pageBg();
    var vw = window.innerWidth, vh = window.innerHeight;
    var out = { notCapsule: [], lowContrast: [], clipped: [], rows: [] };
    Array.prototype.slice.call(document.querySelectorAll('button, select')).forEach(function(el){
      var s = getComputedStyle(el);
      var r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2 || s.display === 'none' || s.visibility === 'hidden') return;
      var label = (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ').join('.') : '') + '[' + (el.textContent||'').trim().slice(0,10) + ']';
      var radius = parseFloat(s.borderTopLeftRadius) || 0;
      var h = r.height;
      // 回滚后按钮应为小圆角（≤10px）；大圆角（胶囊）视为残留
      var soft = radius <= 10;
      if (!soft) out.notCapsule.push({ label: label, h: +h.toFixed(1), radius: radius });
      // 对比度：文字色 vs 自身底色（半透明则叠到页面底色上）；无文字元素（如拖动把手）跳过
      var t = parse(s.color), b = parse(s.backgroundColor);
      var hasText = (el.textContent || '').trim().length > 0;
      if (hasText && t && b && t.a > 0.3) {
        var effBg = b.a >= 0.999 ? b.rgb : over(b, bg).rgb;
        var cr = ratio(t.rgb, effBg);
        if (cr < 3.5) out.lowContrast.push({ label: label, ratio: +cr.toFixed(2), color: s.color, bg: s.backgroundColor });
      }
      if (r.left < -0.5 || r.top < -0.5 || r.right > vw + 0.5 || r.bottom > vh + 0.5) {
        out.clipped.push({ label: label, rect: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)], viewport: [vw, vh] });
      }
    });
    // 左下信息区与底部提示/缩放条是否重叠
    var info = document.getElementById('mode-info').getBoundingClientRect();
    var hint = document.getElementById('mode-hint');
    var hr = hint.classList.contains('hidden') ? null : hint.getBoundingClientRect();
    out.modeInfo = { rect: [Math.round(info.left), Math.round(info.top), Math.round(info.right), Math.round(info.bottom)], insideViewport: info.left >= 0 && info.top >= 0 && info.right <= vw && info.bottom <= vh };
    out.modeHintOverlap = hr ? !(hr.bottom <= info.top || hr.top >= info.bottom || hr.right <= info.left || hr.left >= info.right) : null;
    out.progressBarVisible = !document.getElementById('mode-progress').classList.contains('hidden') && document.getElementById('mode-progress').getBoundingClientRect().height > 0;
    return out;
  })())`));
  check('按钮圆角均不超过 10px（无胶囊残留）', audit.notCapsule.length === 0, audit.notCapsule);
  check('按钮文字对比度均 ≥ 3.5:1（无看不清的按钮）', audit.lowContrast.length === 0, audit.lowContrast);
  check('没有按钮被视口裁切', audit.clipped.length === 0, audit.clipped);
  check('左下信息区完整落在视口内', audit.modeInfo.insideViewport, audit.modeInfo);
  check('左下信息区与底部提示不重叠', audit.modeHintOverlap !== true, { overlap: audit.modeHintOverlap });
  check('未开测时进度条不显示', audit.progressBarVisible === false, audit.progressBarVisible);

  // ---------------- 明主题复查：同一套胶囊在浅底上的表现 ----------------
  await ev(`(() => { document.getElementById('btn-theme').click(); return true })()`); // 切回白天模式
  await sleep(700);
  const lightTheme = JSON.parse(await ev(`JSON.stringify({
    bodyDark: document.body.classList.contains('theme-dark'),
    stored: JSON.parse(localStorage.getItem('china-admin-settings-v1')||'{}').darkMode,
    label: document.getElementById('btn-theme').textContent
  })`));
  check('再次点击切回白天模式并持久化，文案回到「黑夜模式」', lightTheme.bodyDark === false && lightTheme.stored === false && lightTheme.label === '黑夜模式', lightTheme);

  await ev(`(() => { document.getElementById('btn-settings').click(); return true })()`);
  await sleep(500);
  const swOffLight = await switchStyle();
  check('白天模式·关闭：轨道为浅灰透明底、滑块在左侧且为深灰（2026-09 起不再纯黑）',
    swOffLight.checked === false && swOffLight.track === 'rgba(0, 0, 0, 0.12)' && swOffLight.knobBg === 'rgb(55, 65, 81)',
    swOffLight);
  await ev(`(() => { document.getElementById('set-ignore-tiny').click(); return true })()`);
  await sleep(300);
  const swOnLight = await switchStyle();
  check('白天模式·打开：轨道转为深灰（与分段按钮选中态同色）、滑块右移 16px',
    swOnLight.checked === true && swOnLight.track === 'rgb(55, 65, 81)' && swOnLight.knobBg === 'rgb(55, 65, 81)'
      && /matrix\(1,\s*0,\s*0,\s*1,\s*16,\s*0\)/.test(swOnLight.knobTransform),
    swOnLight);
  await ev(`(() => { document.getElementById('set-ignore-tiny').click(); return true })()`); // 还原为关闭
  await sleep(250);
  await shot('round3-9-settings-light.png');
  await ev(`(() => { document.getElementById('set-cancel').click(); return true })()`);
  await sleep(300);

  await ev(`(() => { document.getElementById('btn-free').click(); return true })()`);
  await sleep(800);
  await ev(`(() => { document.getElementById('btn-mode-settings').click(); return true })()`);
  await sleep(400);
  await shot('round3-10-analysis-popup-light.png');
  await ev(`(() => { document.getElementById('mode-settings-panel').classList.add('hidden'); return true })()`);

  // 白天模式下的浏览标签截图（原「自由模式」已并入点击模式）
  await ev(`(() => { document.querySelector('#mode-tabs button[data-mode="click"]').click(); return true })()`);
  await sleep(900);
  await ev(`(() => { document.getElementById('granularity-province').click(); return true })()`);
  await sleep(900);
  await shot('round3-11-browse-province-light.png');

  // ---------------- 回滚自检：顶栏/浮层按钮不再是胶囊 ----------------
  const rollback = JSON.parse(await ev(`JSON.stringify((function(){
    var radii = [];
    Array.prototype.slice.call(document.querySelectorAll('#mode-tabs button, .top-actions button, .mode-action, .mode-segmented button')).forEach(function(el){
      var s = getComputedStyle(el), r = el.getBoundingClientRect();
      if (r.width < 2 || s.display === 'none') return;
      radii.push({ text: (el.textContent||'').trim().slice(0,8), radius: s.borderTopLeftRadius });
    });
    return {
      count: radii.length,
      maxRadius: radii.reduce(function(m, x){ return Math.max(m, parseFloat(x.radius) || 0); }, 0),
      sample: radii.slice(0, 4)
    };
  })())`));
  check('顶栏与浮层按钮圆角全部 ≤ 10px（胶囊样式已回滚）', rollback.maxRadius <= 10, rollback);

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
