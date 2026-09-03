import type { BoundaryTone, MemoryRecord, Settings } from './types';

const MEM_KEY = 'china-admin-memory-v1';
const SET_KEY = 'china-admin-settings-v1';
const PROV_MEM_KEY = 'china-admin-province-memory-v1';

/** 省级熟练度：以省 adcode 为键的简单对错计数（独立于地级市熟练度）。 */
interface ProvincePractice {
  correctCount: number;
  wrongCount: number;
  score: number;
}

/** 自由模式记忆进度（localStorage 持久化 + pub/sub） */
export class MemoryStore {
  private data: Record<string, MemoryRecord> = {};
  private provData: Record<string, ProvincePractice> = {};
  private listeners = new Set<() => void>();

  constructor() {
    try {
      const raw = localStorage.getItem(MEM_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, Partial<MemoryRecord>>;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
        for (const [adcode, value] of Object.entries(parsed)) {
          if (!value || typeof value !== 'object') continue;
          this.data[adcode] = this.normalizeRecord(value);
        }
      }
    } catch {
      this.data = {};
    }
    this.loadProvinceData();
  }

  private loadProvinceData() {
    try {
      const raw = localStorage.getItem(PROV_MEM_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Record<string, Partial<ProvincePractice>>;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      for (const [adcode, value] of Object.entries(parsed)) {
        if (!value || typeof value !== 'object') continue;
        this.provData[adcode] = {
          correctCount: finiteCount(value.correctCount),
          wrongCount: finiteCount(value.wrongCount),
          score: 0,
        };
        this.syncProvScore(this.provData[adcode]);
      }
    } catch {
      this.provData = {};
    }
  }

  private persistProvince() {
    try {
      localStorage.setItem(PROV_MEM_KEY, JSON.stringify(this.provData));
    } catch {
      /* 忽略存储失败 */
    }
    this.emit();
  }

  private syncProvScore(record: ProvincePractice) {
    record.score = record.correctCount - record.wrongCount;
  }

  /** 省级熟练度查询：省 adcode → { correctCount, wrongCount, score }（默认 0）。 */
  getProvincePractice(adcode: string): Pick<ProvincePractice, 'correctCount' | 'wrongCount' | 'score'> {
    const rec = this.provData[adcode];
    return rec ? { correctCount: rec.correctCount, wrongCount: rec.wrongCount, score: rec.score } : { correctCount: 0, wrongCount: 0, score: 0 };
  }

  /** 省级答题记录（与地级熟练度完全隔离）。 */
  recordProvinceAnswer(adcode: string, correct: boolean) {
    const rec = this.provData[adcode] ?? { correctCount: 0, wrongCount: 0, score: 0 };
    if (correct) rec.correctCount += 1;
    else rec.wrongCount += 1;
    this.syncProvScore(rec);
    this.provData[adcode] = rec;
    this.persistProvince();
  }

  /** 该省是否曾做过省级答题（区分「未知=从未答」与「一般=答过但正负相抵」）。 */
  hasProvincePractice(adcode: string): boolean {
    return !!this.provData[adcode];
  }

  resetProvincePractice() {
    for (const rec of Object.values(this.provData)) {
      rec.correctCount = 0;
      rec.wrongCount = 0;
      this.syncProvScore(rec);
    }
    this.persistProvince();
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
    this.provData = {};
    try {
      localStorage.removeItem(PROV_MEM_KEY);
    } catch {
      /* 忽略存储失败 */
    }
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
