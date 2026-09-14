/**
 * 留言板草稿（本地保存）。
 *
 * 为什么需要：未登录用户写完留言点「发布」会被登录门控拦下，而登录成功后的回调会重绘整个面板
 * （`el.innerHTML = …`）—— 只存在于 DOM 输入框里的草稿会连同 DOM 一起被擦掉，用户只能重写一遍。
 * 现在草稿落在 localStorage：登录跳转、切换模式、甚至刷新页面都不丢。
 *
 * 清空时机：**只有发布成功**才清（用户口径 2026-09）。离开留言板不清、刷新不清。
 */
const DRAFT_KEY = 'china-admin-board-draft-v1';

/** 读草稿（无草稿或存储不可用返回空串）。 */
export function loadDraft(): string {
  try {
    return localStorage.getItem(DRAFT_KEY) ?? '';
  } catch {
    return '';
  }
}

/** 写草稿；空串等于清除（不留下空键）。存储失败静默忽略 —— 不该因为存不下而挡住发帖。 */
export function saveDraft(text: string): void {
  try {
    if (text) localStorage.setItem(DRAFT_KEY, text);
    else localStorage.removeItem(DRAFT_KEY);
  } catch {
    /* 忽略存储失败 */
  }
}

/** 清草稿（发布成功后调用）。 */
export function clearDraft(): void {
  saveDraft('');
}

/** 存储键（测试与文档引用；不要再在别处硬编码这个字符串）。 */
export const BOARD_DRAFT_KEY = DRAFT_KEY;
