import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ClickMode } from './click';
import { InputMode } from './input';
import type { ModeCtx } from './types';
import type { AppData, CountryMeta, Province, RenderState, Unit } from '../types';
import { makeAppData } from '../testFixture';
import { Matcher } from '../matcher';
import { resetFlagPreloadForTest } from './flagPreload';

/**
 * 国旗预加载会用到 `Image`（node 测试环境没有）；这里给一个"立刻 onload"的替身，
 * 顺便记录被请求过的 src，供下面断言"选上国旗档就开始预取"。
 */
const requestedFlags: string[] = [];
class ImmediateImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  set src(value: string) {
    requestedFlags.push(value);
    this.onload?.();
  }
}
beforeEach(() => {
  requestedFlags.length = 0;
  resetFlagPreloadForTest(); // 预取队列是模块级状态，测试之间必须复位，否则 done 集合会串
  vi.stubGlobal('Image', ImmediateImage);
});
afterEach(() => vi.unstubAllGlobals());

/**
 * 「国名 / 首都」+「中文 / 英文」+「省名 / 简称」三组分段按钮的行为约束（2026-09 需求）。
 *
 * 这里断言的是**同一份口径贯穿三处**：题面（点击模式题卡）、地图标签、判题 —— 任何一处漏改
 * 都会出现「题卡写首都、标签写国名」或「题卡写沪、判题认上海」这类界面自相矛盾。
 *
 * 用最小假渲染器记录 render 状态，不依赖 DOM / ECharts（与 freeBrowse.test.ts 同一手法）。
 * 粒度用 `applyScopeQuery` 设置：它只落状态、不 enter，因此不会碰到开始卡片的 DOM。
 */

const COUNTRIES: CountryMeta[] = [
  { iso: 'JPN', name: '日本', fullName: '日本国', center: [138, 36], neighbors: [], continent: 'AS' },
  { iso: 'CHN', name: '中国', fullName: '中华人民共和国', center: [104, 35], neighbors: [], continent: 'AS' },
];

const PROVINCES: Province[] = [
  { adcode: '310000', name: '上海市', center: [121, 31] },
  { adcode: '110000', name: '北京市', center: [116, 40] },
];

function unit(adcode: string, name: string, provinceAdcode: string): Unit {
  return { adcode, name, shortName: name, province: 'P', provinceAdcode, center: [0, 0], neighbors: [], decorative: false };
}

const UNITS = [unit('310100', '上海市', '310000'), unit('110100', '北京市', '110000')];

function makeCtx(over: Partial<AppData> = {}) {
  const states: RenderState[] = [];
  const hints: string[] = [];
  const toasts: string[] = [];
  const placeholders: string[] = [];
  const renderer = {
    setWorldMode: () => {},
    setProvinceMode: () => {},
    render: (state: RenderState) => {
      states.push(state);
    },
    drillToProvince: () => {},
    backToNation: () => {},
    currentProvince: () => null,
    flash: () => {},
    focusUnit: () => {},
    focusWorldCountry: () => {},
    panUnit: () => {},
    panWorldCountry: () => {},
  };
  const practice = { correctCount: 0, wrongCount: 0, score: 0 };
  const data = makeAppData({
    countries: COUNTRIES,
    countryNames: {
      JPN: { en: 'Japan', capital: '东京', capitalEn: 'Tokyo' },
      CHN: { en: 'China', capital: '北京', capitalEn: 'Beijing' },
    },
    countryFlags: { JPN: 'jp.svg', CHN: 'cn.svg' },
    provinces: PROVINCES,
    units: UNITS,
    allUnits: UNITS,
    ...over,
  });
  const ctx = {
    data,
    renderer,
    matcher: new Matcher(data),
    store: {
      getPractice: () => practice,
      getProvincePractice: () => practice,
      getWorldPractice: () => practice,
      recordAnswer: () => {},
      recordProvinceAnswer: () => {},
      recordWorldAnswer: () => {},
    },
    search: {
      setPlaceholder: (v: string) => placeholders.push(v),
      setRequireEnter: () => {},
      clear: () => {},
      focus: () => {},
    },
    stats: {},
    settings: { darkMode: false, cityBoundaryTone: 'light', provinceBoundaryTone: 'dark', worldBoundaryTone: 'mid', ignoreTinyCountries: false },
    byAdcode: new Map(UNITS.map((u) => [u.adcode, u])),
    toast: (m: string) => toasts.push(m),
    setHint: (html: string) => hints.push(html),
    showTimer: () => {},
    showStopwatch: () => {},
    showSummary: () => {},
    hideSummary: () => {},
    updateProgress: () => {},
    randomUnit: (pool: Unit[]) => pool[0],
  } as unknown as ModeCtx;
  return { ctx, states, hints, toasts, placeholders };
}

