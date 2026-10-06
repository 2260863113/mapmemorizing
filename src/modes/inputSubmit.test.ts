import { describe, it, expect, afterEach, vi } from 'vitest';
import { InputMode } from './input';
import { makeTestCtx } from '../testCtx';
import type { AppData } from '../types';

/**
 * 输入模式的「提交」与「Tab 即时重开」（2026-09 需求 1/7/9 的落点）。
 *
 * 三件事在这里锁住：
 *   1. **空 Enter 计答错**（需求 7）：空串/纯空格提交是一个明确的错误动作，不是"什么都没发生"；
 *      而 `onInput`（边打边匹配）仍要求非空，否则清空输入框会自动判错。
 *   2. **lastAnswered 对错都更新**（需求 9）：顺序模式的邻接优先要跟"刚答完的那题"，
 *      答错也跟 —— 只在答对时更新会让答错后的题序乱跳。
 *   3. **quickRestart 立刻重开且不弹结算**（需求 1）：进度归零、首题重新出、暂停态也能重开。
 */

const UNIT_A = { adcode: '440100', name: '广州市', shortName: '广州', province: '广东省', provinceAdcode: '440000', center: [113, 23] as [number, number], neighbors: ['440300'], decorative: false };
const UNIT_B = { adcode: '440300', name: '深圳市', shortName: '深圳', province: '广东省', provinceAdcode: '440000', center: [114, 22.5] as [number, number], neighbors: ['440100'], decorative: false };

const DATA: Partial<AppData> = {
  provinces: [{ adcode: '440000', name: '广东省', center: [113, 23] }],
  units: [UNIT_A, UNIT_B],
  allUnits: [UNIT_A, UNIT_B],
};

/** 起一个市级粒度的输入模式。 */
function makeMode() {
  const { ctx, toasts } = makeTestCtx({ data: DATA });
  const summaries: string[] = [];
  ctx.showSummary = (html) => {
    summaries.push(html);
  };
  const mode = new InputMode(ctx);
  mode.applyScopeQuery({ granularity: 'city', continent: null, subregion: null, province: null });
  return { mode, toasts, summaries };
}

/**
 * 走 `start(false)`。
 *
 * 走 `diagnostics().start` 而不是 `mode.start`：基类的 `start` 是 protected（只给子类用），
 * 测试从外部拿不到；诊断视图是**编译器可校验**的那条口子（见 quizDiagnostics.ts 的说明）。
 */
function startMode(mode: InputMode) {
  mode.diagnostics().start(false);
}

