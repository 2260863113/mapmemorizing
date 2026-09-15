import { describe, it, expect, afterEach, vi } from 'vitest';
import { DEFAULT_NAMING, loadStoredNaming, namingStorageKey, saveStoredNaming } from './namingStore';

/**
 * 取名口径的本地记忆：逐字段回落是**契约**（一个字段被写坏不该把另外两个一起重置），
 * 键前缀按模式隔离（输入与点击各记各的）。
 */

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

describe('namingStore', () => {
  it('没有记录时返回默认（国名 + 中文 + 省名 = 上线前的历史行为）', () => {
    stubStorage();
    expect(loadStoredNaming('self')).toEqual(DEFAULT_NAMING);
  });

  it('存过之后读回来是同一份', () => {
    stubStorage();
    saveStoredNaming('click', { world: 'capital', lang: 'en', province: 'abbr' });
    expect(loadStoredNaming('click')).toEqual({ world: 'capital', lang: 'en', province: 'abbr' });
  });

  it('国旗档也记得住（点击模式专有的一档）', () => {
    stubStorage();
    saveStoredNaming('click', { world: 'flag', lang: 'en', province: 'full' });
    expect(loadStoredNaming('click')).toEqual({ world: 'flag', lang: 'en', province: 'full' });
  });

  it('模式之间互不干扰（输入模式的口径不会串到点击模式）', () => {
    const store = stubStorage();
    saveStoredNaming('self', { world: 'capital', lang: 'zh', province: 'full' });
    expect(loadStoredNaming('click')).toEqual(DEFAULT_NAMING);
    expect(store.has(namingStorageKey('self'))).toBe(true);
    expect(store.has(namingStorageKey('click'))).toBe(false);
  });

  it('非法值**逐字段**回落，不牵连其它字段', () => {
    stubStorage({ [namingStorageKey('self')]: JSON.stringify({ world: 'capital', lang: 'fr', province: 42 }) });
    expect(loadStoredNaming('self')).toEqual({ world: 'capital', lang: 'zh', province: 'full' });
  });

  it('JSON 损坏时整体回落默认，不抛错', () => {
    stubStorage({ [namingStorageKey('self')]: '{ 不是 JSON' });
    expect(loadStoredNaming('self')).toEqual(DEFAULT_NAMING);
  });

  it('存储不可用（隐私模式）时读回落默认、写静默失败', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    expect(loadStoredNaming('self')).toEqual(DEFAULT_NAMING);
    expect(() => saveStoredNaming('self', { world: 'capital', lang: 'en', province: 'abbr' })).not.toThrow();
  });
});