/** 只落粒度、不走 enter（避免开始卡片的 DOM 依赖）。 */
const scopeQuery = (granularity: 'world' | 'province' | 'city') => ({
  granularity,
  continent: null,
  subregion: null,
  province: null,
});

/**
 * 造一道「已作答」的题：地图标签只对**已作答**的单位显示，故先把它标绿再问题面。
 * 口径开关只改标签文本、不改这套显隐规则（另有一条用例专门断这件事）。
 */
function askAnswered(mode: ClickMode, u: Unit) {
  mode.diagnostics().green.add(u.adcode);
  mode.ask(u);
}

describe('点击模式 · 世界档「国名 / 首都」+「中文 / 英文」', () => {
  it('默认（国名 + 中文）：题卡与标签都是国名（历史行为不变）', () => {
    const { ctx, states, hints } = makeCtx();
    const mode = new ClickMode(ctx);
    mode.applyScopeQuery(scopeQuery('world'));
    askAnswered(mode, unit('JPN', '日本', 'JPN'));
    expect(hints.at(-1)).toContain('日本');
    expect(states.at(-1)?.worldLabel?.('JPN')?.text).toBe('日本');
  });

  it('首都 + 中文：题卡与标签都换成首都名', () => {
    const { ctx, states, hints } = makeCtx();
    const mode = new ClickMode(ctx);
    mode.applyScopeQuery(scopeQuery('world'));
    mode.setQuestionNaming({ world: 'capital' });
    askAnswered(mode, unit('JPN', '日本', 'JPN'));
    expect(hints.at(-1)).toContain('东京');
    expect(hints.at(-1)).not.toContain('日本');
    expect(states.at(-1)?.worldLabel?.('JPN')?.text).toBe('东京');
  });

  it('国名 + 英文：题卡与标签都换成英文国名', () => {
    const { ctx, states, hints } = makeCtx();
    const mode = new ClickMode(ctx);
    mode.applyScopeQuery(scopeQuery('world'));
    mode.setQuestionNaming({ lang: 'en' });
    askAnswered(mode, unit('JPN', '日本', 'JPN'));
    expect(hints.at(-1)).toContain('Japan');
    expect(states.at(-1)?.worldLabel?.('JPN')?.text).toBe('Japan');
  });

  it('首都 + 英文：题卡与标签都换成英文首都名', () => {
    const { ctx, states, hints } = makeCtx();
    const mode = new ClickMode(ctx);
    mode.applyScopeQuery(scopeQuery('world'));
    mode.setQuestionNaming({ world: 'capital', lang: 'en' });
    askAnswered(mode, unit('JPN', '日本', 'JPN'));
    expect(hints.at(-1)).toContain('Tokyo');
    expect(states.at(-1)?.worldLabel?.('JPN')?.text).toBe('Tokyo');
  });

  it('数据缺该国的英名/首都名时回落中文名，不显示空标签', () => {
    const { ctx, states, hints } = makeCtx({ countryNames: {} });
    const mode = new ClickMode(ctx);
    mode.applyScopeQuery(scopeQuery('world'));
    mode.setQuestionNaming({ world: 'capital', lang: 'en' });
    askAnswered(mode, unit('JPN', '日本', 'JPN'));
    expect(hints.at(-1)).toContain('日本');
    expect(states.at(-1)?.worldLabel?.('JPN')?.text).toBe('日本');
  });

  it('国旗档：题面给国旗图片，且不含国名文本（alt 为空，不能把答案写在题面上）', () => {
    const { ctx, hints, states } = makeCtx();
    const mode = new ClickMode(ctx);
    mode.applyScopeQuery(scopeQuery('world'));
    mode.setQuestionNaming({ world: 'flag' });
    askAnswered(mode, unit('JPN', '日本', 'JPN'));
    const card = hints.at(-1)!;
    expect(card).toContain('data/flags/jp.svg');
    expect(card).toContain('<img');
    expect(card).toContain('alt=""');
    expect(card).not.toContain('日本');
    expect(card).not.toContain('东京');
    // 地图标签仍显示国名（国旗档只换题面）
    expect(states.at(-1)?.worldLabel?.('JPN')?.text).toBe('日本');
  });

  it('国旗档 + 英文：标签用英文国名，题面仍是国旗', () => {
    const { ctx, hints, states } = makeCtx();
    const mode = new ClickMode(ctx);
    mode.applyScopeQuery(scopeQuery('world'));
    mode.setQuestionNaming({ world: 'flag', lang: 'en' });
    askAnswered(mode, unit('JPN', '日本', 'JPN'));
    expect(hints.at(-1)).toContain('data/flags/jp.svg');
    expect(states.at(-1)?.worldLabel?.('JPN')?.text).toBe('Japan');
  });

  it('缺国旗资源时回落到国名题面（不给空白卡片/破图）', () => {
    const { ctx, hints } = makeCtx({ countryFlags: {} });
    const mode = new ClickMode(ctx);
    mode.applyScopeQuery(scopeQuery('world'));
    mode.setQuestionNaming({ world: 'flag' });
    askAnswered(mode, unit('JPN', '日本', 'JPN'));
    expect(hints.at(-1)).toContain('日本');
    expect(hints.at(-1)).not.toContain('<img');
  });

  it('选上国旗档就**立刻**开始预取整个出题池的国旗（不必等到点开始）', () => {
    const { ctx } = makeCtx();
    const mode = new ClickMode(ctx);
    mode.applyScopeQuery(scopeQuery('world'));
    expect(requestedFlags).toEqual([]); // 还没选国旗 → 一个请求都不该发
    mode.setQuestionNaming({ world: 'flag' });
    // 池子＝夹具里的两个国家（JPN/CHN）→ 两面旗都排队；顺序即池序
    expect([...requestedFlags].sort()).toEqual(['data/flags/cn.svg', 'data/flags/jp.svg']);
  });

  it('切到国名档会停掉预取队列（不做无用的后台下载）', () => {
    const { ctx } = makeCtx();
    const mode = new ClickMode(ctx);
    mode.applyScopeQuery(scopeQuery('world'));
    mode.setQuestionNaming({ world: 'flag' });
    expect(requestedFlags.length).toBe(2);
    mode.setQuestionNaming({ world: 'country' });
    expect(requestedFlags.length).toBe(2); // 没有新请求
  });

  it('国旗档答错：提示里的正确答案是国名（不是「国旗」这类占位文字）', () => {
    const { ctx, toasts } = makeCtx();
    const mode = new ClickMode(ctx);
    mode.applyScopeQuery(scopeQuery('world'));
    mode.setQuestionNaming({ world: 'flag' });
    const d = mode.diagnostics();
    d.question = 'JPN';
    d.answer(false, true);
    expect(toasts.at(-1)).toContain('日本');
  });

  it('地级档不受取名口径影响（沿用单位名）', () => {
    const { ctx, states, hints } = makeCtx();
    const mode = new ClickMode(ctx);
    mode.applyScopeQuery(scopeQuery('city'));
    mode.setQuestionNaming({ world: 'capital', lang: 'en', province: 'abbr' });
    askAnswered(mode, unit('310100', '上海市', '310000'));
    expect(hints.at(-1)).toContain('上海市');
    // 地级档不出省名标签系列
    expect(states.at(-1)?.provinceLabel).toBeUndefined();
  });
});

