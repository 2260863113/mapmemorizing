/**
 * 本轮（UI 收尾）验收脚本：真实浏览器里跑一遍六条需求，并留下截图供目测。
 *
 *   1. 熟练度分析左下角「设置」→「隐藏地图标签」
 *   2. 熟练度分析阶梯分界线 -10 / -5 / -1 / 0 / +1 / +5 / +10（纯函数，单测覆盖；这里只截图看配色）
 *   3. 自由模式沿用「世界/省级/市级」但不支持下钻
 *   4. 全局设置可调「世界边界」
 *   5. 黑夜/白天模式按钮位于全局「设置」左侧
 *   6. 按钮为 DSH 胶囊风格；设置行文字左对齐、控件右对齐
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

  // ---------------- 需求 6：顶栏/浮层按钮为 DSH 胶囊 ----------------
  const style = JSON.parse(await ev(`JSON.stringify((function(){
    var cs = function(sel){ var e = document.querySelector(sel); if(!e) return null; var s = getComputedStyle(e); return { h: s.height, r: s.borderRadius, pad: s.padding, font: s.fontSize, border: s.borderTopWidth + ' ' + s.borderTopStyle, weight: s.fontWeight }; };
    return { settings: cs('#btn-settings'), tab: cs('#mode-tabs button'), action: cs('.mode-action'), seg: cs('.mode-segmented button'), primary: cs('#summary-restart') };
  })())`));
  const capsule = (s) => s && parseFloat(s.r) * 2 >= parseFloat(s.h) - 1;
  check('顶栏按钮为无边框胶囊（圆角=高/2）', capsule(style.settings) && style.settings.border.startsWith('0px'), style.settings);
  check('模式页签为无边框胶囊', capsule(style.tab) && style.tab.border.startsWith('0px'), style.tab);
  check('地图浮层按钮（说明/暂停等）为无边框胶囊', capsule(style.action) && style.action.border.startsWith('0px'), style.action);
  check('分段按钮内项为胶囊', capsule(style.seg), style.seg);
  check('主按钮为 36 高 / 18 圆角胶囊', style.primary && style.primary.h === '36px' && style.primary.r === '18px', style.primary);

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

  // ---------------- 需求 3：自由模式分段按钮 + 不下钻 ----------------
  await ev(`(() => { document.querySelector('#mode-tabs button[data-mode="memory"]').click(); return true })()`);
  await sleep(900);
  const browseCity = JSON.parse(await ev(`JSON.stringify((function(){
    var g = document.getElementById('granularity-toggle');
    var active = g.querySelector('button.active');
    return { visible: !g.classList.contains('hidden'), labels: Array.prototype.map.call(g.querySelectorAll('button'), function(b){return b.textContent;}), active: active && active.textContent };
  })())`));
  check('自由模式显示「世界/省级/市级」分段按钮，默认市级', browseCity.visible && browseCity.labels.join('/') === '世界/省级/市级' && browseCity.active === '市级', browseCity);
  const cityState = await ui();
  check('市级档：地级地图 + 全部地名标签', cityState.view.worldMode === false && cityState.view.provinceMode === false && cityState.labels.showAllLabels === true, { view: cityState.view, labels: cityState.labels });
  await shot('round3-5-browse-city.png');

  await ev(`(() => { document.getElementById('granularity-province').click(); return true })()`);
  await sleep(900);
  const provState = await ui();
  check('省级档：省级地图、无港澳放大框、不允许下钻、省名标签常显', provState.view.provinceMode === true && provState.view.provinceModeDrill === false && provState.view.provinceModeInset === false && provState.labels.showAllProvinceLabels === true, { view: provState.view, labels: provState.labels });
  await shot('round3-6-browse-province.png');

  await ev(`(() => { document.getElementById('granularity-world').click(); return true })()`);
  await sleep(900);
  const worldState = await ui();
  const noScopeRows = JSON.parse(await ev(`JSON.stringify({ continent: document.getElementById('continent-toggle').classList.contains('hidden'), subregion: document.getElementById('subregion-toggle').classList.contains('hidden') })`));
  check('世界档：世界地图 + 国名标签常显', worldState.view.worldMode === true && worldState.labels.worldShowAllLabels === true, { view: worldState.view, labels: worldState.labels });
  check('自由模式世界档不显示大洲/次区域行（不支持下钻）', noScopeRows.continent && noScopeRows.subregion, noScopeRows);
  await ev(`(() => { document.querySelector('#mode-tabs button[data-mode="memory"]').click(); return true })()`);
  await sleep(700);
  await shot('round3-7-browse-world.png');

  // ---------------- 需求 2：阶梯断点在配色上的表现 ----------------
  await ev(`(() => { document.getElementById('btn-free').click(); return true })()`);
  await sleep(600);
  const colors = JSON.parse(await ev(`JSON.stringify((function(){
    var m = document.querySelector('#analysis-granularity-toggle button[data-analysis-granularity="city"]');
    return { cityActive: m && m.classList.contains('active') };
  })())`));
  check('熟练度分析仍可用（地级档激活）', colors.cityActive === true, colors);
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
      // 胶囊判定：圆角 ≥ 高度一半 - 1px，或整体为小圆角列表项（<10px）
      var capsule = radius * 2 >= h - 1;
      var soft = radius <= 10;
      if (!capsule && !soft) out.notCapsule.push({ label: label, h: +h.toFixed(1), radius: radius });
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
  check('所有按钮/下拉均为胶囊（圆角 = 高/2）或列表项小圆角', audit.notCapsule.length === 0, audit.notCapsule);
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
  await shot('round3-9-settings-light.png');
  await ev(`(() => { document.getElementById('set-cancel').click(); return true })()`);
  await sleep(300);

  await ev(`(() => { document.getElementById('btn-free').click(); return true })()`);
  await sleep(800);
  await ev(`(() => { document.getElementById('btn-mode-settings').click(); return true })()`);
  await sleep(400);
  await shot('round3-10-analysis-popup-light.png');
  await ev(`(() => { document.getElementById('mode-settings-panel').classList.add('hidden'); return true })()`);

  await ev(`(() => { document.querySelector('#mode-tabs button[data-mode="memory"]').click(); return true })()`);
  await sleep(900);
  await ev(`(() => { document.getElementById('granularity-province').click(); return true })()`);
  await sleep(900);
  await shot('round3-11-browse-province-light.png');

  // ---------------- 顶栏胶囊可辨识度 + 选中页签（客观取色） ----------------
  const topbarAudit = JSON.parse(await ev(`JSON.stringify((function(){
    function parse(c){ var m=/rgba?\\(([^)]+)\\)/.exec(c); if(!m) return null; var p=m[1].split(',').map(parseFloat); return { rgb:[p[0],p[1],p[2]], a: p.length>3?p[3]:1 }; }
    function srgb(c){ c=c/255; return c<=0.03928?c/12.92:Math.pow((c+0.055)/1.055,2.4); }
    function lum(rgb){ return 0.2126*srgb(rgb[0])+0.7152*srgb(rgb[1])+0.0722*srgb(rgb[2]); }
    function over(fg,bg){ return fg.rgb.map(function(v,i){ return v*fg.a + bg[i]*(1-fg.a); }); }
    var bar = parse(getComputedStyle(document.querySelector('.topbar')).backgroundColor).rgb;
    var rest = parse(getComputedStyle(document.getElementById('btn-settings')).backgroundColor);
    var active = document.querySelector('#mode-tabs button.active');
    var act = active ? parse(getComputedStyle(active).backgroundColor) : null;
    var actText = active ? getComputedStyle(active).color : null;
    var idleText = getComputedStyle(document.querySelector('#mode-tabs button:not(.active)')).color;
    var ratio = function(a,b){ var l1=lum(a), l2=lum(b); return (Math.max(l1,l2)+0.05)/(Math.min(l1,l2)+0.05); };
    return {
      barRgb: bar,
      restPillRgb: rest.a >= 0.999 ? rest.rgb : over(rest, bar),
      activeTabText: active ? (active.textContent||'').trim() : null,
      activeFillRgb: act ? (act.a >= 0.999 ? act.rgb : over(act, bar)) : null,
      pillVsBar: +ratio(over(rest, bar), bar).toFixed(2),
      activeVsBar: act ? +ratio(over(act, bar), bar).toFixed(2) : null,
      activeVsIdleText: +ratio(parse(actText).rgb, bar).toFixed(2),
      idleTextVsBar: +ratio(parse(idleText).rgb, bar).toFixed(2)
    };
  })())`));
  check('顶栏「设置」等按钮的胶囊底与栏底色可分辨（亮度比 ≥ 1.15）', topbarAudit.pillVsBar >= 1.15, topbarAudit);
  check('模式页签有选中项，且选中底与栏底色可分辨（亮度比 ≥ 1.3）', !!topbarAudit.activeFillRgb && topbarAudit.activeVsBar >= 1.3, topbarAudit);

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
