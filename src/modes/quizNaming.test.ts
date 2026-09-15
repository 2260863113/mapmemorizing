import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ClickMode } from './click';
import { InputMode } from './input';
import type { AppData, CountryMeta, Province, RenderState, Unit } from '../types';
import { makeTestCtx } from '../testCtx';
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
/**
 * `start()` 会碰 `window.setInterval`（秒表）与 `localStorage`（进度/口径记忆），node 测试环境两者都没有。
 * 给最小替身：秒表只要"能起能停"，存储只要"能读写不报错"。每个用例前清空，保证口径不跨用例串。
 */
const storage = new Map<string, string>();
beforeEach(() => {
  requestedFlags.length = 0;
  storage.clear();
  resetFlagPreloadForTest(); // 预取队列是模块级状态，测试之间必须复位，否则 done 集合会串
  vi.stubGlobal('Image', ImmediateImage);
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, String(v)),
    removeItem: (k: string) => void storage.delete(k),
  });
  vi.stubGlobal('window', { setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {} });
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

/** 省级口径用的夹具：补一个真正的省（河北省 → 石家庄/冀/河北），否则省会档只能拿直辖市自证。 */
const PROVINCE_DATA: Partial<AppData> = {
  provinces: [...PROVINCES, { adcode: '130000', name: '河北省', center: [114.5, 38] }],
};

function unit(adcode: string, name: string, provinceAdcode: string): Unit {
  return { adcode, name, shortName: name, province: 'P', provinceAdcode, center: [0, 0], neighbors: [], decorative: false };
}

const UNITS = [unit('310100', '上海市', '310000'), unit('110100', '北京市', '110000')];

/**
 * 预取口径用的夹具：**6 个国家**（够看出"只缓存接下来两道"）+ 确定的题序。
 * `randomUnit` 取池首 → 题序恒为 JPN → CHN → KOR → MNG → IND → THA。
 */
const LOOKAHEAD_A2: Record<string, string> = { JPN: 'jp', CHN: 'cn', KOR: 'kr', MNG: 'mn', IND: 'in', THA: 'tha' };
const LOOKAHEAD_DATA: Partial<AppData> = {
  countries: Object.keys(LOOKAHEAD_A2).map((iso) => ({
    iso,
    name: iso,
    fullName: iso,
    center: [0, 0] as [number, number],
    neighbors: [],
    continent: 'AS' as const,
  })),
  countryFlags: Object.fromEntries(Object.entries(LOOKAHEAD_A2).map(([iso, a2]) => [iso, `${a2}.svg`])),
  countryFlagThumbs: Object.fromEntries(Object.entries(LOOKAHEAD_A2).map(([iso, a2]) => [iso, `${a2}.webp`])),
};

