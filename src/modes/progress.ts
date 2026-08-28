import type { AppData, Unit } from '../types';
import type { ModeProgress, ProgressSegment } from './types';

export interface SavedProgressState {
  green: Set<string>;
  red: Set<string>;
  results: ProgressSegment[];
  question: string | null;
  record: Record<string, unknown>;
}

/** 返回当前测试范围内的真实地图单位。 */
export function scopedUnits(data: AppData, scopeProvince: string | null): Unit[] {
  return data.units.filter((unit) => !scopeProvince || unit.provinceAdcode === scopeProvince);
}

/** 返回尚未答题的单位，保持数据文件中的原始顺序。 */
export function unvisitedUnits(
  data: AppData,
  scopeProvince: string | null,
  green: ReadonlySet<string>,
  red: ReadonlySet<string>,
): Unit[] {
  return scopedUnits(data, scopeProvince).filter((unit) => !green.has(unit.adcode) && !red.has(unit.adcode));
}

/** 读取并校验模式范围；undefined 表示没有保存过范围。 */
export function loadScopeProvince(data: AppData, storageKey: string): string | null | undefined {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return undefined;
    const saved = JSON.parse(raw) as { scopeProvince?: unknown };
    if (saved.scopeProvince === null) return null;
    if (typeof saved.scopeProvince === 'string' && data.provinces.some((province) => province.adcode === saved.scopeProvince)) {
      return saved.scopeProvince;
    }
  } catch {
    /* 忽略损坏的范围记录 */
  }
  return undefined;
}

export function saveScopeProvince(storageKey: string, scopeProvince: string | null): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify({ scopeProvince }));
  } catch {
    /* 忽略存储失败 */
  }
}

/** 将地图视图同步到当前测试范围。 */
export function syncScopeView(
  scopeProvince: string | null,
  currentProvince: string | null,
  actions: { drillToProvince: (adcode: string) => void; backToNation: () => void },
): void {
  if (currentProvince === scopeProvince) return;
  if (scopeProvince) actions.drillToProvince(scopeProvince);
  else actions.backToNation();
}

/** 从本地记录恢复通用答题状态，非法 adcode 和进度段会被丢弃。 */
export function loadProgress(storageKey: string, order: readonly string[], legacyResults = false): SavedProgressState {
  const empty: SavedProgressState = { green: new Set(), red: new Set(), results: [], question: null, record: {} };
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return empty;
    const saved = JSON.parse(raw) as Record<string, unknown> & {
      green?: unknown;
      red?: unknown;
      results?: unknown;
      question?: unknown;
    };
    const validIds = new Set(order);
    const green = new Set(stringArray(saved.green).filter((adcode) => validIds.has(adcode)));
    const red = new Set(stringArray(saved.red).filter((adcode) => validIds.has(adcode)));
    const fallback = legacyResults
      ? [...Array(green.size).fill('green'), ...Array(red.size).fill('red')]
      : [];
    const results = (Array.isArray(saved.results) ? saved.results : fallback)
      .filter((segment): segment is ProgressSegment => segment === 'green' || segment === 'red')
      .slice(0, Math.min(order.length, green.size + red.size));
    const question = typeof saved.question === 'string' && validIds.has(saved.question) ? saved.question : null;
    return { green, red, results, question, record: saved };
  } catch {
    /* 忽略损坏的本地进度 */
    return empty;
  }
}

export function saveProgress(storageKey: string, state: ModeProgressState, extra: Record<string, unknown> = {}): void {
  try {
    localStorage.setItem(
      storageKey,
      JSON.stringify({
        ...extra,
        green: [...state.green],
        red: [...state.red],
        results: state.results,
        question: state.question,
      }),
    );
  } catch {
    /* 忽略存储失败 */
  }
}

export interface ModeProgressState {
  green: ReadonlySet<string>;
  red: ReadonlySet<string>;
  results: readonly ProgressSegment[];
  question: string | null;
}

export function clearProgress(storageKey: string): void {
  try {
    localStorage.removeItem(storageKey);
  } catch {
    /* 忽略存储失败 */
  }
}

export function progressOf(total: number, results: readonly ProgressSegment[]): ModeProgress {
  return {
    total,
    segments: [...results, ...Array<ProgressSegment>(Math.max(0, total - results.length)).fill('pending')],
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}
