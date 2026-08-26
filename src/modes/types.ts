import type { AppData, Mode, Settings, Unit } from '../types';
import type { MapRenderer } from '../map/renderer';
import type { Matcher } from '../matcher';
import type { MemoryStore } from '../store';
import type { SearchBox } from '../ui/searchBox';
import type { StatsPanel } from '../ui/statsPanel';

export interface ModeCtx {
  data: AppData;
  renderer: MapRenderer;
  matcher: Matcher;
  store: MemoryStore;
  search: SearchBox;
  stats: StatsPanel;
  settings: Settings;
  byAdcode: Map<string, Unit>;
  toast: (msg: string) => void;
  setHint: (html: string) => void;
  showTimer: (remain: number | null) => void;
  showSummary: (html: string, onRestart: () => void) => void;
  hideSummary: () => void;
  updateProgress: () => void;
  randomUnit: (pool: Unit[]) => Unit;
}

export type ProgressSegment = 'pending' | 'green' | 'red';

export interface ModeProgress {
  total: number;
  segments: ProgressSegment[];
}

export interface ModeController {
  id: Mode;
  title: string;
  enter(): void;
  exit(): void;
  refresh(): void;
  onSubmit(v: string): void;
  onInput?(v: string): void;
  onUnitClick(adcode: string): boolean | void;
  onUnitDblClick(adcode: string): void;
  onUnitHover?(adcode: string): void;
  onUnitHoverEnd?(): void;
  onSkip?(): void;
  onEnd?(): void;
  onReset?(): void;
  onViewChange?(): void;
  getProgress?(): ModeProgress | null;
  /** 是否已有会话进度（切换模式前的确认提示用） */
  hasProgress(): boolean;
  /** 模式会话是否已经开始（地图空白返回确认用） */
  isStarted?(): boolean;
}
