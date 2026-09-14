/**
 * 运行时验收探针（headless Edge + CDP）：**世界档「国名/首都」+「中文/英文」、省级全国「省名/简称」**
 * （2026-09 需求）。
 *
 * 为什么必须做运行时验收（单测不够）：单测只能证明 mode 层算得对，证明不了
 *   ① 三组分段按钮在正确的时候出现 / 收起（那是 chromeSync 按模式与粒度算的）；
 *   ② 真正画在画布上的标签文字（走 ECharts 的 series 数据，中间还有一层 layers.ts）；
 *   ③ 点按钮 → 存盘 → 重绘这条真实链路通不通。
 *
 * 断言口径：题面/标签必须等于**数据里的**那个名字，而不能只是"看起来像" —— 脚本直接读
 * `dist/data/world_names.json` 与 `src/province-abbr.json` 做交叉比对；同时断言它**不等于**
 * 默认口径的名字（否则「口径其实没生效」也能蒙混过关）。
 *
 * 用法：npm run build && node scripts/verify-naming.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BROWSER = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const DIST = path.join(ROOT, 'dist');
const PORT = 9981;
const CDP = 9982;

/** 数据侧的事实源（与页面加载的同一份构建产物）。 */
const NAMES = JSON.parse(fs.readFileSync(path.join(DIST, 'data', 'world_names.json'), 'utf8')).names;
const COUNTRIES = JSON.parse(fs.readFileSync(path.join(DIST, 'data', 'countries.json'), 'utf8')).countries;
const ABBR = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'province-abbr.json'), 'utf8')).abbr;
const PROVINCE_NAME = new Map(
  JSON.parse(fs.readFileSync(path.join(DIST, 'data', 'units.json'), 'utf8')).provinces.map((p) => [p.adcode, p.name]),
);
const COUNTRY_NAME = new Map(COUNTRIES.map((c) => [c.iso, c.name]));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} | ${name}${detail ? ' | ' + detail : ''}`);
}

const server = spawn(process.execPath, [path.join(ROOT, 'scripts', 'static-server.mjs'), String(PORT), DIST], { stdio: 'ignore' });
await sleep(1200);
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-naming-'));
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

  async function evaluate(expr) {
    const r = await send('Runtime.evaluate', { expression: `(async () => (${expr}))()`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'eval failed');
    return r.result.value;
  }

  /** 打开页面并等探针就绪（1.2MB JS + 拓扑数据，冷启动偏慢）。 */
  async function load() {
    await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?probe=1` });
    for (let i = 0; i < 90; i++) {
      await sleep(500);
      try {
        const v = await evaluate('JSON.stringify({ p: typeof window.__probe })');
        if (JSON.parse(v).p === 'object') {
          await sleep(400); // 等首屏模式进入完成
          return;
        }
      } catch {
        /* 页面还没建好执行上下文 */
      }
    }
    throw new Error('探针未就绪');
  }

  /** 点一个真实的分段按钮（走 appController 的接线，而不是直接改内部状态）。 */
  const clickSel = (sel) => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`);
  const visible = (sel) =>
    evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null; return !el.classList.contains('hidden') && el.getBoundingClientRect().width > 0; })()`);
  /** 探针：当前口径 + 当前题 + 三处实际文本 + 三组按钮显隐。 */
  const naming = () => evaluate('window.__probe.namingTexts()');
  /** 探针：答对当前题（让「已作答」标签出现）。 */
  const answerCurrent = () => evaluate('window.__probe.answerCurrent()');

  // ---------------------------------------------------------------------------
  console.log('\n=== 1. 三组分段按钮按「粒度 + 模式」显隐 ===');
  await load();
  await clickSel('#mode-tabs button[data-mode="click"]');
  await clickSel('#granularity-province');
  await sleep(500);
  check('省级全国：显示「省名 / 简称」', (await visible('#province-name-toggle')) === true);
  check('省级全国：不显示「国名 / 首都」与「中文 / 英文」（省级档无中英文）', (await visible('#world-name-toggle')) === false && (await visible('#world-lang-toggle')) === false);

  await clickSel('#granularity-world');
  await sleep(500);
  check('世界档：显示「国名 / 首都」', (await visible('#world-name-toggle')) === true);
  check('世界档：显示「中文 / 英文」（在「国名 / 首都」右边）', (await visible('#world-lang-toggle')) === true, await evaluate(`(() => { const a = document.querySelector('#world-name-toggle').getBoundingClientRect(); const b = document.querySelector('#world-lang-toggle').getBoundingClientRect(); return 'name.right=' + Math.round(a.right) + ' lang.left=' + Math.round(b.left); })()`));
  check('世界档：不显示「省名 / 简称」', (await visible('#province-name-toggle')) === false);

  await clickSel('#granularity-city');
  await sleep(500);
  check('市级档：三组都不显示（地级不受取名口径影响）', (await visible('#world-name-toggle')) === false && (await visible('#world-lang-toggle')) === false && (await visible('#province-name-toggle')) === false);

  // ---------------------------------------------------------------------------
  console.log('\n=== 2. 世界档 · 首都 + 中文：题面与地图标签都是首都名 ===');
  await load();
  await clickSel('#mode-tabs button[data-mode="click"]');
  await clickSel('#granularity-world');
  await clickSel('#world-name-capital');
  await clickSel('#world-lang-zh');
  await sleep(400);
  check('点「首都」后该分段按钮变为选中态', (await evaluate(`document.querySelector('#world-name-capital').classList.contains('active')`)) === true);
  await clickSel('#click-start');
  await sleep(600);

  const q = await evaluate('window.__probe.quizScope()');
  const nm = await naming();
  const iso = nm.question;
  const expectCapital = NAMES[iso]?.capital;
  const expectCountry = COUNTRY_NAME.get(iso);
  check('题目已开始（基线：有当前题）', typeof iso === 'string' && iso.length === 3, `iso=${iso}`);
  check('口径已落到模式状态（world=capital）', nm.naming?.world === 'capital', JSON.stringify(nm.naming));
  check('题面显示首都名（与数据一致）', expectCapital ? nm.hint.includes(expectCapital) : false, `题面「${nm.hint}」应为「${expectCapital}」`);
  check('题面**不是**国名（证明口径真的生效，而不是碰巧长一样）', expectCountry && expectCapital !== expectCountry ? !nm.hint.includes(expectCountry) : true, `国名=${expectCountry}`);
  check('范围仍是世界全国（口径不改变范围）', q.scopeProvince === '__world_nation__', String(q.scopeProvince));

  await answerCurrent();
  await sleep(500);
  const nm2 = await naming();
  check('已作答国家的地图标签显示首都名', Array.isArray(nm2.worldLabels) && nm2.worldLabels.includes(expectCapital), `标签=${JSON.stringify(nm2.worldLabels)}`);
  check('开始答题后三组分段按钮整组收起', nm2.toggles.worldName === false && nm2.toggles.worldLang === false, JSON.stringify(nm2.toggles));

  // ---------------------------------------------------------------------------
  console.log('\n=== 3. 世界档 · 英文：题面与地图标签都是英文名 ===');
  await load();
  await clickSel('#mode-tabs button[data-mode="click"]');
  await clickSel('#granularity-world');
  await clickSel('#world-name-country');
  await clickSel('#world-lang-en');
  await sleep(400);
  await clickSel('#click-start');
  await sleep(600);
  const nm3 = await naming();
  const iso3 = nm3.question;
  const expectEn = NAMES[iso3]?.en;
  const zhName = COUNTRY_NAME.get(iso3);
  check('题面显示英文国名（与数据一致）', expectEn ? nm3.hint.includes(expectEn) : false, `题面「${nm3.hint}」应为「${expectEn}」`);
  check('题面**不是**中文国名', zhName && zhName !== expectEn ? !nm3.hint.includes(zhName) : true, `中文名=${zhName}`);
  await answerCurrent();
  await sleep(500);
  const nm3b = await naming();
  check('地图标签显示英文名', Array.isArray(nm3b.worldLabels) && nm3b.worldLabels.includes(expectEn), `标签=${JSON.stringify(nm3b.worldLabels)}`);

  // ---------------------------------------------------------------------------
  console.log('\n=== 4. 省级全国 · 简称：题面与地图标签都是单字简称 ===');
  await load();
  await clickSel('#mode-tabs button[data-mode="click"]');
  await clickSel('#granularity-province');
  await clickSel('#province-name-abbr');
  await sleep(400);
  await clickSel('#click-start');
  await sleep(600);
  const nm4 = await naming();
  const adcode = nm4.question;
  const expectAbbr = ABBR[adcode];
  const fullName = PROVINCE_NAME.get(adcode);
  check('题面显示单字简称（与简称表一致）', expectAbbr ? nm4.hint.includes(expectAbbr) : false, `题面「${nm4.hint}」应为「${expectAbbr}」`);
  check('题面**不是**省全名', fullName ? !nm4.hint.includes(fullName) : false, `省名=${fullName}`);
  await answerCurrent();
  await sleep(500);
  const nm4b = await naming();
  check('已作答省的地图标签显示简称', Array.isArray(nm4b.provinceLabels) && nm4b.provinceLabels.includes(expectAbbr), `标签=${JSON.stringify(nm4b.provinceLabels)}`);

  // ---------------------------------------------------------------------------
  console.log('\n=== 5. 省名档保持历史口径（回归闸门）===');
  await load();
  await clickSel('#mode-tabs button[data-mode="click"]');
  await clickSel('#granularity-province');
  await clickSel('#province-name-full');
  await sleep(400);
  await clickSel('#click-start');
  await sleep(600);
  const nm5 = await naming();
  const full5 = PROVINCE_NAME.get(nm5.question);
  const short5 = full5 ? full5.replace(/(维吾尔自治区|壮族自治区|回族自治区|特别行政区|自治区|省|市)$/g, '') : '';
  check('题面仍是省全名', full5 ? nm5.hint.includes(full5) : false, `题面「${nm5.hint}」`);
  await answerCurrent();
  await sleep(500);
  const nm5b = await naming();
  check('标签仍是去后缀省名（不是单字简称）', Array.isArray(nm5b.provinceLabels) && nm5b.provinceLabels.some((t) => t === short5), `标签=${JSON.stringify(nm5b.provinceLabels)} 期望含「${short5}」`);

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
