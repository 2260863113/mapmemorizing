import { describe, it, expect, afterEach, vi } from 'vitest';
import { ClickMode } from './click';
import { InputMode } from './input';
import { browseLabelState } from './browseLabels';
import type { ModeCtx } from './types';
import type { AppData, RenderState } from '../types';
import { makeAppData } from '../testFixture';
import { Matcher } from '../matcher';

/**
 * 「未开始时显示地图标签」的行为约束（2026-09：自由模式下线后并入前四个模式）。
 *
 * 用户口径：
 *   1. 未开始时显示**全量**地名（与自由模式一致：阈值 0，任何倍率都显示）；
 *   2. 开始后**清空** —— 但只清全量，已作答的绿/红标签保留（答题反馈不退化）；
 *   3. 结束时（结算卡片出现 / 答完 / 重置）复现；**暂停不算结束**；
 *   4. 粒度决定显示哪一层：世界=国名、省级全国=省名、其余（含省级全国下钻某省）=地级市名；
 *   5. 全局开关关掉时一片空白。
 */

const DATA_OVER: Partial<AppData> = {
  countries: [{ iso: 'JPN', name: '日本', fullName: '日本国', center: [138, 36], neighbors: [], continent: 'AS' }],
  countryNames: { JPN: { en: 'Japan', capital: '东京', capitalEn: 'Tokyo' } },
  provinces: [{ adcode: '440000', name: '广东省', center: [113, 23] }],
  units: [{ adcode: '440100', name: '广州市', shortName: '广州', province: '广东省', provinceAdcode: '440000', center: [113, 23], neighbors: [], decorative: false }],
  allUnits: [{ adcode: '440100', name: '广州市', shortName: '广州', province: '广东省', provinceAdcode: '440000', center: [113, 23], neighbors: [], decorative: false }],
};

function makeCtx(showBrowseLabels = true) {
  const states: RenderState[] = [];
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
  const data = makeAppData(DATA_OVER);
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
    search: { setPlaceholder: () => {}, setRequireEnter: () => {}, clear: () => {}, focus: () => {} },
    stats: {},
    settings: {
      darkMode: false,
      cityBoundaryTone: 'light',
      provinceBoundaryTone: 'dark',
      worldBoundaryTone: 'mid',
      ignoreTinyCountries: false,
      showBrowseLabels,
    },
    byAdcode: new Map(),
    toast: () => {},
    setHint: () => {},
    showTimer: () => {},
    showStopwatch: () => {},
    showSummary: () => {},
    hideSummary: () => {},
    updateProgress: () => {},
    randomUnit: (pool: never[]) => pool[0],
  } as unknown as ModeCtx;
  return { ctx, states };
}

/** 只落粒度、不走 enter（避免开始卡片的 DOM 依赖）。 */
const scopeQuery = (granularity: 'world' | 'province' | 'city') => ({
  granularity,
  continent: null,
  subregion: null,
  province: null,
});

const last = (states: RenderState[]) => states.at(-1)!;

describe('browseLabelState（纯函数）', () => {
  it('世界档：国名常显（阈值 0）', () => {
    expect(browseLabelState('world', true)).toEqual({ worldShowAllLabels: true, worldLabelZoomThreshold: 0 });
  });

  it('省级全国：省名常显', () => {
    expect(browseLabelState('provinceNation', true)).toEqual({ showAllProvinceLabels: true });
  });

  it('地级：地名常显（阈值 0）', () => {
    expect(browseLabelState('city', true)).toEqual({ showAllLabels: true, labelZoomThreshold: 0 });
  });

  it('开关关掉时是空片段（不留下任何标签开关）', () => {
    for (const scope of ['world', 'provinceNation', 'city'] as const) expect(browseLabelState(scope, false)).toEqual({});
  });
});

