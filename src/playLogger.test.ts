import { describe, it, expect, afterEach, vi } from 'vitest';
import { reportPlay } from './playLogger';
import { api } from './api';
import { setVisitorIdForTest, VISITOR_ID_KEY } from './visitorId';

/**
 * 游玩上报的**载荷**（2026-10 需求 3/5）。
 *
 * 为什么单独测这个：管理端「游玩统计」要按「游客编号」区分人、按「模式 + 出题范围」看分布。
 * 三样东西少任何一样都不会报错、也不会让界面变红 —— 只是统计悄悄少一列，
 * 而"少一列"在下一次有人对着看板做决策时才会被发现。
 */

function stubStorage() {
  const store = new Map<string, string>([['china-admin-visitor-test', 'x']]);
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  });
  return store;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  // 游客编号是进程内缓存的：每个用例都从"这台浏览器还没有号"开始，用例之间才不互相污染
  setVisitorIdForTest(undefined);
});

describe('reportPlay', () => {
  it('上报 mode / source / 游客编号 / 出题范围（标识 + 展示名）', async () => {
    stubStorage();
    const seen: unknown[] = [];
    vi.spyOn(api, 'play').mockImplementation((() => {
      seen.push(1);
      return Promise.resolve({ ok: true });
    }) as unknown as typeof api.play);
    // 直接断言传给 api.play 的实参：把 spy 的调用记录转出来
    const spy = api.play as unknown as { mock: { calls: unknown[][] } };

    reportPlay('self', 'tab', 'tok', { scopeProvince: '__world_nation__', scopeLabel: '世界' });

    expect(seen).toHaveLength(1);
    const [body, token] = spy.mock.calls[0] as [Record<string, unknown>, string];
    expect(token).toBe('tok');
    expect(body.mode).toBe('self');
    expect(body.source).toBe('tab');
    expect(body.scopeProvince).toBe('__world_nation__');
    expect(body.scopeLabel).toBe('世界');
    // 游客编号：4 位数字，与后端白名单一致
    expect(String(body.visitor)).toMatch(/^\d{4}$/);
    // 浏览器环境一并带上（管理端要据此判爬虫）
    expect(typeof body.env).toBe('object');
  });

  it('没有出题范围时显式传 null（服务端存 NULL，前端显示占位）', () => {
    stubStorage();
    vi.spyOn(api, 'play').mockResolvedValue({ ok: true });
    const spy = api.play as unknown as { mock: { calls: unknown[][] } };
    reportPlay('endless', 'start');
    const [body] = spy.mock.calls[0] as [Record<string, unknown>];
    expect(body.scopeProvince).toBeNull();
    expect(body.scopeLabel).toBeNull();
  });

  it('编号与存储键一致（同一个浏览器复用同一个号）', () => {
    setVisitorIdForTest(undefined); // 从"还没有号"开始，才看得到首次写入
    const store = stubStorage();
    vi.spyOn(api, 'play').mockResolvedValue({ ok: true });
    const spy = api.play as unknown as { mock: { calls: unknown[][] } };
    reportPlay('click', 'start');
    const [body] = spy.mock.calls[0] as [Record<string, unknown>];
    expect(store.get(VISITOR_ID_KEY)).toBe(body.visitor);
  });
});
