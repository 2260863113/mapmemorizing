import type { MemoryRecord, Settings } from './types';

const MEM_KEY = 'china-admin-memory-v1';
const SET_KEY = 'china-admin-settings-v1';

/** 自由模式记忆进度（localStorage 持久化 + pub/sub） */
export class MemoryStore {
  private data: Record<string, MemoryRecord> = {};
  private listeners = new Set<() => void>();

  constructor() {
    try {
      const raw = localStorage.getItem(MEM_KEY);
      if (raw) this.data = JSON.parse(raw) as Record<string, MemoryRecord>;
    } catch {
      this.data = {};
    }
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const fn of this.listeners) fn();
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

  mark(adcode: string, learned: boolean) {
    const rec = this.data[adcode] ?? { learned: false, firstLearnedAt: 0, reviewCount: 0, lastReviewAt: 0 };
    if (learned) {
      if (!rec.learned) rec.firstLearnedAt = Date.now();
      rec.learned = true;
      rec.reviewCount += 1;
      rec.lastReviewAt = Date.now();
    } else {
      rec.learned = false;
    }
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

export const DEFAULT_SETTINGS: Settings = {
  selfTimerEnabled: false,
  selfTimerSeconds: 60,
  challengeSeconds: 10,
  requireEnter: true,
  autoFollow: true,
  followZoom: 12,
};

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SET_KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    /* 忽略 */
  }
  return { ...DEFAULT_SETTINGS };
}

export function saveSettings(s: Settings) {
  try {
    localStorage.setItem(SET_KEY, JSON.stringify(s));
  } catch {
    /* 忽略 */
  }
}