describe('点击/输入模式 · 未开始时的浏览标签', () => {
  it('世界档未开始：国名全量显示', () => {
    const { ctx, states } = makeCtx();
    const mode = new ClickMode(ctx);
    mode.applyScopeQuery(scopeQuery('world'));
    mode.refresh();
    expect(last(states).worldShowAllLabels).toBe(true);
    expect(last(states).worldLabelZoomThreshold).toBe(0);
  });

  it('省级全国未开始：省名全量显示', () => {
    const { ctx, states } = makeCtx();
    const mode = new ClickMode(ctx);
    mode.applyScopeQuery(scopeQuery('province'));
    mode.refresh();
    expect(last(states).showAllProvinceLabels).toBe(true);
  });

  it('市级未开始：地级市名全量显示', () => {
    const { ctx, states } = makeCtx();
    const mode = new ClickMode(ctx);
    mode.applyScopeQuery(scopeQuery('city'));
    mode.refresh();
    expect(last(states).showAllLabels).toBe(true);
    expect(last(states).labelZoomThreshold).toBe(0);
  });

  it('省级全国**下钻某省**后：未开始显示该省的地级市名（不是省名）', () => {
    const { ctx, states } = makeCtx();
    const mode = new ClickMode(ctx);
    mode.applyScopeQuery(scopeQuery('province'));
    mode.diagnostics().scopeProvince = '440000'; // 下钻某省（粒度仍是省级）
    mode.refresh();
    expect(last(states).showAllLabels).toBe(true);
    expect(last(states).showAllProvinceLabels).toBeUndefined();
  });

  it('输入模式同样生效（两个模式共用基类实现）', () => {
    const { ctx, states } = makeCtx();
    const mode = new InputMode(ctx);
    mode.applyScopeQuery(scopeQuery('world'));
    mode.refresh();
    expect(last(states).worldShowAllLabels).toBe(true);
  });

  it('全局开关关掉时不显示（老用户从自由模式迁移过来的偏好）', () => {
    const { ctx, states } = makeCtx(false);
    const mode = new ClickMode(ctx);
    mode.applyScopeQuery(scopeQuery('world'));
    mode.refresh();
    expect(last(states).worldShowAllLabels).toBeUndefined();
  });
});

describe('点击模式 · 开始后清空、结束后复现', () => {
  it('开始答题：全量标签清空，但**已作答的绿/红标签保留**', () => {
    const { ctx, states } = makeCtx();
    const mode = new ClickMode(ctx);
    mode.applyScopeQuery(scopeQuery('world'));
    const d = mode.diagnostics();
    d.green.add('JPN'); // 已作答
    d.started = true; // 答题进行中
    mode.refresh();
    expect(last(states).worldShowAllLabels).toBeUndefined();
    expect(last(states).worldLabelZoomThreshold).toBeUndefined();
    // 答题反馈还在：已作答国家仍有绿标签
    expect(last(states).worldLabel?.('JPN')?.text).toBe('日本');
  });

  it('暂停不算结束：仍不显示全量标签', () => {
    const { ctx, states } = makeCtx();
    const mode = new ClickMode(ctx);
    mode.applyScopeQuery(scopeQuery('world'));
    const d = mode.diagnostics();
    d.started = true;
    mode.pause(); // 内部：started 仍为 true，只是 paused
    mode.refresh();
    expect(last(states).worldShowAllLabels).toBeUndefined();
  });

  it('结算卡片弹出即复现（外壳调用 onSettlementShown）', () => {
    const { ctx, states } = makeCtx();
    const mode = new ClickMode(ctx);
    mode.applyScopeQuery(scopeQuery('world'));
    mode.diagnostics().started = true;
    mode.onSettlementShown();
    expect(last(states).worldShowAllLabels).toBe(true);
  });

  it('重置回开始状态：复现', () => {
    // onReset 会走 enter() → 开始卡片（真实 setHint 碰 DOM），故给一个最小 document 桩
    vi.stubGlobal('document', {
      getElementById: () => ({ classList: { toggle: () => {}, add: () => {}, remove: () => {} }, innerHTML: '' }),
    });
    const { ctx, states } = makeCtx();
    const mode = new ClickMode(ctx);
    mode.applyScopeQuery(scopeQuery('world'));
    mode.diagnostics().started = true;
    mode.onReset();
    expect(mode.isStarted()).toBe(false);
    expect(last(states).worldShowAllLabels).toBe(true);
    vi.unstubAllGlobals();
  });
});

describe('无尽闯关 · 未开始显示地名、开始后回到价格', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('未开始：显示全量地级市名（不再是一片空白）', async () => {
    vi.stubGlobal('document', { addEventListener: () => {} }); // 无尽构造函数挂了 keydown 监听
    const { EndlessMode } = await import('./endless');
    const { ctx, states } = makeCtx();
    const mode = new EndlessMode(ctx);
    mode.refresh();
    expect(last(states).showAllLabels).toBe(true);
    expect(last(states).labelZoomThreshold).toBe(0);
    expect(last(states).coin).toBeUndefined();
  });

  it('关掉全局开关：未开始也不显示地名', async () => {
    vi.stubGlobal('document', { addEventListener: () => {} });
    const { EndlessMode } = await import('./endless');
    const { ctx, states } = makeCtx(false);
    const mode = new EndlessMode(ctx);
    mode.refresh();
    expect(last(states).showAllLabels).toBeUndefined();
  });
});
