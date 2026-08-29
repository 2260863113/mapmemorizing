import type { BoundaryTone, MemoryRecord, Settings } from './types';

const MEM_KEY = 'china-admin-memory-v1';
const SET_KEY = 'china-admin-settings-v1';

/** 自由模式记忆进度（localStorage 持久化 + pub/sub） */
export class MemoryStore {
  private data: Record<string, MemoryRecord> = {};
  private listeners = new Set<() => void>();

  constructor() {
    try {
      const raw = localStorage.getItem(MEM_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Record<string, Partial<MemoryRecord>>;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      for (const [adcode, value] of Object.entries(parsed)) {
        if (!value || typeof value !== 'object') continue;
        this.data[adcode] = this.normalizeRecord(value);
      }
    } catch {
      this.data = {};
    }
  }

  private normalizeRecord(value: Partial<MemoryRecord>): MemoryRecord {
    const correctCount = finiteCount(value.correctCount);
    const wrongCount = finiteCount(value.wrongCount);
    const record: MemoryRecord = {
      learned: value.learned === true,
      firstLearnedAt: finiteNumber(value.firstLearnedAt),
      reviewCount: finiteCount(value.reviewCount),
      lastReviewAt: finiteNumber(value.lastReviewAt),
      correctCount,
      wrongCount,
      score: 0,
    };
    this.syncScore(record);
    return record;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }

  private syncScore(record: MemoryRecord) {
    record.score = record.correctCount - record.wrongCount;
  }

  private persist() {
    try {
      localStorage.setItem(MEM_KEY, JSON.stringify(this.data));
    } catch {
      /* 忽略存储失败 */
    }
    this.emit();
  }

  isLearned(adcode: string): boolean {
    return !!this.data[adcode]?.learned;
  }

  get(adcode: string): MemoryRecord | undefined {
    return this.data[adcode];
  }

  getPractice(adcode: string): Pick<MemoryRecord, 'correctCount' | 'wrongCount' | 'score'> {
    const rec = this.data[adcode];
    return rec ? { correctCount: rec.correctCount, wrongCount: rec.wrongCount, score: rec.score } : { correctCount: 0, wrongCount: 0, score: 0 };
  }

  recordAnswer(adcode: string, correct: boolean) {
    const rec = this.data[adcode] ?? this.normalizeRecord({});
    if (correct) rec.correctCount += 1;
    else rec.wrongCount += 1;
    this.syncScore(rec);
    this.data[adcode] = rec;
    this.persist();
  }

  resetPractice() {
    for (const rec of Object.values(this.data)) {
      rec.correctCount = 0;
      rec.wrongCount = 0;
      this.syncScore(rec);
    }
    this.persist();
  }

  mark(adcode: string, learned: boolean) {
    const rec = this.data[adcode] ?? this.normalizeRecord({});
    if (learned) {
      if (!rec.learned) rec.firstLearnedAt = Date.now();
      rec.learned = true;
      rec.reviewCount += 1;
      rec.lastReviewAt = Date.now();
    } else {
      rec.learned = false;
    }
    this.syncScore(rec);
    this.data[adcode] = rec;
    this.persist();
  }

  learnedCount(): number {
    return Object.values(this.data).filter((r) => r.learned).length;
  }

  reset() {
    this.data = {};
    this.persist();
  }
}

function finiteNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function finiteCount(value: unknown) {
  return Math.max(0, Math.floor(finiteNumber(value)));
}

export const DEFAULT_SETTINGS: Settings = {
  selfTimerEnabled: false,
  selfTimerSeconds: 60,
  requireEnter: true,
  autoFollow: true,
  followZoom: 12,
  cityBoundaryTone: 'light',
  provinceBoundaryTone: 'dark',
  darkMode: false,
};
export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SET_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Settings>;
      return {
        ...DEFAULT_SETTINGS,
        ...parsed,
        cityBoundaryTone: boundaryToneOf(parsed.cityBoundaryTone, DEFAULT_SETTINGS.cityBoundaryTone),
        provinceBoundaryTone: boundaryToneOf(parsed.provinceBoundaryTone, DEFAULT_SETTINGS.provinceBoundaryTone),
      };
    }
  } catch {
    /* 忽略 */
  }
  return { ...DEFAULT_SETTINGS };
}

function boundaryToneOf(value: unknown, fallback: BoundaryTone): BoundaryTone {
  return value === 'light' || value === 'mid' || value === 'dark' ? value : fallback;
}

export function saveSettings(s: Settings) {
  try {
    localStorage.setItem(SET_KEY, JSON.stringify(s));
  } catch {
    /* 忽略 */
  }
}
