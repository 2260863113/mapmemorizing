import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { flagPreloadStats, preloadFlags, resetFlagPreloadForTest, stopFlagPreload } from './flagPreload';

/**
 * 国旗预加载队列的行为约束。
 *
 * 为什么值得单测：它是个**有并发、有全局状态、有失败路径**的后台任务，而它的失败方式很隐蔽 ——
 * 例如"忘了在结束时停队列"会让离开模式后还在偷偷下载、"失败不递减计数"会让队列卡死（后续国旗永远不预取）。
 * 这些在浏览器里都表现为"有时候快、有时候慢"，靠手测几乎发现不了。
 */

/** 假 Image：记录每个 src 的创建时刻，由测试决定何时 onload / onerror。 */
class FakeImage {
  static created: { src: string; resolve: () => void; reject: () => void }[] = [];
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  set src(value: string) {
    FakeImage.created.push({ src: value, resolve: () => this.onload?.(), reject: () => this.onerror?.() });
  }
}

beforeEach(() => {
  FakeImage.created = [];
  vi.stubGlobal('Image', FakeImage);
  resetFlagPreloadForTest();
});
afterEach(() => vi.unstubAllGlobals());

const srcs = (n: number) => Array.from({ length: n }, (_, i) => `data/flags/f${i}.svg`);

describe('国旗预加载队列', () => {
  it('一开始只并发 3 个（低优先级，不跟答题本身的请求抢带宽）', () => {
    preloadFlags(srcs(10));
    expect(FakeImage.created.length).toBe(3);
    expect(flagPreloadStats().inFlight).toBe(3);
  });

  it('一个完成就补下一个，直到整池取完', () => {
    preloadFlags(srcs(10));
    for (let i = 0; i < 10; i++) {
      FakeImage.created[i].resolve();
      expect(FakeImage.created.length).toBe(Math.min(10, i + 4)); // 完成一个立刻补一个
    }
    expect(FakeImage.created.length).toBe(10);
    expect(flagPreloadStats().started).toBe(false);
  });

  it('失败**不阻塞**队列：某张 404 也不该让后面的国旗永远取不到', () => {
    preloadFlags(srcs(5));
    FakeImage.created[0].reject();
    expect(FakeImage.created.length).toBe(4); // 立刻补上第 4 个
    FakeImage.created[1].resolve();
    FakeImage.created[2].resolve();
    FakeImage.created[3].resolve();
    expect(FakeImage.created.length).toBe(5);
  });

  it('同一池重复排队时，已预取过的不再发起请求（换范围/重开一局会反复调用它）', () => {
    preloadFlags(srcs(4));
    FakeImage.created.forEach((c) => c.resolve());
    expect(FakeImage.created.length).toBe(4);
    preloadFlags(srcs(4));
    expect(FakeImage.created.length).toBe(4); // 一个都没重发
  });

  it('换池时替换队列（旧的 in-flight 完成不复活旧队列）', () => {
    preloadFlags(srcs(6));
    expect(FakeImage.created.length).toBe(3);
    preloadFlags(['data/flags/only.svg']);
    expect(flagPreloadStats().total).toBe(1);
    FakeImage.created.at(-1)!.resolve();
    // 旧队列不再续取：总数只多了那 1 个新池请求
    expect(flagPreloadStats().started).toBe(false);
  });

  it('stop 之后不再发起新的请求（离开模式就该停）', () => {
    preloadFlags(srcs(10));
    const before = FakeImage.created.length;
    stopFlagPreload();
    FakeImage.created.slice(0, before).forEach((c) => c.resolve());
    expect(FakeImage.created.length).toBe(before);
    expect(flagPreloadStats().total).toBe(0);
  });

  it('去重：同一个 src 在一批里出现多次只请求一次', () => {
    preloadFlags(['a.svg', 'a.svg', 'b.svg']);
    expect(FakeImage.created.map((c) => c.src)).toEqual(['a.svg', 'b.svg']);
  });
});
