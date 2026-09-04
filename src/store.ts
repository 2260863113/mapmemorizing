import type { BoundaryTone, MemoryRecord, Settings } from './types';

const MEM_KEY = 'china-admin-memory-v1';
const SET_KEY = 'china-admin-settings-v1';
const PROV_MEM_KEY = 'china-admin-province-memory-v1';
const WORLD_MEM_KEY = 'china-admin-world-memory-v1';

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
  private worldData: Record<string, ProvincePractice> = {};
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
    this.loadWorldData();
  }

  private loadProvinceData() {
    this.loadScoreData(PROV_MEM_KEY, (rec) => (this.provData = rec));
  }

  private loadWorldData() {
    this.loadScoreData(WORLD_MEM_KEY, (rec) => (this.worldData = rec));
  }

  private loadScoreData(key: string, assign: (rec: Record<string, ProvincePractice>) => void) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Record<string, Partial<ProvincePractice>>;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      const out: Record<string, ProvincePractice> = {};
      for (const [adcode, value] of Object.entries(parsed)) {
        if (!value || typeof value !== 'object') continue;
        out[adcode] = {
          correctCount: finiteCount(value.correctCount),
          wrongCount: finiteCount(value.wrongCount),
          score: 0,
        };
        out[adcode].score = out[adcode].correctCount - out[adcode].wrongCount;
      }
      assign(out);
    } catch {
      assign({});
    }
  }

  private persistProvince() {
    this.persistScoreData(PROV_MEM_KEY, this.provData);
  }

  private persistWorld() {
    this.persistScoreData(WORLD_MEM_KEY, this.worldData);
  }

  private persistScoreData(key: string, data: Record<string, ProvincePractice>) {
    try {
      localStorage.setItem(key, JSON.stringify(data));
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

  resetProvincePractice() {
    for (const rec of Object.values(this.provData)) {
      rec.correctCount = 0;
      rec.wrongCount = 0;
      this.syncProvScore(rec);
    }
    this.persistProvince();
  }

  /** 国家熟练度查询：iso → { correctCount, wrongCount, score }（默认 0）。 */
  getWorldPractice(iso: string): Pick<ProvincePractice, 'correctCount' | 'wrongCount' | 'score'> {
    const rec = this.worldData[iso];
    return rec ? { correctCount: rec.correctCount, wrongCount: rec.wrongCount, score: rec.score } : { correctCount: 0, wrongCount: 0, score: 0 };
  }

  /** 国家答题记录（与世界粒度答题隔离，独立 localStorage 键）。 */
  recordWorldAnswer(iso: string, correct: boolean) {
    const rec = this.worldData[iso] ?? { correctCount: 0, wrongCount: 0, score: 0 };
    if (correct) rec.correctCount += 1;
    else rec.wrongCount += 1;
    this.syncProvScore(rec);
    this.worldData[iso] = rec;
    this.persistWorld();
  }

  resetWorldPractice() {
    for (const rec of Object.values(this.worldData)) {
      rec.correctCount = 0;
      rec.wrongCount = 0;
      this.syncProvScore(rec);
    }
    this.persistWorld();
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
    this.worldData = {};
    try {
      localStorage.removeItem(PROV_MEM_KEY);
    } catch {
      /* 忽略存储失败 */
    }
    try {
      localStorage.removeItem(WORLD_MEM_KEY);
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
