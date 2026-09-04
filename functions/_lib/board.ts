/** 留言板共享校验与常量。 */

import { ApiError } from './http';

export const MAX_POST_LEN = 200;
export const MAX_REPLY_LEN = 100;
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 50;

/** 纯文本清洗：trim + 长度校验（按 Unicode 码点计数，中文字符算 1）。非法返回 null。 */
export function cleanBoardText(value: unknown, maxLen: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  if (Array.from(text).length > maxLen) return null;
  return text;
}

/** 通用纯文本清洗（公告等复用），与 cleanBoardText 同语义。 */
export function cleanPlainText(value: unknown, maxLen: number): string | null {
  return cleanBoardText(value, maxLen);
}

/** 解析正整数 id；非法抛 ApiError 400。 */
export function parsePositiveInt(value: string | undefined, label: string): number {
  if (!value) throw new ApiError(400, 'invalid_param', `缺少${label}`);
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new ApiError(400, 'invalid_param', `${label}无效`);
  return n;
}

/** 解析分页游标 before：缺省或 0 表示从最新开始（合法）；非法抛 ApiError 400。 */
export function parseBefore(value: string | null): number {
  if (!value) return 0;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new ApiError(400, 'invalid_param', '分页游标无效');
  return n;
}

/** 解析 limit，钳制到 [1, MAX_LIMIT]。 */
export function parseLimit(value: string | null): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}