describe('点击模式 · 省级全国「省名 / 简称」', () => {
  it('省名档：题面=省全名，标签=去后缀省名（历史口径不变）', () => {
    const { ctx, states, hints } = makeCtx();
    const mode = new ClickMode(ctx);
    mode.applyScopeQuery(scopeQuery('province'));
    askAnswered(mode, unit('310000', '上海市', '310000'));
    expect(hints.at(-1)).toContain('上海市');
    expect(states.at(-1)?.provinceLabel?.('310000')?.text).toBe('上海');
  });

  it('简称档：题面与标签都是单字简称', () => {
    const { ctx, states, hints } = makeCtx();
    const mode = new ClickMode(ctx);
    mode.applyScopeQuery(scopeQuery('province'));
    mode.setQuestionNaming({ province: 'abbr' });
    askAnswered(mode, unit('310000', '上海市', '310000'));
    expect(hints.at(-1)).toContain('沪');
    expect(hints.at(-1)).not.toContain('上海');
    expect(states.at(-1)?.provinceLabel?.('310000')?.text).toBe('沪');
  });

  it('未作答的省仍然没有标签（口径只改文本、不改显隐规则）', () => {
    const { ctx, states } = makeCtx();
    const mode = new ClickMode(ctx);
    mode.applyScopeQuery(scopeQuery('province'));
    mode.setQuestionNaming({ province: 'abbr' });
    mode.refresh();
    expect(states.at(-1)?.provinceLabel?.('110000')).toBeNull();
  });
});

