import type { AppData, Mode, RoundResult, Settings, Unit } from '../types';
import type { MapRenderer } from '../map/renderer';
import type { Matcher } from '../matcher';
import type { MemoryStore } from '../store';
import type { SearchBox } from '../ui/searchBox';
import type { StatsPanel } from '../ui/statsPanel';
import type { ModeSettingsPanel } from '../modeSettings';

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
  showTimer: (remain: number | null, urgent?: boolean) => void;
  showStopwatch: (elapsedMs: number | null) => void;
  showSummary: (html: string, onRestart: () => void, result?: RoundResult) => void;
  hideSummary: () => void;
  updateProgress: () => void;
  randomUnit: (pool: Unit[]) => Unit;
}

export type ProgressSegment = 'pending' | 'green' | 'red';

/** 测试模式出题顺序：输入模式支持 顺序/随机/错题。 */
export type OrderMode = 'sequential' | 'random' | 'wrong';
/** 点击模式出题顺序：仅 随机/错题（无顺序）。 */
export type ClickOrderMode = Exclude<OrderMode, 'sequential'>;

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
  /** 地图空白点击返回全国（从单省/省级全国下钻返回）：模式自定义返回目标粒度。 */
  onBackToNation?(): void;
  pause?(): void;
  resume?(): void;
  isPaused?(): boolean;
  getProgress?(): ModeProgress | null;
  getScopeProvince?(): string | null;
  /** 快照当前会话结果（结算卡片用），未开始返回 null */
  collectResult?(): RoundResult | null;
  /** 是否已有会话进度（切换模式前的确认提示用） */
  hasProgress(): boolean;
  /** 模式会话是否已经开始（地图空白返回确认用） */
  isStarted?(): boolean;
  /** 该模式的设置面板（设置按钮显示内容），返回 null 表示不显示设置按钮 */
  getModeSettings?(): ModeSettingsPanel | null;
}
