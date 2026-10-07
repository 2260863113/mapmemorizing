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
  /**
   * 轮询等待某个条件成立（默认 30 秒）。
   *
   * 为什么不能只 `sleep(固定值)`：切国家要**懒加载**该国的几何（俄罗斯 183KB、加拿大 203KB），
   * 线上慢链路下 2.5 秒根本下不完 —— 断言会读到"上一个国家"的状态而误报失败（线上实测踩过）。
   * 轮询到状态真的变了再断言，本地与线上都稳定。
   */
  const waitFor = async (fn, timeoutMs = 30000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (await fn()) return true;
      await sleep(250);
    }
    return false;
  };
  /** 等到「其他」档的当前国家变成 cc（渲染器也已换图）。 */
  const waitCountry = (cc) => waitFor(async () => {
    const s = await asJson(`JSON.stringify({ c: window.__probe.otherScope().country, m: window.__probe.otherScope().mapName })`);
    return s.c === cc && s.m === `other-${cc}`;
  });
  /** 档位快照：数据 + 渲染器（地图名/标签）+ UI（按钮高亮/显隐/小窗），一次拿全。 */
  const snap = () => asJson(`(function () {
    var s = window.__probe.otherScope();
    var text = function (b) { return b.textContent + (b.classList.contains('active') ? '*' : ''); };
    s.countryButtons = Array.prototype.map.call(document.querySelectorAll('#other-country-toggle button'), text);
    s.langButtons = Array.prototype.map.call(document.querySelectorAll('#other-lang-toggle button'), text);
    s.granularityButtons = Array.prototype.map.call(document.querySelectorAll('#granularity-toggle button'), text);
    /** 语言行是否与「顺序/随机/错题」那一排**在同一行**（用户口径：并到最上面那一排的右边） */
    var langRow = document.getElementById('other-lang-toggle');
    var orderRow = document.getElementById('self-order-toggle').classList.contains('hidden')
      ? document.getElementById('click-order-toggle')
      : document.getElementById('self-order-toggle');
    s.sameRowAsOrder = !!langRow && !!orderRow
      ? Math.abs(langRow.getBoundingClientRect().top - orderRow.getBoundingClientRect().top) < 6
        && langRow.getBoundingClientRect().left > orderRow.getBoundingClientRect().right
      : null;
    s.countryHidden = document.getElementById('other-country-toggle').classList.contains('hidden');
    s.langHidden = document.getElementById('other-lang-toggle').classList.contains('hidden');
    s.insetsHidden = !document.getElementById('other-insets');
    /** 飞地小窗容器**整体不该存在**（用户口径：不要左下角小窗） */
    s.insetHostExists = !!document.getElementById('other-insets');
    s.otherInsetAttr = document.getElementById('app').dataset.otherInset || '';
    var c = document.querySelector('#map canvas');
    s.canvas = c ? [Math.round(c.getBoundingClientRect().width), Math.round(c.getBoundingClientRect().height)] : null;
    /** 画布**真的有内容**吗：与左上角背景色不同的像素占比（0% = 地图消失，只剩空白） */
    if (c) {
      var ctx2 = c.getContext('2d');
      var d = ctx2.getImageData(0, 0, c.width, c.height).data;
      var bg = [d[0], d[1], d[2]], diff = 0, total = 0;
      for (var i = 0; i < d.length; i += 4 * 37) {
        total++;
        if (Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]) > 24) diff++;
      }
      s.fillPct = +(100 * diff / total).toFixed(2);
    } else { s.fillPct = null; }
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
  // 本地静态服很快；线上要下 1.3MB 主包 + 探针 chunk，**而且探针是 `start()` 里 `loadData()`
  // 之后才挂上的**（那之前还要拉中国 units/几何等若干 MB）。链路慢时给足 5 分钟上限，
  // 否则会得到"应用没启动"（`window.__probe` undefined）的假象 —— 那不是站点问题。
  const bootLimit = PROD ? 600 : 90;
  for (let i = 0; i < bootLimit; i++) {
    await sleep(500);
    if ((await ev(`typeof window.__probe === 'object'`).catch(() => false)) === true) break;
  }
  if (PROD) {
    const booted = await ev(`typeof window.__probe === 'object'`);
    console.log(`  线上启动检查：__probe=${booted}（等待上限 ${bootLimit * 0.5}s）`);
  }
  await sleep(1500);
  const initial = await snap();
  check('粒度行现在是四档：世界 / 省级 / 市级 / 其他', initial.granularityButtons.join(' ') === '世界 省级* 市级 其他', initial.granularityButtons);
  check('不在「其他」档时，国家行与语言行都收起', initial.countryHidden && initial.langHidden && initial.insetHostExists === false, { countryHidden: initial.countryHidden, langHidden: initial.langHidden });
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
  check('未开始时**不**显示地名标签（用户口径：其他档没开始就不要显示标签）', usa.labels.length === 0, { n: usa.labels.length });
  check('地图真的画出来了（画布非背景像素 > 5%）', usa.fillPct > 5, { fillPct: usa.fillPct });
  check('没有左下角小窗容器（用户口径：只在主图上点）', usa.insetHostExists === false && usa.otherInsetAttr === '', { host: usa.insetHostExists, attr: usa.otherInsetAttr });
  check('飞地在**主图**投影范围内（美国包围盒含阿拉斯加 −187° 与夏威夷 18.9°N）', usa.bboxMain[0] < -180 && usa.bboxMain[1] < 20, usa.bboxMain);
  check('飞地直接可点（events data 里有 US-AK / US-HI）', usa.interactive.includes('US-AK') && usa.interactive.includes('US-HI') && usa.interactive.length === 51, { n: usa.interactive.length });
  await shot('verify-other-1-usa.png');

  // ==================== 2. 换国家 ====================
  console.log('\n=== 2. 换国家：日本 → 俄罗斯 ===');
  await click('#other-country-jpn');
  await waitCountry('jpn');
  const jpn = await snap();
  check('切到日本：题池 47、地图换成 other-jpn', jpn.country === 'jpn' && jpn.poolSize === 47 && jpn.mapName === 'other-jpn', { country: jpn.country, pool: jpn.poolSize, mapName: jpn.mapName });
  check('地图真的画出来了，且始终没有小窗容器', jpn.fillPct > 2 && jpn.insetHostExists === false, { fillPct: jpn.fillPct, host: jpn.insetHostExists });
  check('切国家后仍然不显示标签（换国家不改变这条口径）', jpn.labels.length === 0, { n: jpn.labels.length });
  check('日本的离岛（北海道/冲绳）也在主图上可点', jpn.interactive.includes('JP-01') && jpn.interactive.includes('JP-47') && jpn.interactive.length === 47, { n: jpn.interactive.length });
  check('国家按钮高亮跟随（日本*）', jpn.countryButtons.join(',') === '美国,加拿大,日本*,俄罗斯', jpn.countryButtons);

  await click('#other-country-rus');
  await waitCountry('rus');
  const rus = await snap();
  check('切到俄罗斯：题池 83（85 面 − 2 个不考的争议地区）', rus.country === 'rus' && rus.poolSize === 83 && rus.unitTotal === 85 && rus.decorative === 2, { pool: rus.poolSize, total: rus.unitTotal, decorative: rus.decorative });
  check('俄罗斯地图生效，加里宁格勒在主图上可点（不再是小窗）', rus.mapName === 'other-rus' && rus.fillPct > 5 && rus.insetHostExists === false && rus.interactive.includes('RU-KGD'), { mapName: rus.mapName, fillPct: rus.fillPct, kgd: rus.interactive.includes('RU-KGD') });
  // ==================== 3. 语言切换（用 Alt 临时显示全量标签来读文本） ====================
  console.log('\n=== 3. 「中文 / 外语」切换（当地语言）：按 Alt 临时显示标签读文本 ===');
  /** 按 Alt 显示全量标签（会话级覆盖）：这是「其他」档唯一会显示浏览地名的路径。 */
  const pressAlt = () =>
    ev(`(function () {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Alt', bubbles: true, cancelable: true }));
      return true;
    })()`);
  await pressAlt();
  await sleep(1200);
  const rusZh = await snap();
  check('按 Alt 后显示全量标签：俄罗斯 83 个中文名（含不考但显示的克里米亚**不在**池内）', rusZh.labels.length === 83 && rusZh.labels.includes('阿尔泰边疆区') && rusZh.labels.includes('莫斯科') && rusZh.labels.includes('莫斯科州') && !rusZh.labels.some((s) => s.includes('克里米亚')), { n: rusZh.labels.length });
  await shot('verify-other-2-rus.png');

  const before = await snap();
  await click('#other-lang-local');
  await sleep(1500);
  const local = await snap();
  check('语言行高亮切到「俄语」', local.langButtons.join(',') === '中文,俄语*' && local.lang === 'local', local.langButtons);
  check('地图标签整体换成俄文（题池规模不变 = 只是换了名字）', local.poolSize === before.poolSize && local.labels.includes('Московская область') && !local.labels.includes('莫斯科州'), { sample: local.labels.slice(0, 4) });
  await click('#other-country-jpn');
  await waitCountry('jpn');
  const jpnLocal = await snap();
  check('切到日本后仍是当地语言档，标签是日文（東京都 / 沖縄県），按钮文字变「日语」', jpnLocal.lang === 'local' && jpnLocal.langButtons.join(',') === '中文,日语*' && jpnLocal.labels.includes('東京都') && jpnLocal.labels.includes('沖縄県'), { buttons: jpnLocal.langButtons, sample: jpnLocal.labels.slice(0, 4) });
  await shot('verify-other-3-jpn-local.png');
  // 再按一次 Alt 关掉全量标签（回到"没开始就不显示"的默认）
  await pressAlt();
  await sleep(1200);
  const altOff = await snap();
  check('再按一次 Alt 收起全量标签（回到默认的"不显示"）', altOff.labels.length === 0, { n: altOff.labels.length });

  // ==================== 4. 玩法：输入模式用**当地语言**作答 ====================
  console.log('\n=== 4. 玩法（输入模式）：用当地语言答对 / 答错进错题 ===');
  await click('#granularity-province'); // 先回省级，再切模式
  await sleep(800);
  await click('#mode-tabs button[data-mode="self"]');
  await sleep(1200);
  await click('#granularity-other');
  await waitCountry('usa'); // 输入模式记得的是它自己的国家（默认美国）
  // 本模式的「其他」档记住的是它自己的国家（默认美国），故这里显式切到日本 + 当地语言
  await click('#other-country-jpn');
  await waitCountry('jpn');
  await click('#other-lang-local');
  await sleep(1200);
  const beforeStart = await snap();
  check('输入模式 + 其他档 + 日语：国家是日本、语言高亮「日语」', beforeStart.country === 'jpn' && beforeStart.lang === 'local' && beforeStart.langButtons.join(',') === '中文,日语*', { country: beforeStart.country, lang: beforeStart.lang, buttons: beforeStart.langButtons });
  check('语言行与「顺序/随机/错题」那一排**同一行**、且在它右边', beforeStart.sameRowAsOrder === true, beforeStart.sameRowAsOrder);
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

  /**
   * ⭐ 答题进行中按 Alt：**不许把未作答的名字念出来**（用户口径 2026-10）。
   * 判据 = 标签数只等于已作答数，而不是题池总数（47）。
   */
  await pressAlt();
  await sleep(1000);
  const duringPlay = await snap();
  check('⭐ 答题中按 Alt 只显示已作答的标签（未作答的不显示）', duringPlay.labels.length === duringPlay.green.length + duringPlay.red.length && duringPlay.labels.length < duringPlay.poolSize, { labels: duringPlay.labels.length, green: duringPlay.green.length, red: duringPlay.red.length, pool: duringPlay.poolSize });
  await pressAlt();
  await sleep(600);

  // ③ 答错一题：乱输入；同时盯着画布，防"答错后地图空白一两秒"回归
  const q3 = await asJson(`window.__probe.namingTexts()`);
  const wrongTyped = await typeAndSubmit('不存在的名字XYZ');
  const fills = [];
  for (let i = 0; i < 14; i++) {
    await sleep(160);
    const s = await asJson(`JSON.stringify(window.__probe.otherScope())`);
    const c = await ev(`(function () {
      var el = document.querySelector('#map canvas');
      var d = el.getContext('2d').getImageData(0, 0, el.width, el.height).data;
      var bg = [d[0], d[1], d[2]], diff = 0, total = 0;
      for (var i = 0; i < d.length; i += 4 * 37) { total++; if (Math.abs(d[i]-bg[0])+Math.abs(d[i+1]-bg[1])+Math.abs(d[i+2]-bg[2]) > 24) diff++; }
      return +(100 * diff / total).toFixed(2);
    })()`);
    fills.push(c);
    void s;
  }
  const afterWrong = await snap();
  // 注意：不能断言 `typed` —— 提交后模式会立刻清空输入框（`ask()` 里 search.clear()），
  // 取回的 el.value 已经是空串。看的是"是否真的计了错"与"是否换了下一题"。
  check('乱输入判错：该题进 red 且题面换到下一题', afterWrong.red.includes(q3.question) && afterWrong.question !== q3.question, { typed: wrongTyped, question: q3.question, red: afterWrong.red, next: afterWrong.question });
  /**
   * ⭐ 答错后的纠错平移期间画布必须一直有内容（曾经的缺陷：跟随动画把 `geo.map` 换成了中国档，
   * region 名 `JP-*` 一个都匹配不上 → 画布空白约 0.6 秒，用户看到"地图消失一两秒"）。
   */
  check('⭐ 答错后的纠错平移全程地图不消失（每帧画布非背景像素 > 3%）', Math.min(...fills) > 3, { min: Math.min(...fills), max: Math.max(...fills), samples: fills });
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

  // ==================== 6. 退出该档（用户报的 bug：回省级/市级地图消失） ====================
  console.log('\n=== 6. 重置后切回省级 / 市级：地图必须还在（相机不能停在他国） ===');
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
  check('回到省级档：地图名不再是 other-*，国家/语言行收起', !String(back.mapName).startsWith('other-') && back.countryHidden && back.langHidden, { mapName: back.mapName, countryHidden: back.countryHidden });
  check('模式侧也退出了「其他」档（粒度回省级，渲染器不再处于该档）', back.granularity === 'province' && back.otherMode === false, { granularity: back.granularity, otherMode: back.otherMode });
  /**
   * ⭐ 这一条是用户报的 bug 的回归闸门：进过「其他」之后回省级，地图**必须还画得出来**。
   * 曾经的缺陷：`snapshotViewBeforeLeave()` 不认识这一族，把美国视野写进了中国族的记忆槽，
   * 回省级时相机被"恢复"到美国中心 —— 地图名对（china-provinces-ultra）但画布一片空白。
   * 故这里同时断言**相机回到中国**与**画布真的有像素**，只看地图名是抓不到的。
   */
  check('⭐ 相机回到中国范围（不是停在他国的中心）', back.center[0] > 70 && back.center[0] < 140 && back.center[1] > 3 && back.center[1] < 55, back.center);
  check('⭐ 省级地图真的画出来了（画布非背景像素 > 3%，不是空白）', back.fillPct > 3, { fillPct: back.fillPct });
  await shot('verify-other-5-back-province.png');

  await click('#granularity-city');
  await sleep(2000);
  const city = await snap();
  check('⭐ 切到市级同样正常：地图名 china-ultra 且画布有内容', String(city.mapName).startsWith('china-') && city.fillPct > 3, { mapName: city.mapName, fillPct: city.fillPct });
  await shot('verify-other-6-back-city.png');

  // ==================== 7. 标签字号（人工确认用截图） ====================
  console.log('\n=== 7. 「其他」档标签字号（固定最大，不随缩放变小）===');
  await click('#granularity-other');
  await sleep(2500);
  await pressAlt(); // 用 Alt 显示全量标签，才能看字号
  await sleep(1200);
  const at1x = await snap();
  await shot('verify-other-7-labels-1x.png');
  // 用真实滚轮**缩小**（与用户操作同一条路径；ECharts 里 deltaY 为负是缩小）
  await ev(`(function () {
    var c = document.querySelector('#map canvas');
    var r = c.getBoundingClientRect();
    for (var i = 0; i < 6; i++) {
      c.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, cancelable: true }));
    }
    return true;
  })()`);
  await sleep(1200);
  const zoomedOut = await snap();
  await shot('verify-other-8-labels-zoomed-out.png');
  console.log(`  缩放 ${at1x.zoom?.toFixed(2)} → ${zoomedOut.zoom?.toFixed(2)}；标签数 ${at1x.labels?.length} → ${zoomedOut.labels?.length}`);
  check('缩小后地图与标签都还在（截图 verify-other-7/8 供人工确认字号未变小）', zoomedOut.fillPct > 1 && (zoomedOut.labels?.length ?? 0) > 0, { fillPct: zoomedOut.fillPct, labels: zoomedOut.labels?.length });
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