describe('输入模式 · 判题口径', () => {
  it('首都档只认首都名：国名不算对', () => {
    const ok = makeCtx();
    const mode = new InputMode(ok.ctx);
    mode.applyScopeQuery(scopeQuery('world'));
    mode.setQuestionNaming({ world: 'capital' });
    const d = mode.diagnostics();
    d.question = 'JPN';
    mode.onSubmit('东京');
    expect(d.green.has('JPN')).toBe(true);

    const bad = makeCtx();
    const mode2 = new InputMode(bad.ctx);
    mode2.applyScopeQuery(scopeQuery('world'));
    mode2.setQuestionNaming({ world: 'capital' });
    const d2 = mode2.diagnostics();
    d2.question = 'JPN';
    mode2.onSubmit('日本'); // 首都档答国名 → 判错
    expect(d2.green.has('JPN')).toBe(false);
    expect(d2.red.has('JPN')).toBe(true);
    // 提示里给出的「正确答案」也是当前口径（东京），不是国名
    expect(bad.toasts.at(-1)).toContain('东京');
  });

  it('世界档中英文都接受（同一个名字的两种写法，语言开关只换标签文字）', () => {
    const en = makeCtx();
    const mode = new InputMode(en.ctx);
    mode.applyScopeQuery(scopeQuery('world'));
    mode.setQuestionNaming({ lang: 'en' });
    const d = mode.diagnostics();
    d.question = 'JPN';
    mode.onSubmit('Japan'); // 英文
    expect(d.green.has('JPN')).toBe(true);

    const zh = makeCtx();
    const mode2 = new InputMode(zh.ctx);
    mode2.applyScopeQuery(scopeQuery('world'));
    mode2.setQuestionNaming({ lang: 'en' });
    const d2 = mode2.diagnostics();
    d2.question = 'JPN';
    mode2.onSubmit('日本'); // 英文档也接受中文写法
    expect(d2.green.has('JPN')).toBe(true);
  });

  it('简称档只认简称：省名不算对', () => {
    const ok = makeCtx();
    const mode = new InputMode(ok.ctx);
    mode.applyScopeQuery(scopeQuery('province'));
    mode.setQuestionNaming({ province: 'abbr' });
    const d = mode.diagnostics();
    d.question = '310000';
    mode.onSubmit('沪');
    expect(d.green.has('310000')).toBe(true);

    const bad = makeCtx();
    const mode2 = new InputMode(bad.ctx);
    mode2.applyScopeQuery(scopeQuery('province'));
    mode2.setQuestionNaming({ province: 'abbr' });
    const d2 = mode2.diagnostics();
    d2.question = '310000';
    mode2.onSubmit('上海'); // 简称档答省名 → 判错
    expect(d2.red.has('310000')).toBe(true);
  });

  it('占位提示跟着口径走（用户要知道该输入什么）', () => {
    const { ctx, placeholders } = makeCtx();
    const mode = new InputMode(ctx);
    mode.applyScopeQuery(scopeQuery('world'));
    mode.setQuestionNaming({ world: 'capital' });
    mode.setQuestionNaming({ lang: 'en' });
    expect(placeholders.at(-1)).toContain('首都');
    expect(placeholders.at(-1)).toContain('英文');
    mode.setQuestionNaming({ world: 'country' });
    expect(placeholders.at(-1)).toContain('英文国名');
  });

  it('省级档的占位提示切到简称口径后写「输入省简称」', () => {
    const { ctx, placeholders } = makeCtx();
    const mode = new InputMode(ctx);
    mode.applyScopeQuery(scopeQuery('province'));
    mode.setQuestionNaming({ province: 'abbr' });
    expect(placeholders.at(-1)).toContain('简称');
  });
});

describe('口径守卫与读取', () => {
  it('getQuestionNaming 返回当前口径的副本', () => {
    const { ctx } = makeCtx();
    const mode = new ClickMode(ctx);
    const naming = mode.getQuestionNaming();
    expect(naming).toEqual({ world: 'country', lang: 'zh', province: 'full' });
    naming.lang = 'en'; // 改副本不应影响模式状态
    expect(mode.getQuestionNaming().lang).toBe('zh');
  });

  it('答题进行中不接受切换（否则当前题的题面与答案会对不上）', () => {
    const { ctx } = makeCtx();
    const mode = new ClickMode(ctx);
    mode.applyScopeQuery(scopeQuery('world'));
    mode.diagnostics().started = true;
    mode.setQuestionNaming({ world: 'capital' });
    expect(mode.getQuestionNaming().world).toBe('country');
  });

  it('切到相同口径是空操作（不重复写盘、不重绘）', () => {
    const { ctx, states } = makeCtx();
    const mode = new ClickMode(ctx);
    mode.applyScopeQuery(scopeQuery('world'));
    const before = states.length;
    mode.setQuestionNaming({ world: 'country' });
    expect(states.length).toBe(before);
  });
});
