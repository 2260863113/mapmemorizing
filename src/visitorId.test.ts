import { describe, it, expect, afterEach, vi } from 'vitest';
import { setVisitorIdForTest, visitorId, VISITOR_ID_KEY } from './visitorId';

/**
 * 游客编号（2026-10 需求 3）。
 *
 * 要锁住的三件事，每一件错了都会静默地把统计搞坏：
 *   1. **首次生成、之后不变** —— "同一个浏览器每次访问都是同一个号"是这条需求的目的本身；
 *      如果每次都新生成，管理端会把同一个游客记成几十个人（而且看起来完全正常）。
 *   2. **形状合法** —— 4 位数字，与后端 `sanitizeVisitorId` 的白名单一致；脏值要重新生成，
 *      而不是原样发出去（发出去会被后端丢掉，游客就没有号了）。
 *   3. **存储不可用时不抛错** —— 无痕模式下 localStorage 会抛，不能让上报链路跟着挂。
 */

/** 最小的 localStorage 替身（记录写入，支持预置与"抛错"两种模式）。 */
function stubStorage(initial?: string | null, throwOnAccess = false) {
  const store = new Map<string, string>();
  if (initial !== undefined && initial !== null) store.set(VISITOR_ID_KEY, initial);
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => {
      if (throwOnAccess) throw new Error('storage disabled');
      return store.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      if (throwOnAccess) throw new Error('storage disabled');
      store.set(k, v);
    },
  });
  return store;
}

afterEach(() => {
  vi.unstubAllGlobals();
  setVisitorIdForTest(undefined); // 清进程内缓存，避免用例互相污染
});

describe('visitorId', () => {
  it('首次调用生成 4 位数字并写进存储', () => {
    const store = stubStorage();
    const id = visitorId();
    expect(id).toMatch(/^\d{4}$/);
    expect(store.get(VISITOR_ID_KEY)).toBe(id);
  });

  it('同一个浏览器（存储里有值）每次都是同一个号 —— 刷新只是重新读它', () => {
    stubStorage('2468');
    expect(visitorId()).toBe('2468');
    // 模拟刷新：清掉进程内缓存，重新读存储
    setVisitorIdForTest(undefined);
    expect(visitorId()).toBe('2468');
  });

  it('存储里是脏值（非 4 位数字）就重新生成并覆盖', () => {
    const store = stubStorage('abc');
    const id = visitorId();
    expect(id).toMatch(/^\d{4}$/);
    expect(store.get(VISITOR_ID_KEY)).toBe(id);
  });

  it('进程内缓存生效：存储被改掉也不会变（一次页面生命周期一个号）', () => {
    const store = stubStorage('1111');
    expect(visitorId()).toBe('1111');
    store.set(VISITOR_ID_KEY, '2222');
    expect(visitorId()).toBe('1111');
  });

  it('存储不可用（无痕/禁用）时返回 null 且不抛错，也不反复重试', () => {
    stubStorage(null, true);
    expect(() => visitorId()).not.toThrow();
    expect(visitorId()).toBeNull();
    expect(visitorId()).toBeNull();
  });

  it('多次调用在存储可用时只写一次（首次写入后走缓存）', () => {
    const store = stubStorage();
    visitorId();
    const first = store.get(VISITOR_ID_KEY);
    visitorId();
    visitorId();
    expect(store.get(VISITOR_ID_KEY)).toBe(first);
  });
});
