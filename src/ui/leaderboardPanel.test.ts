import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { LeaderboardPanel } from './leaderboardPanel';
import { makeAppData } from '../testFixture';
import type { LeaderboardEntry, LeaderboardStore } from '../leaderboardStore';

/**
 * 侧栏排行榜的渲染约定（本轮补：此前面板**一个测试都没有**）。
 *
 * 用户报的现象是「切换模式/下钻/返回顶级时排行榜有时候不切换」。根因之一是刷新触发点漏发，
 * 但**面板本身**也有一份责任：旧实现是"先把上一份名单留在屏幕上，等新数据回来再整体替换"，
 * 于是任何一次请求慢或失败，看起来都像"榜没跟着范围走"。这里用假 DOM 钉住四条约定：
 *   1. 没看过的范围：标题立刻换新 + 显示「加载中」，绝不能留着上一个范围的名单；
 *   2. 看过的范围：先用快照立刻渲染，后台刷新回来再替换；
 *   3. 快速连续切换时，先发后到的响应不得覆盖后发的渲染（renderSeq 守卫）；
 *   4. 后台刷新失败时保留已有内容，不把屏幕顶成错误页；只有"什么都没有"才显示失败。
 */

interface FakeEl {
  innerHTML: string;
}

class FakeStore {
  snapshot = new Map<string, LeaderboardEntry[]>();
  calls: string[] = [];
  /** 每次 ensure 依次取一个响应工厂；用尽则返回空榜。 */
  queue: Array<() => Promise<LeaderboardEntry[]>> = [];

  peek(mode: string, scope: string | null): LeaderboardEntry[] | null {
    return this.snapshot.get(`${mode}:${scope ?? ''}`) ?? null;
  }

  ensure(mode: string, scope: string | null): Promise<LeaderboardEntry[]> {
    this.calls.push(`${mode}:${scope ?? ''}`);
    const next = this.queue.shift();
    return next ? next() : Promise.resolve([]);
  }
}

function entry(username: string): LeaderboardEntry {
  return {
    id: username,
    username,
    mode: 'click',
    scopeProvince: null,
    scopeLabel: '全国',
    totalUnits: 340,
    correct: 12,
    elapsedMs: 65_000,
    submittedAt: 1,
    hometown: null,
    avatar: null,
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let container: FakeEl;

beforeEach(() => {
  container = { innerHTML: '' };
  vi.stubGlobal('document', { getElementById: () => container });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function makePanel(store: FakeStore) {
  return new LeaderboardPanel('leaderboard', store as unknown as LeaderboardStore, makeAppData());
}

describe('LeaderboardPanel · 范围切换时的渲染', () => {
  it('没看过的范围：立刻换成新范围的标题 + 加载中，不留上一个范围的名单', async () => {
    const store = new FakeStore();
    const d = deferred<LeaderboardEntry[]>();
    store.queue.push(() => d.promise);
    const panel = makePanel(store);

    const p = panel.refresh('click', '__world_nation__', '世界');
    // refresh 的同步前缀必须已经把占位画好（还没等网络）
    expect(container.innerHTML).toContain('世界排行榜');
    expect(container.innerHTML).toContain('加载中');
    expect(container.innerHTML).not.toContain('上一个范围的人名');

    d.resolve([entry('linhao')]);
    await p;
    expect(container.innerHTML).toContain('linhao');
    expect(container.innerHTML).not.toContain('加载中');
  });

  it('看过的范围：先用快照立刻渲染（秒显），后台刷新回来再替换成新数据', async () => {
    const store = new FakeStore();
    const d = deferred<LeaderboardEntry[]>();
    store.snapshot.set('click:', [entry('旧的')]);
    store.queue.push(() => d.promise);
    const panel = makePanel(store);

    const p = panel.refresh('click', null, '全国');
    // 请求还没回来，屏幕上已经是这个范围的快照，而不是"加载中"
    expect(container.innerHTML).toContain('旧的');
    expect(container.innerHTML).not.toContain('加载中');

    d.resolve([entry('新的')]);
    await p;
    expect(container.innerHTML).toContain('新的');
    expect(container.innerHTML).not.toContain('旧的');
  });

  it('快速连续切换：先发出、后返回的响应被丢弃，不覆盖后发的那次渲染', async () => {
    const store = new FakeStore();
    const slow = deferred<LeaderboardEntry[]>();
    const fast = deferred<LeaderboardEntry[]>();
    store.queue.push(() => slow.promise, () => fast.promise);
    const panel = makePanel(store);

    const pSlow = panel.refresh('click', '440000', '广东'); // 先发，后到
    const pFast = panel.refresh('click', '330000', '浙江'); // 后发，先到

    fast.resolve([entry('浙江榜')]);
    await pFast;
    expect(container.innerHTML).toContain('浙江榜');

    slow.resolve([entry('广东榜')]);
    await pSlow; // 过期响应：不得写 DOM
    expect(container.innerHTML).toContain('浙江榜');
    expect(container.innerHTML).not.toContain('广东榜');
  });

  it('后台刷新失败但已有快照：保留已有内容，不顶成错误页', async () => {
    const store = new FakeStore();
    store.snapshot.set('click:', [entry('已有的')]);
    store.queue.push(() => Promise.reject(new Error('boom')));
    const panel = makePanel(store);

    await panel.refresh('click', null, '全国');
    expect(container.innerHTML).toContain('已有的');
    expect(container.innerHTML).not.toContain('加载失败');
  });

  it('什么都没有且请求失败：才显示加载失败', async () => {
    const store = new FakeStore();
    store.queue.push(() => Promise.reject(new Error('boom')));
    const panel = makePanel(store);

    await panel.refresh('click', null, '全国');
    expect(container.innerHTML).toContain('加载失败');
    expect(container.innerHTML).toContain('全国排行榜');
  });

  it('空榜显示「暂无成绩」（拼图在不可提交范围内的常态）', async () => {
    const store = new FakeStore();
    store.queue.push(() => Promise.resolve([]));
    const panel = makePanel(store);

    await panel.refresh('puzzle', '__province_nation__', '省级全国');
    expect(container.innerHTML).toContain('拼图模式 省级全国排行榜');
    expect(container.innerHTML).toContain('暂无成绩');
  });
});
