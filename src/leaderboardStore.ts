import type { AuthUser, Mode, RoundResult } from './types';

const LEADERBOARD_KEY = 'china-admin-leaderboard-v1';
const LEADERBOARD_VERSION = 1;
const MAX_GROUP_ROWS = 50;

export type LeaderboardMode = Extract<Mode, 'self' | 'click'>;

export interface LeaderboardEntry {
  id: string;
  username: string;
  mode: LeaderboardMode;
  scopeProvince: string | null;
  scopeLabel: string;
  totalUnits: number;
  elapsedMs: number;
  submittedAt: number;
}

interface LeaderboardState {
  version: number;
  entries: LeaderboardEntry[];
}

export type SubmitResult = 'added' | 'improved' | 'kept';

export class LeaderboardStore {
  private state: LeaderboardState = { version: LEADERBOARD_VERSION, entries: [] };

  constructor() {
    this.state = this.load();
  }

  submit(result: RoundResult, user: AuthUser): SubmitResult {
    const mode = result.mode;
    const scopeProvince = result.scopeProvince;
    const username = user.username;
    const existingIndex = this.state.entries.findIndex(
      (entry) => entry.mode === mode && sameScope(entry.scopeProvince, scopeProvince) && sameUser(entry.username, username),
    );

    if (existingIndex >= 0 && this.state.entries[existingIndex].elapsedMs <= result.elapsedMs) return 'kept';

    const entry: LeaderboardEntry = {
      id: `${mode}:${scopeProvince ?? 'nation'}:${userKey(username)}:${result.finishedAt}`,
      username,
      mode,
      scopeProvince,
      scopeLabel: result.scopeLabel,
      totalUnits: result.totalUnits,
      elapsedMs: Math.max(0, Math.round(result.elapsedMs)),
      submittedAt: result.finishedAt,
    };

    if (existingIndex >= 0) {
      this.state.entries.splice(existingIndex, 1, entry);
      this.trimGroup(mode, scopeProvince);
      this.persist();
      return 'improved';
    }

    this.state.entries.push(entry);
    this.trimGroup(mode, scopeProvince);
    this.persist();
    return 'added';
  }

  list(mode: LeaderboardMode, scopeProvince: string | null): LeaderboardEntry[] {
    return this.state.entries
      .filter((entry) => entry.mode === mode && sameScope(entry.scopeProvince, scopeProvince))
      .sort(compareEntry);
  }

  private trimGroup(mode: LeaderboardMode, scopeProvince: string | null) {
    const sorted = this.list(mode, scopeProvince);
    const keep = new Set(sorted.slice(0, MAX_GROUP_ROWS).map((entry) => entry.id));
    this.state.entries = this.state.entries.filter(
      (entry) => entry.mode !== mode || !sameScope(entry.scopeProvince, scopeProvince) || keep.has(entry.id),
    );
  }

  private load(): LeaderboardState {
    try {
      const raw = localStorage.getItem(LEADERBOARD_KEY);
      if (!raw) return { version: LEADERBOARD_VERSION, entries: [] };
      const parsed = JSON.parse(raw) as Partial<LeaderboardState>;
      const input = Array.isArray(parsed.entries) ? parsed.entries : [];
      return {
        version: LEADERBOARD_VERSION,
        entries: input.map(normalizeEntry).filter((entry): entry is LeaderboardEntry => !!entry),
      };
    } catch {
      return { version: LEADERBOARD_VERSION, entries: [] };
    }
  }

  private persist() {
    try {
      localStorage.setItem(LEADERBOARD_KEY, JSON.stringify(this.state));
    } catch {
      /* 忽略存储失败 */
    }
  }
}

function normalizeEntry(value: unknown): LeaderboardEntry | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Partial<LeaderboardEntry>;
  if (row.mode !== 'self' && row.mode !== 'click') return null;
  if (typeof row.username !== 'string' || !row.username.trim()) return null;
  if (row.scopeProvince !== null && typeof row.scopeProvince !== 'string') return null;
  if (typeof row.scopeLabel !== 'string' || !row.scopeLabel.trim()) return null;
  if (!finitePositive(row.totalUnits) || !finitePositive(row.elapsedMs) || !finitePositive(row.submittedAt)) return null;
  return {
    id: typeof row.id === 'string' && row.id ? row.id : `${row.mode}:${row.scopeProvince ?? 'nation'}:${userKey(row.username)}:${row.submittedAt}`,
    username: row.username.slice(0, 24),
    mode: row.mode,
    scopeProvince: row.scopeProvince,
    scopeLabel: row.scopeLabel,
    totalUnits: Math.floor(row.totalUnits),
    elapsedMs: Math.round(row.elapsedMs),
    submittedAt: Math.floor(row.submittedAt),
  };
}

function compareEntry(a: LeaderboardEntry, b: LeaderboardEntry) {
  return a.elapsedMs - b.elapsedMs || a.submittedAt - b.submittedAt || a.username.localeCompare(b.username, 'zh-CN');
}

function sameScope(a: string | null, b: string | null) {
  return (a ?? null) === (b ?? null);
}

function sameUser(a: string, b: string) {
  return userKey(a) === userKey(b);
}

function userKey(username: string) {
  return username.trim().toLowerCase();
}

function finitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
