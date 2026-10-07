/**
 * 「其他」档（他国一级行政区）的运行时验收（2026-10 需求）。
 *
 * 需求口径（用户原话）：
 *   「对于输入模式和点击模式，在"世界/省级/市级"分段按钮右侧添加新的分段"其他"，点进去之后，
 *     下方显示新的分段按钮"美国/加拿大/日本/俄罗斯"，上方分段按钮为"随机/错题"或者"顺序/随机/错题"
 *     的分段按钮，以及"中文/外语"的分段按钮，用户的答题内容为这些国家的行政区划分（对应中国的省级），
 *     可以通过分段按钮切换到当地语言（美国加拿大英语，日本日语，俄罗斯俄语）。」
 *   追加口径：争议地区「不考但显示」；「纯练习」——不计熟练度、不上排行榜；飞地放左下角小窗。
 *
 * 为什么必须运行时验：这一档横跨四条链路，单测各抓一段、谁都不覆盖整条：
 *   数据按需加载 → 渲染器换图（geo 地图名 + 投影）→ 模式题池与判题 → UI 分段显隐与语言。
 *   · 换国家**真的换了地图**（`appliedMapName` = `other-<cc>`）；
 *   · 飞地小窗数量随国家变（美国 2 个、俄罗斯 1 个、日本 0 个且容器收起）；
 *   · 切语言后**地图标签**整体换成当地语言；
 *   · 纯练习口径：熟练度三个 localStorage 键一个字节不变、且不向 `/api/score` 提交；
 *   · 「错题」顺序档仍能用（错题清单独立存，见 src/other.ts）。
 *
 * 用法：npm run build && node scripts/verify-other.mjs
 *      node scripts/verify-other.mjs --prod   # 直连线上（https://mapmemory.cn/），跳过本地静态服
 *
 * ⚠ `--prod` 需要一条**健康**的链路到 CDN：它要真下载 1.3MB 主包 + 若干国家的行政几何。
 *   若主包或几何迟迟下不完，页面会停在半加载状态、断言失败 —— 那是链路问题而不是站点问题
 *   （判断方法：本地跑同一套是否全绿）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BROWSER = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9981;
const CDP = 9982;
const OUT = path.join(ROOT, 'docs', 'shots');
fs.mkdirSync(OUT, { recursive: true });

/** `--prod`：直连线上站点验收（本地静态服与 dist 都不参与），用于部署后确认整档在线上可用。 */
const PROD = process.argv.includes('--prod');
const BASE = PROD ? 'https://mapmemory.cn' : `http://127.0.0.1:${PORT}`;

/** 熟练度的三个存储键（纯练习口径：这三个键必须一动不动）。 */
const PRACTICE_KEYS = ['china-admin-memory-v1', 'china-admin-province-memory-v1', 'china-admin-world-memory-v1'];

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
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-other-'));
const browser = spawn(BROWSER, ['--headless=new', '--disable-gpu', '--no-first-run', `--user-data-dir=${userDir}`, `--remote-debugging-port=${CDP}`, '--window-size=1440,900', '--force-device-scale-factor=1', 'about:blank'], { stdio: 'ignore' });

let ws; let id = 0; const pending = new Map();
const send = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })); });

