import { t } from '../i18n';

/** 测试摘要/排行榜共用的时间格式（消除多处重复的 formatDate / formatDateTime / formatRelative）。 */

/** 毫秒时间戳 → YYYY-MM-DD。 */
export function formatDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 毫秒时间戳 → YYYY-MM-DD HH:mm。 */
export function formatDateTime(ms: number): string {
  const d = new Date(ms);
  return `${formatDate(ms)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 相对时间（留言板用）：刚刚 / N 分钟前 / N 小时前 / N 天前 / 绝对日期。 */
export function formatRelative(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return t('board.timeJustNow');
  if (diff < 3_600_000) return t('board.timeMinutes', { n: Math.floor(diff / 60_000) });
  if (diff < 86_400_000) return t('board.timeHours', { n: Math.floor(diff / 3_600_000) });
  if (diff < 7 * 86_400_000) return t('board.timeDays', { n: Math.floor(diff / 86_400_000) });
  return formatDate(ms);
}
