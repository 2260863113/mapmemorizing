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
  randomUnit: (pool: Unit[]) => Unit;
}

export interface ModeController {
  id: Mode;
  title: string;
  enter(): void;
  exit(): void;
  refresh(): void;
  onSubmit(v: string): void;
  onInput?(v: string): void;
  onUnitClick(adcode: string): void;
  onUnitDblClick(adcode: string): void;
  /** 是否已有会话进度（切换模式前的确认提示用） */
  hasProgress(): boolean;
}
