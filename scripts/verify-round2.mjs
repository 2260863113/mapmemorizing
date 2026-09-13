/**
 * 运行时验收探针（headless Edge + CDP）。
 *
 * 验收项（本轮六条需求的运行时部分）：
 *   1. 世界下钻后，空白区域悬停不高亮、点击不下钻（空白区无交互）
 *   2. 梵蒂冈不在答题池内
 *   3. 「忽略面积极小的国家」开启后，极小国家不出题且不可交互
 *   4. 错误回滚：红显时长 1.5s，且**每次**答错都标红
 *   5. 世界输入模式自动跟随：缩放与国家面积成反比
 *   6. 所有模式答错后镜头平移到正确答案位置且缩放不变
 *
 * 用 Edge 而不是 Chrome：本机 Chrome 是 38（2014），不支持 ES module，
 * 页面主 bundle 根本不会执行。Edge 是 152，与线上用户环境一致。
 *
 * 用法：node scripts/probe-round2.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BROWSER = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const DIST = path.join(ROOT, 'dist');
const PORT = 9971;
const CDP = 9972;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} | ${name}${detail ? ' | ' + detail : ''}`);
}

const server = spawn(process.execPath, [path.join(ROOT, 'scripts', 'static-server.mjs'), String(PORT), DIST], { stdio: 'ignore' });
await sleep(1200);
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-r2-'));
const browser = spawn(
  BROWSER,
  ['--headless=new', '--disable-gpu', '--no-first-run', `--user-data-dir=${userDir}`, `--remote-debugging-port=${CDP}`, '--window-size=1280,900', 'about:blank'],
  { stdio: 'ignore' },
);

let ws;
let msgId = 0;
const pending = new Map();
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

try {
  let target = null;
  for (let i = 0; i < 60; i++) {
    await sleep(400);
    try {
      const list = await fetch(`http://127.0.0.1:${CDP}/json/list`).then((r) => r.json());
      target = list.find((t) => t.type === 'page');
      if (target?.webSocketDebuggerUrl) break;
    } catch {
      /* 还没起来 */
    }
  }
  if (!target) throw new Error('CDP 目标未就绪');

  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', rej);
  });
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) p.reject(new Error(JSON.stringify(m.error)));
      else p.resolve(m.result);
    }
  });
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?probe=1` });

  // 等探针就绪（1.2MB JS + 650KB 拓扑数据，冷启动偏慢）
  let readyStage = '';
  let ready = false;
  for (let i = 0; i < 90; i++) {
    await sleep(500);
    try {
      const r = await send('Runtime.evaluate', {
        expression: 'JSON.stringify({p: typeof window.__probe, c: document.querySelectorAll("canvas").length})',
        returnByValue: true,
      });
      const v = JSON.parse(r.result.value);
      readyStage = `probe=${v.p} canvas=${v.c}`;
      if (v.p === 'object') {
        ready = true;
        break;
      }
    } catch {
      /* 页面还没建好执行上下文 */
    }
  }
  if (!ready) throw new Error(`探针未就绪（${readyStage}）`);

  async function evaluate(expr) {
    const r = await send('Runtime.evaluate', { expression: `(async () => (${expr}))()`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'eval failed');
    return r.result.value;
  }

  console.log('\n=== 1. 空白区域无交互（世界下钻到亚洲后）===');
  const blank = await evaluate('window.__probe.blankSpaceInert()');
  check('其他洲的面不可交互（空白区无交互）', blank.otherContinentInert === true, JSON.stringify(blank));
  check('空白处命中不会解析出可见国家', blank.blankResolvesToVisibleCountry === false);
  check('范围内国家仍可交互（未误伤）', blank.inScopeInteractive === true, `${blank.asianName} 可交互`);

  // 渲染层：范围外的面必须真的「画都没画」——只验事件层不够，
  // 若它们回落到 geo 默认样式仍会被画成有颜色的国家轮廓（正是用户看到的症状）。
  const rr = await evaluate('window.__probe.renderedRegions()');
  check('渲染层：范围外国家面为 silent + 透明（既不画也不响应）', rr.outOfScopeBlank === true, JSON.stringify({ france: rr.france, brazil: rr.brazil }));
  check('渲染层：范围内国家面正常上色', rr.inScopePainted === true, `中国 ${rr.china.areaColor}`);

  console.log('\n=== 2. 梵蒂冈已移出答题池 ===');
  const vat = await evaluate('window.__probe.vatican()');
  check('国家池不含 VAT', vat.inPool === false);
  check('国家池为 194', vat.count === 194, `count=${vat.count}`);
  check('VAT 面仍作为灰色装饰面存在（填住意大利的空洞）', vat.faceExists === true && vat.faceIsDecorative === true);

  console.log('\n=== 3. 忽略面积极小的国家 ===');
  const tiny = await evaluate('window.__probe.tinyCountries()');
  check('清单为 6 国且不含梵蒂冈', tiny.list.length === 6 && !tiny.list.includes('VAT'), tiny.list.join(','));
  const on = await evaluate('window.__probe.toggleTiny(true)');
  check('开启后池子 194 → 188', on.poolBefore === 194 && on.poolAfter === 188, `${on.poolBefore}→${on.poolAfter}`);
  check('开启后极小国家不可交互', on.inert === true, on.mcoName);
  const off = await evaluate('window.__probe.toggleTiny(false)');
  check('关闭后恢复 194', off.poolAfter === 194, `${off.poolAfter}`);

  console.log('\n=== 4. 错误回滚：每次标红 + 1.5s ===');
  const rb = await evaluate('window.__probe.rollback()');
  check('红显时长为 1500ms', rb.delayMs === 1500, `delayMs=${rb.delayMs}`);
  check('第一次答错标红', rb.firstWrongRed === true);
  check('红显到时间后被清掉（是临时高亮）', rb.redClearedAfterTimer === true);
  check('回滚后题目被恢复，可重新作答', rb.questionRestored === true);
  check('第二次答错同样标红（不再只有第一次）', rb.secondWrongRed === true);
  check('永久进度只记一次（重答不再重复计入 fail）', rb.permanentCountedOnce === true, `fail ${rb.failAfterFirst} → ${rb.failAfterSecond}`);

  console.log('\n=== 5. 世界自动跟随：缩放与国家面积成反比 ===');
  const zoom = await evaluate('window.__probe.worldFollowZoom()');
  const fmt = (o) => Object.entries(o).map(([k, v]) => `${k}=${v.zoom.toFixed(2)}x(目标${v.want})`).join(' ');
  check('命中用户标定的三档锚点（立陶宛 11x / 法国 8x / 俄罗斯 3x）', zoom.anchorsHit === true, fmt(zoom.anchors));
  check('缩放落在设计区间 [3, 28]', zoom.small <= 28.0001 && zoom.big >= 2.9999, `${zoom.small.toFixed(2)} / ${zoom.big.toFixed(2)}`);
  check('全池单调不增（面积↑ ⇒ 缩放↓）', zoom.monotonic === true, `${zoom.countries} 国`);
  check('最大国最小倍率、最小国最大倍率', zoom.big <= 3.0001 && zoom.maxZoom < 28, `池内最大 ${zoom.maxZoom.toFixed(2)}x`);

  // 集成：真的调 renderer，证明「输入模式 ask() 走的那条路径」能驱动相机
  // 注：跟随钳制（2026-09）之后，贴着取景边界的目标不再被顶到正中，
  //     故断言从「落点误差 <1.5°」改为「目标仍在视口内 + 内容不越出边界（边距允许的例外除外）」。
  const af = await evaluate('window.__probe.worldAutoFollow()');
  check('集成：跟随落点合法（目标仍在视口内、内容不越出取景边界）', af.cameraMovedOnEach === true, `sgp=${af.sgpLanded.toFixed(2)}° chn=${af.chnLanded.toFixed(2)}° rus=${af.rusLanded.toFixed(2)}°（俄罗斯被钳制=${af.rusClamped}）`);
  check('集成：三个样例的目标都还在视口内', af.eachInside === true);
  check('集成：三个样例内容都未越出取景边界（边距 m 之内）', af.eachOverrunOk === true);
  check('集成：缩放随面积反比（新>中>俄）', af.inverse === true, `sgp=${af.sgpZoom.toFixed(2)} chn=${af.chnZoom.toFixed(2)} rus=${af.rusZoom.toFixed(2)}`);
  check('集成：三档缩放都在设计区间内', af.allInRange === true);

  console.log('\n=== 6. 答错后镜头平移到正确答案且缩放不变 ===');
  const pan = await evaluate('window.__probe.panOnWrong()');
  check('镜头中心已移动', pan.moved === true, `${pan.fromCenter} → ${pan.toCenter}`);
  check('缩放保持不变', Math.abs(pan.zoomFrom - pan.zoomTo) < 1e-6, `${pan.zoomFrom} → ${pan.zoomTo}`);
  check('平移后正确答案在视口内（被钳制时不再要求正中）', pan.ausVisible === true, `锚点 ${pan.ausAnchor} vs 镜头 ${pan.toCenter}`);
  check('目标已舒适可见时，答错跟随不再移动镜头', pan.stayedStill === true);

  console.log('\n=== 7. 顺序模式出题不越界（下钻后不出范围外国家）===');
  const scope = await evaluate('window.__probe.seqScopeRespected()');
  check('出的每一题都在当前地图范围内（亚洲）', scope.outOfScopeCount === 0, `越界 ${scope.outOfScopeCount} 题 ${scope.outOfScopeSample.join(',')}`);
  check('出的每一题都属于当前大洲', scope.wrongContinentCount === 0, `错洲 ${scope.wrongContinentCount} 题 ${scope.wrongContinentSample.join(',')}`);
  check('无重复出题且跑满全池', scope.duplicates === 0 && scope.coveredAll === true, `${scope.askedCount}/${scope.poolSize} 题，重复 ${scope.duplicates}`);

  console.log('\n=== 8. 开始测验收起排行榜、结束展开 ===');
  const lb = await evaluate('window.__probe.leaderboardAutoToggle()');
  check('测验确实开始了（基线有效）', lb.testActuallyStarted === true);
  check('开始前排行榜可见（基线）', lb.visibleBeforeStart === true, JSON.stringify(lb.detailBefore));
  check('测验进行中排行榜自动收起（不可见）', lb.visibleDuringTest === false, JSON.stringify(lb.detailDuring));
  check('结束（重置）后排行榜自动展开（可见）', lb.visibleAfterEnd === true, JSON.stringify(lb.detailAfter));

  const failed = results.filter((r) => !r.pass);
  console.log(`\n===== ${results.length - failed.length}/${results.length} 通过 =====`);
  if (failed.length) {
    console.log('失败项：');
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
  }
  process.exitCode = failed.length ? 1 : 0;
} catch (err) {
  console.error('探针异常：', err.message);
  process.exitCode = 1;
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  browser.kill();
  server.kill();
  await sleep(400);
  try { fs.rmSync(userDir, { recursive: true, force: true }); } catch { /* ignore */ }
}