/** start() 需要 window（秒表用 setInterval）与 document（开始卡片要写 DOM）。 */
function stubBrowserGlobals() {
  vi.stubGlobal('window', { setInterval: () => 1, clearInterval: () => {}, clearTimeout: () => {}, setTimeout: () => 1 });
  vi.stubGlobal('document', {
    getElementById: () => ({ classList: { toggle: () => {}, add: () => {}, remove: () => {} }, innerHTML: '', onclick: null }),
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('输入模式 · 空 Enter 也能确定（需求 7）', () => {
  it('空串提交计为答错：进度留红、fail+1、并进入下一题', () => {
    stubBrowserGlobals();
    const { mode, toasts } = makeMode();
    startMode(mode);
    const d = mode.diagnostics();
    const first = d.question as string;
    expect(first).toBe(UNIT_A.adcode);

    mode.onSubmit('');
    expect(d.fail).toBe(1);
    expect(d.red.has(first)).toBe(true);
    expect(d.results).toEqual(['red']);
    expect(toasts.at(-1)).toContain('广州'); // 答错提示给出正确答案
    expect(d.question).toBe(UNIT_B.adcode); // 空提交也照样推进题序
  });

  it('纯空格同样算提交（不是"没输入"）', () => {
    stubBrowserGlobals();
    const { mode } = makeMode();
    startMode(mode);
    const d = mode.diagnostics();
    mode.onSubmit('   ');
    expect(d.fail).toBe(1);
    expect(d.red.size).toBe(1);
  });

  it('非空但答错仍然只算一次错（空提交不改变原有判题路径）', () => {
    stubBrowserGlobals();
    const { mode } = makeMode();
    startMode(mode);
    const d = mode.diagnostics();
    mode.onSubmit('不存在的名字');
    expect(d.fail).toBe(1);
    expect(d.results).toEqual(['red']);
  });

  it('onInput 保持空串不自动提交（否则清空输入框就会自动判错）', () => {
    stubBrowserGlobals();
    const { mode } = makeMode();
    startMode(mode);
    const d = mode.diagnostics();
    mode.onInput('');
    expect(d.fail).toBe(0);
    expect(d.results).toEqual([]);
    expect(d.question).toBe(UNIT_A.adcode); // 题目没动
  });

  it('暂停中 / 回滚中 / 无题目的守卫仍在（空提交不会绕过它们）', () => {
    stubBrowserGlobals();
    const { mode } = makeMode();
    startMode(mode);
    const d = mode.diagnostics();
    // 暂停中：任何提交都不算
    mode.pause();
    mode.onSubmit('');
    expect(d.fail).toBe(0);
    mode.resume();

    // 错误回滚展示中（rollbacking）：空提交也不接受
    d.errorRollback = true;
    mode.onSubmit(''); // 第一次答错 → 进入回滚态、计一次 fail
    expect(d.fail).toBe(1);
    expect(d.rollbacking).toBe(true);
    mode.onSubmit('');
    expect(d.fail).toBe(1); // 回滚期间的空提交被守卫丢掉

    // 没有当前题目：也不接受
    d.errorRollback = false;
    d.question = null;
    mode.onSubmit('');
    expect(d.fail).toBe(1);
  });
});

describe('输入模式 · lastAnswered 对错都更新（需求 9 的接线）', () => {
  it('答对后更新为刚答的那题', () => {
    stubBrowserGlobals();
    const { mode } = makeMode();
    startMode(mode);
    const order = mode.orderDiagnostics();
    expect(order.lastAnswered).toBe(null);
    mode.onSubmit('广州市');
    expect(order.lastAnswered).toBe(UNIT_A.adcode);
    expect(order.lastGreen).toBe(UNIT_A.adcode); // 这条仍只在答对时更新
  });

  it('答错后同样更新（这是它与 lastGreen 的区别）', () => {
    stubBrowserGlobals();
    const { mode } = makeMode();
    startMode(mode);
    const order = mode.orderDiagnostics();
    mode.onSubmit(''); // 空提交 = 答错
    expect(order.lastAnswered).toBe(UNIT_A.adcode);
    expect(order.lastGreen).toBe(null); // 答错不更新"上次答对"
  });

  it('重置（onReset）后清空：新会话不带着上一局的参考点', () => {
    stubBrowserGlobals();
    const { mode } = makeMode();
    startMode(mode);
    mode.onSubmit('');
    expect(mode.orderDiagnostics().lastAnswered).toBe(UNIT_A.adcode);
    mode.onReset();
    expect(mode.orderDiagnostics().lastAnswered).toBe(null);
  });
});

describe('输入模式 · quickRestart（Tab 即时重开，需求 1）', () => {
  it('进度归零、首题重新出、并且**不弹结算/成绩**', () => {
    stubBrowserGlobals();
    const { mode, summaries } = makeMode();
    startMode(mode);
    mode.onSubmit(''); // 先留下一点进度（红格）
    expect(mode.getProgress()?.segments.some((s) => s !== 'pending')).toBe(true);

    const handled = mode.quickRestart();
    expect(handled).toBe(true);
    expect(mode.isStarted()).toBe(true);
    expect(mode.isPaused()).toBe(false);
    expect(mode.getProgress()?.segments.every((s) => s === 'pending')).toBe(true);
    expect(mode.getProgress()?.total).toBe(2);
    expect(mode.diagnostics().question).toBe(UNIT_A.adcode);
    expect(summaries).toEqual([]); // Tab 不提交、不弹卡片
  });

  it('暂停态也能重开（exit 先清掉 paused，否则 canStart 会拦住输入模式）', () => {
    stubBrowserGlobals();
    const { mode } = makeMode();
    startMode(mode);
    mode.pause();
    expect(mode.isPaused()).toBe(true);
    expect(mode.quickRestart()).toBe(true);
    expect(mode.isPaused()).toBe(false);
    expect(mode.isStarted()).toBe(true);
  });

  it('未开始时按 Tab = 直接开局（"立刻重新即开始"）', () => {
    stubBrowserGlobals();
    const { mode } = makeMode();
    // 不调用 start：模拟停在开始卡片上
    expect(mode.isStarted()).toBe(false);
    expect(mode.quickRestart()).toBe(true);
    expect(mode.isStarted()).toBe(true);
  });
});

/**
 * 自动跟随的**接线**（2026-09 需求 8 修订版）：模式侧只负责"乘多少系数"，
 * 真倍率由渲染器算（基准 × 系数 → 夹取）。系数本身在 `map/followScale.test.ts` 里逐档断言；
 * 这里锁的是**模式真的把系数传下去了** —— 一个漏传/传错位置的接线，
 * 界面上只表现为"镜头有点近/有点远"，别的测试全绿也发现不了。
 */
describe('输入模式 · 自动跟随把倍率系数交给渲染器（需求 8 修订版）', () => {
  /** 世界档可能用到的两个国家：一个欧洲（通用档）、一个非洲（0.5 档）。 */
  const COUNTRIES = [
    { iso: 'FRA', name: '法国', fullName: '法兰西共和国', center: [2, 46] as [number, number], neighbors: [], continent: 'EU' as const },
    { iso: 'ZAF', name: '南非', fullName: '南非共和国', center: [24, -29] as [number, number], neighbors: [], continent: 'AF' as const },
  ];

  /** 记录 `focusUnit` / `focusWorldCountry` 收到的第 2 个参数（系数）。 */
  function recordingCtx(data: Partial<AppData>) {
    const { ctx } = makeTestCtx({ data, randomUnit: (pool) => pool[0] });
    const seen = { unit: [] as [string, number | undefined][], world: [] as [string, number | undefined][] };
    const renderer = ctx.renderer as unknown as {
      focusUnit: (adcode: string, scale?: number) => void;
      focusWorldCountry: (iso: string, scale?: number) => void;
    };
    renderer.focusUnit = (adcode, scale) => seen.unit.push([adcode, scale]);
    renderer.focusWorldCountry = (iso, scale) => seen.world.push([iso, scale]);
    return { ctx, seen };
  }

  it('中国地级：传 ×0.75 系数（不是绝对倍率、也不是加法）', () => {
    stubBrowserGlobals();
    const { ctx, seen } = recordingCtx(DATA);
    const mode = new InputMode(ctx);
    mode.applyScopeQuery({ granularity: 'city', continent: null, subregion: null, province: null });
    startMode(mode);
    expect(seen.unit).toEqual([[UNIT_A.adcode, 0.75]]);
  });

  it('世界档普通国：传 ×0.75', () => {
    stubBrowserGlobals();
    const { ctx, seen } = recordingCtx({ countries: COUNTRIES });
    const mode = new InputMode(ctx);
    mode.applyScopeQuery({ granularity: 'world', continent: null, subregion: null, province: null });
    startMode(mode);
    expect(seen.world).toEqual([['FRA', 0.75]]);
  });

  it('世界档非洲国：传 ×0.5（池首换成南非）', () => {
    stubBrowserGlobals();
    const { ctx, seen } = recordingCtx({ countries: COUNTRIES });
    // 让首题落在池尾（南非）——题序由夹具的 randomUnit 决定，故这里直接换掉它
    (ctx as unknown as { randomUnit: (pool: { adcode: string }[]) => { adcode: string } }).randomUnit = (pool) => pool[pool.length - 1];
    const mode = new InputMode(ctx);
    mode.applyScopeQuery({ granularity: 'world', continent: null, subregion: null, province: null });
    startMode(mode);
    expect(seen.world).toEqual([['ZAF', 0.5]]);
  });

  it('自动跟随关闭时一次也不聚焦（系数与镜头都不该动）', () => {
    stubBrowserGlobals();
    const { ctx, seen } = recordingCtx(DATA);
    // 模式设置里的「自动跟随」默认开；这里模拟用户关掉它
    // （该开关由 loadSelfAutoFollow 从 localStorage 读，测试环境无 localStorage → 默认 true，
    //  故走 setModeSettings 的 onChange 那条公开路径把字段改掉）
    const mode = new InputMode(ctx);
    mode.applyScopeQuery({ granularity: 'city', continent: null, subregion: null, province: null });
    mode.getModeSettings()?.onChange('auto-follow', false);
    startMode(mode);
    expect(seen.unit).toEqual([]);
  });
});
