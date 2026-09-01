/** D1 行 → JSON 形状映射。 */

import type { UserRow } from './auth';

export interface PublicUser {
  username: string;
  hometown: { provinceAdcode: string; cityAdcode: string } | null;
  avatar: { dataUrl: string; name: string; size: number; type: string } | null;
  createdAt: number;
  updatedAt: number;
}

export interface LeaderboardEntry {
  id: string;
  username: string;
  mode: string;
  scopeProvince: string | null;
  scopeLabel: string;
  totalUnits: number;
  correct: number;
  elapsedMs: number;
  submittedAt: number;
  coins?: number;
  level?: number;
  /** 用户所在地 adcode 对（个人资料填写），未填写为 null */
  hometown: { provinceAdcode: string; cityAdcode: string } | null;
  /** 用户头像 dataUrl（个人资料填写），未填写为 null */
  avatar: string | null;
}

/** 服务端绝不返回密码哈希。 */
export function toPublicUser(row: UserRow): PublicUser {
  return {
    username: row.username,
    hometown: parseJson<{ provinceAdcode: string; cityAdcode: string }>(row.hometown),
    avatar: parseJson<{ dataUrl: string; name: string; size: number; type: string }>(row.avatar),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface LeaderboardRow {
  id: number;
  mode: string;
  scope_province: string;
  scope_label: string;
  total_units: number;
  correct: number;
  elapsed_ms: number;
  submitted_at: number;
  coins: number | null;
  level: number | null;
  username: string;
  hometown: string | null;
  avatar: string | null;
}

export function toLeaderboardEntry(row: LeaderboardRow): LeaderboardEntry {
  const entry: LeaderboardEntry = {
    id: String(row.id),
    username: row.username,
    mode: row.mode,
    scopeProvince: row.scope_province === '' ? null : row.scope_province,
    scopeLabel: row.scope_label,
    totalUnits: row.total_units,
    correct: row.correct,
    elapsedMs: row.elapsed_ms,
    submittedAt: row.submitted_at,
    hometown: parseJson<{ provinceAdcode: string; cityAdcode: string }>(row.hometown),
    avatar: parseJson<{ dataUrl: string }>(row.avatar)?.dataUrl ?? null,
  };
  if (row.mode === 'endless') {
    entry.coins = row.coins ?? 0;
    entry.level = row.level ?? 1;
  }
  return entry;
}

export function parseJson<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}
