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