function makeCtx(over: Partial<AppData> = {}) {
  return makeTestCtx({
    data: {
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
    },
  });
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

  /**
   * 国旗预取口径（2026-09 第二轮）：**只缓存接下来两个**。
   *
   * 上一版是"选上国旗档就把整个出题池排进队列"（世界全国 194 面 1.21MB），用户口径改为
   * 「不一次性全量缓存，仅仅缓存接下来两个国旗」。要"知道接下来考哪两面"，点击模式把选题
   * 提前了一步（见 click.ts 的 lookahead 说明），于是每换一题只多一次请求、且那一面**必然**用得上。
   */
  it('选上国旗档不预取整个池（未开始、还没选题 → 一个请求都不发）', () => {
    const { ctx } = makeCtx();
    const mode = new ClickMode(ctx);
    mode.applyScopeQuery(scopeQuery('world'));
    mode.setQuestionNaming({ world: 'flag' });
    expect(requestedFlags).toEqual([]);
  });

  it('切到国名档会停掉预取队列（不做无用的后台下载）', () => {
    const { ctx } = makeCtx(LOOKAHEAD_DATA);
    const mode = new ClickMode(ctx);
    mode.applyScopeQuery(scopeQuery('world'));
    mode.setQuestionNaming({ world: 'flag' });
    mode.diagnostics().start(false);
    const afterStart = requestedFlags.length;
    expect(afterStart).toBe(3); // 当前题 + 接下来两道
    mode.diagnostics().started = false;
    mode.setQuestionNaming({ world: 'country' });
    mode.diagnostics().start(false);
    expect(requestedFlags.length).toBe(afterStart); // 没有新请求
  });

  it('开始后立刻排上「首题 + 接下来两道」三面国旗（不是整池 6 面）', () => {
    const { ctx } = makeCtx(LOOKAHEAD_DATA);
    const mode = new ClickMode(ctx);
    mode.applyScopeQuery(scopeQuery('world'));
    mode.setQuestionNaming({ world: 'flag' });
    mode.diagnostics().start(false);
    // 首题 JPN（randomUnit 取池首），接下来两道按池序是 CHN/KOR
    expect(requestedFlags).toEqual(['data/flags/jp.svg', 'data/flags/cn.svg', 'data/flags/kr.svg']);
    // 池里还有 MNG/IND/THA 三国：一面都没请求（它们还不是"接下来两道"）
    expect(requestedFlags).not.toContain('data/flags/tha.svg');
  });

  it('每换一题只多请求一面，且那一面就是**下一题**的旗（换题不再等网络）', () => {
    const { ctx } = makeCtx(LOOKAHEAD_DATA);
    const mode = new ClickMode(ctx);
    mode.applyScopeQuery(scopeQuery('world'));
    mode.setQuestionNaming({ world: 'flag' });
    mode.diagnostics().start(false);
    const d = mode.diagnostics();
    expect(d.question).toBe('JPN');

    d.answer(true, true); // 答对 → 换到预选好的 CHN
    expect(d.question).toBe('CHN');
    // 换题时它的旗**早就在队列里**（上一轮预取的），本轮只补 1 面（MNG）
    expect(requestedFlags).toEqual([
      'data/flags/jp.svg',
      'data/flags/cn.svg',
      'data/flags/kr.svg',
      'data/flags/mn.svg',
    ]);

    d.answer(true, true); // 再换一题 → KOR
    expect(d.question).toBe('KOR');
    expect(requestedFlags).toEqual([
      'data/flags/jp.svg',
      'data/flags/cn.svg',
      'data/flags/kr.svg',
      'data/flags/mn.svg',
      'data/flags/in.svg',
    ]);
    // 第 6 国（THA）始终没被请求：始终只缓存"当前 + 接下来两道"
    expect(requestedFlags).not.toContain('data/flags/tha.svg');
  });

  it('非国旗档不做预选（预选只为预取国旗而存在）', () => {
    const { ctx } = makeCtx(LOOKAHEAD_DATA);
    const mode = new ClickMode(ctx);
    mode.applyScopeQuery(scopeQuery('world'));
    mode.diagnostics().start(false); // 默认国名档
    expect(requestedFlags).toEqual([]);
    // 预选也没吃随机数：换题仍是"真选"那一次
    mode.diagnostics().answer(true, true);
    expect(requestedFlags).toEqual([]);
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

describe('未开始的浏览标签 · 按取名口径显示', () => {
  /** 未开始（浏览态）时地图上那份全量标签的渲染状态。 */
  const browse = (mode: ClickMode | InputMode) => {
    mode.refresh();
    return mode;
  };
  const contentOf = (states: RenderState[], id: string) => states.at(-1)?.browseLabel?.(id) ?? null;

  it('世界档 + 首都：标签写首都名（用户口径：选「首都」地图标签就显示首都）', () => {
    const { ctx, states } = makeCtx();
    const mode = new ClickMode(ctx);
    mode.applyScopeQuery(scopeQuery('world'));
    mode.setQuestionNaming({ world: 'capital' });
    browse(mode);
    expect(contentOf(states, 'JPN')).toEqual({ text: '东京' });
  });

  it('世界档 + 国名 + 英文：标签写英文国名', () => {
    const { ctx, states } = makeCtx();
    const mode = new ClickMode(ctx);
    mode.applyScopeQuery(scopeQuery('world'));
    mode.setQuestionNaming({ lang: 'en' });
    browse(mode);
    expect(contentOf(states, 'JPN')).toEqual({ text: 'Japan' });
  });

  it('世界档 + 国旗：标签画**国旗缩略图**（不是国名，也不是原始 SVG）', () => {
    const { ctx, states } = makeCtx(LOOKAHEAD_DATA);
    const mode = new ClickMode(ctx);
    mode.applyScopeQuery(scopeQuery('world'));
    mode.setQuestionNaming({ world: 'flag' });
    browse(mode);
    const jp = contentOf(states, 'JPN');
    expect(jp).toEqual({ image: 'data/flags/thumbs/jp.webp' });
  });

  it('世界档 + 国旗但缺缩略图数据：回落国名文本（不画破图、也不留空白）', () => {
    const { ctx, states } = makeCtx(); // 夹具没给 countryFlagThumbs
    const mode = new ClickMode(ctx);
    mode.applyScopeQuery(scopeQuery('world'));
    mode.setQuestionNaming({ world: 'flag' });
    browse(mode);
    // 口径注册表直接给出国名文本（渲染结果与旧版一致：旧版返回 null、由渲染层回落国名；
    // 现在"国旗档的文字口径 = 国名"写在表里，不依赖渲染层的兜底）
    expect(contentOf(states, 'JPN')).toEqual({ text: '日本' });
  });

  it('输入模式同样按口径显示（用户口径点名了点击与输入两个模式）', () => {
    const { ctx, states } = makeCtx(LOOKAHEAD_DATA);
    const mode = new InputMode(ctx);
    mode.applyScopeQuery(scopeQuery('world'));
    mode.setQuestionNaming({ world: 'capital' });
    browse(mode);
    expect(contentOf(states, 'JPN')).toEqual({ text: '东京' }); // 输入模式同样按口径写首都名
    mode.setQuestionNaming({ world: 'flag' });
    browse(mode);
    expect(contentOf(states, 'JPN')).toEqual({ image: 'data/flags/thumbs/jp.webp' });
  });

  it('省级全国：省名档 = 去后缀省名 / 省会档 = 省会名 / 简称档 = 单字简称', () => {
    const { ctx, states } = makeCtx(PROVINCE_DATA);
    const mode = new ClickMode(ctx);
    mode.applyScopeQuery(scopeQuery('province'));
    browse(mode);
    expect(contentOf(states, '130000')).toEqual({ text: '河北' }); // 历史默认（标签一直是去后缀省名）
    mode.setQuestionNaming({ province: 'capital' });
    browse(mode);
    expect(contentOf(states, '130000')).toEqual({ text: '石家庄' });
    mode.setQuestionNaming({ province: 'abbr' });
    browse(mode);
    expect(contentOf(states, '130000')).toEqual({ text: '冀' });
  });

  it('地级档不受口径影响（地级单位没有别的叫法，返回 null → 渲染层写单位名）', () => {
    const { ctx, states } = makeCtx(PROVINCE_DATA);
    const mode = new ClickMode(ctx);
    mode.applyScopeQuery(scopeQuery('city'));
    mode.setQuestionNaming({ province: 'abbr' });
    browse(mode);
    expect(contentOf(states, '310100')).toBeNull();
  });

  it('开始答题后不再有浏览标签（口径只改浏览态内容，不改显隐规则）', () => {
    const { ctx, states } = makeCtx(LOOKAHEAD_DATA);
    const mode = new ClickMode(ctx);
    mode.applyScopeQuery(scopeQuery('world'));
    mode.setQuestionNaming({ world: 'flag' });
    mode.diagnostics().start(false);
    expect(states.at(-1)?.browseLabel).toBeUndefined();
  });
});

describe('省级全国 · 省会档', () => {
  it('点击模式：题面与标签都是省会名', () => {
    const { ctx, states, hints } = makeCtx(PROVINCE_DATA);
    const mode = new ClickMode(ctx);
    mode.applyScopeQuery(scopeQuery('province'));
    mode.setQuestionNaming({ province: 'capital' });
    askAnswered(mode, unit('130000', '河北省', '130000'));
    expect(hints.at(-1)).toContain('石家庄');
    expect(hints.at(-1)).not.toContain('河北');
    expect(states.at(-1)?.provinceLabel?.('130000')?.text).toBe('石家庄');
  });

  it('输入模式：只认省会名（含「市」后缀），省名与简称不算对', () => {
    const accept = (answer: string) => {
      const { ctx } = makeCtx(PROVINCE_DATA);
      const mode = new InputMode(ctx);
      mode.applyScopeQuery(scopeQuery('province'));
      mode.setQuestionNaming({ province: 'capital' });
      const d = mode.diagnostics();
      d.question = '130000';
      mode.onSubmit(answer);
      return d.green.has('130000');
    };
    expect(accept('石家庄')).toBe(true);
    expect(accept('石家庄市')).toBe(true); // 同一个名字的两种写法（行政后缀）
    expect(accept('河北')).toBe(false);
    expect(accept('冀')).toBe(false);
  });

  it('直辖市/特区的省会就是它自己（数据如此，不做特判）；占位提示写「输入省会名」', () => {
    const { ctx, placeholders } = makeCtx(PROVINCE_DATA);
    const mode = new InputMode(ctx);
    mode.applyScopeQuery(scopeQuery('province'));
    mode.setQuestionNaming({ province: 'capital' });
    expect(placeholders.at(-1)).toContain('省会');
    const d = mode.diagnostics();
    d.question = '310000'; // 上海市
    mode.onSubmit('上海');
    expect(d.green.has('310000')).toBe(true);
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
