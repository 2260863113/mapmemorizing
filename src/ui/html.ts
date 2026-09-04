/** 跨面板共享的 HTML 转义工具（消除多处重复的 escapeHtml / escapeAttr 实现）。 */

/** 转义文本内容（插入 innerHTML 的正文/标题），防止 HTML 注入。 */
export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 转义属性值（兼容单/双引号属性），防止属性注入。 */
export function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
