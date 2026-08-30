/** 入参校验与纯函数规则（与前端 authStore/leaderboardStore 对齐）。 */

import { ApiError } from './http';

export interface PasswordHashPayload {
  algorithm: string;
  salt: string;
  hash: string;
  iterations: number;
}

export type ScoreMode = 'self' | 'click' | 'endless';

/** 用户名归一化：与前端 cleanUsername 一致（trim、压缩空白、截 24）。 */
export function cleanUsername(username: unknown): string {
  return typeof username === 'string'
    ? username.trim().replace(/\s+/g, ' ').slice(0, 24)
    : '';
}

/** 校验前端传来的 PBKDF2 哈希结构。 */
export function normalizePasswordHash(value: unknown): PasswordHashPayload {
  if (!value || typeof value !== 'object') throw new ApiError(400, 'invalid_password_hash', '密码哈希格式错误');
  const row = value as Partial<PasswordHashPayload>;
  if (row.algorithm !== 'PBKDF2-SHA-256') throw new ApiError(400, 'invalid_password_hash', '不支持的密码算法');
  if (typeof row.salt !== 'string' || typeof row.hash !== 'string') throw new ApiError(400, 'invalid_password_hash', '密码哈希格式错误');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(row.salt) || !/^[A-Za-z0-9+/]+={0,2}$/.test(row.hash)) {
    throw new ApiError(400, 'invalid_password_hash', '密码哈希格式错误');
  }
  const iterations = typeof row.iterations === 'number' && Number.isInteger(row.iterations) ? row.iterations : 0;
  if (iterations < 120000) throw new ApiError(400, 'invalid_password_hash', '密码迭代次数过低');
  return { algorithm: row.algorithm, salt: row.salt, hash: row.hash, iterations };
}

const MODES = new Set(['self', 'click', 'endless']);

export function validMode(mode: unknown): mode is ScoreMode {
  return typeof mode === 'string' && MODES.has(mode);
}

export interface ScorePayload {
  mode: ScoreMode;
  scopeProvince: string | null;
  scopeLabel: string;
  totalUnits: number;
  correct: number;
  wrong: number;
  elapsedMs: number;
  finishedAt: number;
  coins?: number;
  level?: number;
}

/** 校验提交的成绩（复刻前端 canSubmit + 数值合理性，防接口刷垃圾分）。 */
export function validateScore(body: unknown): ScorePayload {
  if (!body || typeof body !== 'object') throw new ApiError(400, 'invalid_score', '成绩格式错误');
  const row = body as Partial<ScorePayload>;
  if (!validMode(row.mode)) throw new ApiError(400, 'invalid_mode', '无效的模式');
  if (row.scopeProvince !== null && typeof row.scopeProvince !== 'string') throw new ApiError(400, 'invalid_scope', '无效的范围');
  if (typeof row.scopeLabel !== 'string' || !row.scopeLabel.trim()) throw new ApiError(400, 'invalid_scope_label', '缺少范围名称');

  const totalUnits = Number(row.totalUnits);
  const correct = Number(row.correct);
  const wrong = Number(row.wrong);
  const elapsedMs = Number(row.elapsedMs);
  const finishedAt = Number(row.finishedAt);
  if (!Number.isFinite(totalUnits) || totalUnits < 0) throw new ApiError(400, 'invalid_score', '无效的题目总数');
  if (!Number.isFinite(correct) || correct < 0) throw new ApiError(400, 'invalid_score', '无效的答对数');
  if (!Number.isFinite(wrong) || wrong < 0) throw new ApiError(400, 'invalid_score', '无效的答错数');
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) throw new ApiError(400, 'invalid_score', '无效的用时');
  if (!Number.isFinite(finishedAt)) throw new ApiError(400, 'invalid_score', '无效的提交时间');

  const now = Date.now();
  if (Math.abs(finishedAt - now) > 5 * 60 * 1000) throw new ApiError(400, 'stale_result', '成绩已过期，请重新作答');

  const payload: ScorePayload = {
    mode: row.mode,
    scopeProvince: row.scopeProvince === '' ? null : row.scopeProvince,
    scopeLabel: row.scopeLabel.trim(),
    totalUnits: Math.floor(totalUnits),
    correct: Math.floor(correct),
    wrong: Math.floor(wrong),
    elapsedMs: Math.round(elapsedMs),
    finishedAt: Math.floor(finishedAt),
  };

  // 提交资格：endless 需有金币（不统计题数，totalUnits 恒 0）；全国 self/click 允许未答完（已答全对即可）；省级维持全对。
  if (payload.mode === 'endless') {
    const coins = Number(row.coins);
    if (!Number.isFinite(coins) || coins <= 0) throw new ApiError(400, 'invalid_score', '尚未收集金币');
    payload.coins = Math.floor(coins);
    const level = Number(row.level);
    payload.level = Number.isFinite(level) && level >= 1 ? Math.floor(level) : 1;
    return payload;
  }
  if (payload.totalUnits <= 0) throw new ApiError(400, 'invalid_score', '无效的题目总数');
  if (payload.correct > payload.totalUnits) throw new ApiError(400, 'invalid_score', '无效的答对数');
  if (payload.scopeProvince === null) {
    if (!(payload.correct > 0 && payload.wrong === 0)) throw new ApiError(400, 'invalid_score', '全国榜需已答全对');
    return payload;
  }
  if (!(payload.correct + payload.wrong === payload.totalUnits && payload.correct === payload.totalUnits && payload.wrong === 0)) {
    throw new ApiError(400, 'invalid_score', '省级榜需全部答对');
  }
  return payload;
}

/** 新成绩是否比已有成绩更优（与前端 isBetter 对齐）。 */
export function isBetter(next: ScorePayload, existing: { coins: number | null; level: number | null; correct: number; elapsed_ms: number }): boolean {
  if (next.mode === 'endless') {
    const nextCoins = next.coins ?? 0;
    const existingCoins = existing.coins ?? 0;
    return nextCoins > existingCoins || (nextCoins === existingCoins && (next.level ?? 1) > (existing.level ?? 1));
  }
  if (next.scopeProvince === null) {
    return next.correct > existing.correct || (next.correct === existing.correct && next.elapsedMs < existing.elapsed_ms);
  }
  return next.elapsedMs < existing.elapsed_ms;
}
