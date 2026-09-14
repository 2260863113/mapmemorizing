import { describe, it, expect, afterEach, vi } from 'vitest';
import { loadDraft, saveDraft, clearDraft, BOARD_DRAFT_KEY } from './boardDraft';

/** 留言板草稿的存储契约（登录跳转 / 切模式 / 刷新都不能丢；只有发布成功才清）。 */

function stubStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  return store;
}

afterEach(() => vi.unstubAllGlobals());

describe('boardDraft', () => {
  it('没写过草稿时返回空串', () => {
    stubStorage();
    expect(loadDraft()).toBe('');
  });

  it('存了就能读回来（跨「刷新页面」）', () => {
    const store = stubStorage();
    saveDraft('写了一半的留言');
    expect(loadDraft()).toBe('写了一半的留言');
    expect(store.get(BOARD_DRAFT_KEY)).toBe('写了一半的留言');
  });

  it('清空 = 删掉键，而不是留一个空串', () => {
    const store = stubStorage();
    saveDraft('草稿');
    clearDraft();
    expect(loadDraft()).toBe('');
    expect(store.has(BOARD_DRAFT_KEY)).toBe(false);
  });

  it('存空串同样等于清除（避免空键被误当成"有草稿"）', () => {
    const store = stubStorage({ [BOARD_DRAFT_KEY]: '旧的' });
    saveDraft('');
    expect(store.has(BOARD_DRAFT_KEY)).toBe(false);
  });

  it('存储不可用（隐私模式）时读写都不抛错', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    });
    expect(loadDraft()).toBe('');
    expect(() => saveDraft('x')).not.toThrow();
    expect(() => clearDraft()).not.toThrow();
  });
});