try {
  let target = null;
  for (let i = 0; i < 60; i++) {
    await sleep(400);
    try {
      const list = await fetch(`http://127.0.0.1:${CDP}/json/list`).then((r) => r.json());
      target = list.find((t) => t.type === 'page');
      if (target?.webSocketDebuggerUrl) break;
    } catch { /* wait */ }
  }
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    // 控制台告警/报错一律打出来：页面里的 try/catch 会把异常变成一条 toast，
    // 不看控制台就只能看到"点了没反应"（本轮就是这么定位到"国家数据加载失败"的）。
    if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'warning' || m.params.type === 'error')) {
      // 带上调用栈：页面里的 try/catch 会把异常变成一条 toast，只有栈能指出"到底哪一行"
      const frames = (m.params.stackTrace?.callFrames ?? [])
        .slice(0, 4)
        .map((f) => `${f.functionName || '(anonymous)'}@${f.lineNumber + 1}:${f.columnNumber + 1}`)
        .join(' ← ');
      console.log(`  [控制台 ${m.params.type}] ${m.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 200)}${frames ? `  ⟵ ${frames}` : ''}`);
    }
    if (m.method === 'Runtime.exceptionThrown') {
      console.log(`  [未捕获异常] ${(m.params.exceptionDetails?.exception?.description ?? '').split('\n')[0]}`);
    }
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
  };
  const click = (sel) => ev(`(function(){var b=document.querySelector(${JSON.stringify(sel)}); if(!b) return false; b.click(); return true;})()`);
  /** 档位快照：数据 + 渲染器（地图名/标签）+ UI（按钮高亮/显隐/小窗），一次拿全。 */
  const snap = () => asJson(`(function () {
    var s = window.__probe.otherScope();
    var text = function (b) { return b.textContent + (b.classList.contains('active') ? '*' : ''); };
    s.countryButtons = Array.prototype.map.call(document.querySelectorAll('#other-country-toggle button'), text);
    s.langButtons = Array.prototype.map.call(document.querySelectorAll('#other-lang-toggle button'), text);
    s.granularityButtons = Array.prototype.map.call(document.querySelectorAll('#granularity-toggle button'), text);
    s.countryHidden = document.getElementById('other-country-toggle').classList.contains('hidden');
    s.langHidden = document.getElementById('other-lang-toggle').classList.contains('hidden');
    s.insetBoxes = document.querySelectorAll('#other-insets .inset-window').length;
    s.insetsHidden = document.getElementById('other-insets').classList.contains('hidden');
    s.otherInsetAttr = document.getElementById('app').dataset.otherInset || '';
    var c = document.querySelector('#map canvas');
    s.canvas = c ? [Math.round(c.getBoundingClientRect().width), Math.round(c.getBoundingClientRect().height)] : null;
    s.practice = ${JSON.stringify(PRACTICE_KEYS)}.reduce(function (o, k) { o[k] = localStorage.getItem(k); return o; }, {});
    return s;
  })()`);
  /** 在搜索框里输入并回车（与真实用户同一路径：input 事件 + Enter keydown）。 */
  const typeAndSubmit = (text) =>
    ev(`(function () {
      var el = document.getElementById('search-input');
      var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, ${JSON.stringify(text)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return el.value;
    })()`);

  /**
   * 真值来自**数据文件**（不是从页面读回来）：验收脚本要拿"库里写的名字"去答题，
   * 而不是拿页面显示的名字回填 —— 后者会把"名字取错了"这种缺陷一起验过。
   */
  const unitsOf = (cc) =>
    JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'data', 'other', `${cc}.units.json`), 'utf8')).units;
  const nameOf = (cc, code) => {
    const u = unitsOf(cc).find((x) => x.code === code);
    if (!u) throw new Error(`数据里找不到 ${cc} / ${code}`);
    return { zh: u.name, local: u.nameLocal, en: u.nameEn };
  };

  // ==================== 0. 启动 ====================
  console.log('=== 0. 启动与初始态（点击模式 + 省级） ===');
  // 页面脚本之前装一个 /api/score 计数器：纯练习口径的硬证据是"一次都没提交过"
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(function () {
      window.__scoreCalls = 0;
      var real = window.fetch ? window.fetch.bind(window) : null;
      window.fetch = function (input, init) {
        var url = typeof input === 'string' ? input : (input && input.url) || '';
        if (url.indexOf('/api/score') >= 0) window.__scoreCalls += 1;
        return real ? real(input, init) : Promise.reject(new Error('no fetch'));
      };
    })();`,
  });
  await send('Page.navigate', { url: `${BASE}/?probe=1` });
  for (let i = 0; i < 90; i++) {
    await sleep(500);
    if ((await ev(`typeof window.__probe === 'object'`).catch(() => false)) === true) break;
  }
  await sleep(1500);
  const initial = await snap();
  check('粒度行现在是四档：世界 / 省级 / 市级 / 其他', initial.granularityButtons.join(' ') === '世界 省级* 市级 其他', initial.granularityButtons);
  check('不在「其他」档时，国家行与语言行都收起', initial.countryHidden && initial.langHidden && initial.insetBoxes === 0, { countryHidden: initial.countryHidden, langHidden: initial.langHidden });
  check('国家按钮按数据渲染出四国（美国/加拿大/日本/俄罗斯）', initial.countryButtons.join(',') === '美国,加拿大,日本,俄罗斯', initial.countryButtons);
  const practiceBefore = initial.practice;

  // ==================== 1. 进入「其他」档 ====================
  console.log('\n=== 1. 点「其他」→ 默认美国 ===');
  await click('#granularity-other');
  await sleep(3000);
  const usa = await snap();
  check('粒度切到 other，国家行与语言行出现', usa.granularity === 'other' && !usa.countryHidden && !usa.langHidden, { granularity: usa.granularity, countryHidden: usa.countryHidden, langHidden: usa.langHidden });
  check('默认国家是美国，题池 51（50 州 + 华盛顿特区）', usa.country === 'usa' && usa.poolSize === 51, { country: usa.country, pool: usa.poolSize });
  check('渲染器真的换成美国地图（appliedMapName = other-usa）', usa.mapName === 'other-usa' && usa.otherMode === true, { mapName: usa.mapName, otherMode: usa.otherMode });
  check('国家按钮高亮「美国」', usa.countryButtons.join(',') === '美国*,加拿大,日本,俄罗斯', usa.countryButtons);
  check('地图标签是中文州名（含阿拉斯加州/夏威夷州）', usa.labels.includes('阿拉斯加州') && usa.labels.includes('夏威夷州') && usa.labels.length === 51, { count: usa.labels.length });
  check('飞地小窗 2 个（阿拉斯加 / 夏威夷），与港澳小窗同一套样式', usa.insetBoxes === 2 && !usa.insetsHidden, { boxes: usa.insetBoxes });
  check('说明/缩放按钮让位（#app 带 data-other-inset）', usa.otherInsetAttr === '1', usa.otherInsetAttr);
  await shot('verify-other-1-usa.png');

  // ==================== 2. 换国家 ====================
  console.log('\n=== 2. 换国家：日本 → 俄罗斯 ===');
  await click('#other-country-jpn');
  await sleep(2500);
  const jpn = await snap();
  check('切到日本：题池 47、地图换成 other-jpn', jpn.country === 'jpn' && jpn.poolSize === 47 && jpn.mapName === 'other-jpn', { country: jpn.country, pool: jpn.poolSize, mapName: jpn.mapName });
  check('日本没有飞地小窗（小窗数 0 且容器收起）', jpn.insetBoxes === 0 && jpn.insetsHidden, { boxes: jpn.insetBoxes, hidden: jpn.insetsHidden });
  check('切国家后地图标签整体换成日本 47 个都道府县', jpn.labels.length === 47 && jpn.labels.includes('北海道') && jpn.labels.includes('冲绳县'), { count: jpn.labels.length });
  check('国家按钮高亮跟随（日本*）', jpn.countryButtons.join(',') === '美国,加拿大,日本*,俄罗斯', jpn.countryButtons);

  await click('#other-country-rus');
  await sleep(2500);
  const rus = await snap();
  check('切到俄罗斯：题池 83（85 面 − 2 个不考的争议地区）', rus.country === 'rus' && rus.poolSize === 83 && rus.unitTotal === 85 && rus.decorative === 2, { pool: rus.poolSize, total: rus.unitTotal, decorative: rus.decorative });
  check('俄罗斯地图生效，飞地小窗 1 个（加里宁格勒）', rus.mapName === 'other-rus' && rus.insetBoxes === 1, { mapName: rus.mapName, boxes: rus.insetBoxes });
  check('俄罗斯中文标签正确，「不考但显示」的克里米亚不在题池标签里', rus.labels.length === 83 && rus.labels.includes('阿尔泰边疆区') && rus.labels.includes('莫斯科') && rus.labels.includes('莫斯科州') && !rus.labels.some((s) => s.includes('克里米亚')), { count: rus.labels.length });
  await shot('verify-other-2-rus.png');

  // ==================== 3. 语言切换 ====================
  console.log('\n=== 3. 「中文 / 外语」切换（当地语言） ===');
  const before = await snap();
  await click('#other-lang-local');
  await sleep(1500);
  const local = await snap();
  check('语言行高亮切到「外语」', local.langButtons.join(',') === '中文,外语*' && local.lang === 'local', local.langButtons);
  check('地图标签整体换成俄文（题池规模不变 = 只是换了名字）', local.poolSize === before.poolSize && local.labels.includes('Московская область') && !local.labels.includes('莫斯科州'), { sample: local.labels.slice(0, 4) });
  await click('#other-country-jpn');
  await sleep(2000);
  const jpnLocal = await snap();
  check('切到日本后仍是「外语」，标签是日文（東京都 / 沖縄県）', jpnLocal.lang === 'local' && jpnLocal.labels.includes('東京都') && jpnLocal.labels.includes('沖縄県'), { sample: jpnLocal.labels.slice(0, 4) });
  await shot('verify-other-3-jpn-local.png');

  // ==================== 4. 玩法：输入模式用**当地语言**作答 ====================
  console.log('\n=== 4. 玩法（输入模式）：用当地语言答对 / 答错进错题 ===');
  await click('#granularity-province'); // 先回省级，再切模式
  await sleep(800);
  await click('#mode-tabs button[data-mode="self"]');
  await sleep(1200);
  await click('#granularity-other');
  await sleep(2500);
  // 本模式的「其他」档记住的是它自己的国家（默认美国），故这里显式切到日本 + 外语
  await click('#other-country-jpn');
  await sleep(2000);
  await click('#other-lang-local');
  await sleep(1200);
  const beforeStart = await snap();
  check('输入模式 + 其他档 + 日语：国家是日本、语言高亮「外语」', beforeStart.country === 'jpn' && beforeStart.lang === 'local' && beforeStart.langButtons.join(',') === '中文,外语*', { country: beforeStart.country, lang: beforeStart.lang, buttons: beforeStart.langButtons });
  const placeholder = await ev(`document.getElementById('search-input').placeholder`);
  check('输入框提示按口径给出（「输入当地语言地名」）', placeholder === '输入当地语言地名', placeholder);

  check('开始卡片按钮存在（输入模式的 #self-start）', (await ev(`!!document.getElementById('self-start')`)) === true);
  await click('#self-start');
  await sleep(1200);
  const q1 = await asJson(`window.__probe.namingTexts()`);
  check('开始后出题（输入模式的题面是地图上的高亮区，没有文字提示）', q1.started === true && !!q1.question && q1.hint === '', { question: q1.question, hint: q1.hint });

  // ① 用**当地语言名**答对（数据文件里的 nameLocal）
  const want1 = nameOf('jpn', q1.question);
  const typed = await typeAndSubmit(want1.local);
  await sleep(900);
  const afterCorrect = await snap();
  check(`用当地语言名（${want1.local}）作答即判对：该题进 green`, afterCorrect.green.includes(q1.question), { typed, question: q1.question, green: afterCorrect.green });

  // ② 用**中文名**答下一题也判对（三种写法都接受：中文/当地/英文，与当前语言档无关）
  const q2 = await asJson(`window.__probe.namingTexts()`);
  const want2 = nameOf('jpn', q2.question);
  await typeAndSubmit(want2.zh);
  await sleep(900);
  const afterZh = await snap();
  check(`用中文名（${want2.zh}）作答同样判对（判题接受三种写法）`, afterZh.green.includes(q2.question), { question: q2.question, green: afterZh.green });

  // ③ 答错一题：乱输入
  const q3 = await asJson(`window.__probe.namingTexts()`);
  const wrongTyped = await typeAndSubmit('不存在的名字XYZ');
  await sleep(900);
  const afterWrong = await snap();
  // 注意：不能断言 `typed` —— 提交后模式会立刻清空输入框（`ask()` 里 search.clear()），
  // 取回的 el.value 已经是空串。看的是"是否真的计了错"与"是否换了下一题"。
  check('乱输入判错：该题进 red 且题面换到下一题', afterWrong.red.includes(q3.question) && afterWrong.question !== q3.question, { typed: wrongTyped, question: q3.question, red: afterWrong.red, next: afterWrong.question });
  const wrongStore = await ev(`localStorage.getItem('china-admin-other-wrong:self')`);
  check('错题记进**独立**清单（不进熟练度，供「错题」顺序档使用）', typeof wrongStore === 'string' && JSON.parse(wrongStore).includes(q3.question), wrongStore);
  await shot('verify-other-4-playing.png');

  // ==================== 5. 纯练习口径 ====================
  console.log('\n=== 5. 纯练习：熟练度三键不动、且不提交排行榜 ===');
  const afterAnswers = await snap();
  const practiceSame = PRACTICE_KEYS.every((k) => afterAnswers.practice[k] === practiceBefore[k]);
  check('答对答错之后，熟练度三个 localStorage 键仍然一个字节都没变', practiceSame, { before: practiceBefore, after: afterAnswers.practice });
  const scoreCalls = await ev(`window.__scoreCalls || 0`);
  check('全程没有向排行榜提交成绩（/api/score 调用数 0）', scoreCalls === 0, scoreCalls);
  const scope = await asJson(`window.__probe.quizScope()`);
  check('该档没有排行榜作用域（getScopeProvince 返回 null）', scope.scopeProvince === null && scope.granularity === 'other', { scopeProvince: scope.scopeProvince, granularity: scope.granularity });

  // ==================== 6. 退出该档 ====================
  console.log('\n=== 6. 重置后切回省级：地图回中国、小窗收起 ===');
  // 答题进行中不允许切粒度（模式的守卫），故先重置 ——「其他」档没有可提交的成绩，重置直接重开。
  // ⚠ 重置按钮是**两步确认**（第一次点变成「确认」，第二次才执行），故这里点两次。
  await click('#btn-reset');
  await sleep(400);
  await click('#btn-reset');
  await sleep(1500);
  const afterReset = await asJson(`window.__probe.quizScope()`);
  console.log('  重置后：', JSON.stringify({ started: afterReset.started, granularity: afterReset.granularity, mode: afterReset.mode }));
  await click('#granularity-province');
  await sleep(2000);
  const back = await snap();
  check('回到省级档：地图名不再是 other-*，国家/语言行收起，小窗收起', !String(back.mapName).startsWith('other-') && back.countryHidden && back.langHidden && back.insetsHidden, { mapName: back.mapName, countryHidden: back.countryHidden, insetsHidden: back.insetsHidden });
  check('模式侧也退出了「其他」档（粒度回省级，渲染器不再处于该档）', back.granularity === 'province' && back.otherMode === false, { granularity: back.granularity, otherMode: back.otherMode });
  await shot('verify-other-5-back.png');
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
