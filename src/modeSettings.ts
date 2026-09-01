/** 每模式设置：localStorage 持久化的布尔/数值开关（各模式设置按钮面板用）。 */

function loadBool(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    return raw === '1';
  } catch {
    return fallback;
  }
}

function saveBool(key: string, value: boolean) {
  try {
    localStorage.setItem(key, value ? '1' : '0');
  } catch {
    /* 忽略存储失败 */
  }
}

export interface ToggleSetting {
  key: string;
  label: string;
  value: boolean;
  /** 置灰不可修改（如无尽闯关固定按下 Enter 确认） */
  fixed?: boolean;
}

export interface ModeSettingsPanel {
  title: string;
  toggles: ToggleSetting[];
  /** 修改回调：key + 新值（持久化与模式行为同步由各模式注册） */
  onChange: (key: string, value: boolean) => void;
}

// ---------- 输入模式（self） ----------
const SELF_REQUIRE_ENTER_KEY = 'china-admin-self-require-enter-v1';
const SELF_ERROR_ROLLBACK_KEY = 'china-admin-self-error-rollback-v1';
const SELF_AUTO_FOLLOW_KEY = 'china-admin-self-auto-follow-v1';
export const SELF_FOLLOW_ZOOM = 12; // 自动跟随倍率固定默认值，不可修改

export function loadSelfRequireEnter(): boolean {
  return loadBool(SELF_REQUIRE_ENTER_KEY, true);
}
export function saveSelfRequireEnter(v: boolean) {
  saveBool(SELF_REQUIRE_ENTER_KEY, v);
}
export function loadSelfErrorRollback(): boolean {
  return loadBool(SELF_ERROR_ROLLBACK_KEY, false);
}
export function saveSelfErrorRollback(v: boolean) {
  saveBool(SELF_ERROR_ROLLBACK_KEY, v);
}
export function loadSelfAutoFollow(): boolean {
  return loadBool(SELF_AUTO_FOLLOW_KEY, true);
}
export function saveSelfAutoFollow(v: boolean) {
  saveBool(SELF_AUTO_FOLLOW_KEY, v);
}

// ---------- 点击模式（click） ----------
const CLICK_ERROR_ROLLBACK_KEY = 'china-admin-click-error-rollback-v1';

export function loadClickErrorRollback(): boolean {
  return loadBool(CLICK_ERROR_ROLLBACK_KEY, false);
}
export function saveClickErrorRollback(v: boolean) {
  saveBool(CLICK_ERROR_ROLLBACK_KEY, v);
}

// ---------- 无尽闯关（endless） ----------
const ENDLESS_AUTO_FOLLOW_KEY = 'china-admin-endless-auto-follow-v1';
export const ENDLESS_FOLLOW_ZOOM = 12; // 自动跟随倍率固定默认值，不可修改

export function loadEndlessAutoFollow(): boolean {
  return loadBool(ENDLESS_AUTO_FOLLOW_KEY, true);
}
export function saveEndlessAutoFollow(v: boolean) {
  saveBool(ENDLESS_AUTO_FOLLOW_KEY, v);
}

// ---------- 自由模式（memory，自由浏览） ----------
const MEMORY_HIDE_LABELS_KEY = 'china-admin-memory-hide-labels-v1';

export function loadMemoryHideLabels(): boolean {
  return loadBool(MEMORY_HIDE_LABELS_KEY, false);
}
export function saveMemoryHideLabels(v: boolean) {
  saveBool(MEMORY_HIDE_LABELS_KEY, v);
}
