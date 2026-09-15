import { describe, it, expect, afterEach, vi } from 'vitest';
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from './store';

/**
 * 全局设置里的「未开始时显示地图标签」与已下线的「自由模式」旧键的迁移。
 *
 * 为什么必须测：这个开关的初值**不是**永远的默认值 —— 老用户可能在自由模式里关过标签
 * （旧键 `china-admin-memory-hide-labels-v1` = '1'），升级后不该突然看到满屏地名。
 * 旧键语义与新的正面措辞相反（隐藏 vs 显示），取反写错就会静默把所有人的偏好翻过来。
 */
const SETTINGS_KEY = 'china-admin-settings-v1';
const LEGACY_KEY = 'china-admin-memory-hide-labels-v1';

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

describe('loadSettings · 「未开始时显示地图标签」', () => {
  it('全新用户：默认显示', () => {
    stubStorage();
    expect(loadSettings().showBrowseLabels).toBe(true);
    expect(DEFAULT_SETTINGS.showBrowseLabels).toBe(true);
  });

  it('老用户在自由模式里**隐藏**过标签（旧键=1）：迁移成关闭', () => {
    stubStorage({ [LEGACY_KEY]: '1' });
    expect(loadSettings().showBrowseLabels).toBe(false);
  });

  it('老用户没关过标签（旧键=0）：保持显示', () => {
    stubStorage({ [LEGACY_KEY]: '0' });
    expect(loadSettings().showBrowseLabels).toBe(true);
  });

  it('设置档里已有该字段时以它为准，不再看旧键', () => {
    stubStorage({
      [LEGACY_KEY]: '1', // 旧偏好是隐藏
      [SETTINGS_KEY]: JSON.stringify({ ...DEFAULT_SETTINGS, showBrowseLabels: true }),
    });
    expect(loadSettings().showBrowseLabels).toBe(true);
  });

  it('设置档存在但缺该字段（升级上来的老档）：仍按旧键迁移', () => {
    stubStorage({
      [LEGACY_KEY]: '1',
      [SETTINGS_KEY]: JSON.stringify({ cityBoundaryTone: 'dark', darkMode: true, ignoreTinyCountries: true }),
    });
    const s = loadSettings();
    expect(s.showBrowseLabels).toBe(false);
    expect(s.cityBoundaryTone).toBe('dark'); // 其它字段照常读回
    expect(s.darkMode).toBe(true);
  });

  it('设置档损坏时回落默认 + 旧键迁移', () => {
    stubStorage({ [SETTINGS_KEY]: '{ 不是 JSON', [LEGACY_KEY]: '1' });
    expect(loadSettings().showBrowseLabels).toBe(false);
  });

  it('存储不可用时不抛错，回落默认', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    expect(loadSettings().showBrowseLabels).toBe(true);
    expect(() => saveSettings({ ...DEFAULT_SETTINGS, showBrowseLabels: false })).not.toThrow();
  });

  it('保存后能读回（含新字段）', () => {
    stubStorage();
    saveSettings({ ...DEFAULT_SETTINGS, showBrowseLabels: false, darkMode: true });
    const s = loadSettings();
    expect(s.showBrowseLabels).toBe(false);
    expect(s.darkMode).toBe(true);
  });
});

/**
 * 全局设置「下钻后隐藏无关地区」。
 *
 * 为什么必须测：默认值必须是 **true**（= 历史观感）—— 老档没有这个字段，
 * 若归一化写反，所有老用户升级后地图观感会当场变样（下钻后冒出一片灰）。
 */
describe('loadSettings · 「下钻后隐藏无关地区」', () => {
  it('全新用户：默认隐藏（与历史观感一致）', () => {
    stubStorage();
    expect(DEFAULT_SETTINGS.hideUnrelatedOnDrill).toBe(true);
    expect(loadSettings().hideUnrelatedOnDrill).toBe(true);
  });

  it('老档缺该字段：回落默认 true（不因升级而改观感）', () => {
    stubStorage({
      [SETTINGS_KEY]: JSON.stringify({ cityBoundaryTone: 'dark', darkMode: true, ignoreTinyCountries: true }),
    });
    const s = loadSettings();
    expect(s.hideUnrelatedOnDrill).toBe(true);
    expect(s.cityBoundaryTone).toBe('dark'); // 其它字段照常读回
  });

  it('用户关过：读回 false（关闭后下钻仍显示其他地区）', () => {
    stubStorage({ [SETTINGS_KEY]: JSON.stringify({ ...DEFAULT_SETTINGS, hideUnrelatedOnDrill: false }) });
    expect(loadSettings().hideUnrelatedOnDrill).toBe(false);
  });

  it('字段值不是布尔（脏档）：归一为默认值，不让 undefined/字符串透传渲染层', () => {
    stubStorage({ [SETTINGS_KEY]: JSON.stringify({ ...DEFAULT_SETTINGS, hideUnrelatedOnDrill: 'false' }) });
    expect(loadSettings().hideUnrelatedOnDrill).toBe(true);
  });

  it('保存后能读回', () => {
    stubStorage();
    saveSettings({ ...DEFAULT_SETTINGS, hideUnrelatedOnDrill: false });
    expect(loadSettings().hideUnrelatedOnDrill).toBe(false);
  });
});
