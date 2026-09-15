import type { AppData, Continent, Mode, RoundResult, Settings, SubregionId, Unit } from '../types';
import type { MapRenderer } from '../map/renderer';
import type { Matcher } from '../matcher';
import type { MemoryStore } from '../store';
import type { SearchBox } from '../ui/searchBox';
import type { StatsPanel } from '../ui/statsPanel';
import type { ModeSettingsPanel } from '../modeSettings';
import type { Granularity } from '../province';

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
  showSummary: (html: string, onRestart: () => void, result?: RoundResult, restartLabel?: string) => void;
  hideSummary: () => void;
  updateProgress: () => void;
  /**
   * 通知外壳重算本模式的 chrome（按钮/分段行显隐等）。用于**运行状态变化**时立即刷新，
   * 例如拼图「开始」后要收起难度行、回到开始卡片后再放出。
   */
  syncChrome?: () => void;
  randomUnit: (pool: Unit[]) => Unit;
  /**
   * 通知外壳「测验是否进行中」：开始测验时收起排行榜侧栏（答题时不干扰），
   * 结算/重置时自动打开。可选，未提供时不影响模式本身。
   */
  setTestRunning?: (running: boolean) => void;
}

export type ProgressSegment = 'pending' | 'green' | 'red';

/**
 * 题面 / 地图标签的**取名口径**（2026-09：世界档「国名 / 首都 / 国旗」+「中文 / 英文」，省级全国「省名 / 省会 / 简称」）。
 *
 * - `world`：`country` 按国名出题（默认）/ `capital` 按首都名出题 / `flag` **题面给国旗图片**、点地图上对应的国家
 *   （「国旗」这一栏**只在点击模式**出现，见 chromeSync 里对 `#world-name-flag` 的显隐）；
 * - `lang`：`zh` 中文（默认）/ `en` 英文 —— 只换**内容语言**（题面与地图标签），
 *   UI 交互文案（按钮、提示、说明）始终中文，故它不是应用级 i18n 开关；
 * - `province`：`full` 按省名（默认）/ `capital` 按省会名（石家庄）/ `abbr` 按单字简称（沪）。
 *
 * 三档互相独立，且只影响**世界全国**与**省级全国**两档范围：地级（市级全国/单省）与无尽闯关
 * 沿用单位名，不受影响（用户口径：只有这两档需要）。
 *
 * ## 地图标签跟着口径走（2026-09 第二轮）
 * **未开始**时地图上的全量浏览标签也按口径显示：选「首都」就标首都名、选「简称」就标单字简称、
 * 选「国旗」就把国旗小图画在标签上（见 `RenderState.browseLabel` 与 `layers.browseLabelPoint`）。
 * 开始答题后地图只留已作答的绿/红标签 —— 那是**答题反馈**，仍按口径给名字
 * （`displayNameOf` / `provinceLabelTextOf` 是题面、标签、答错提示共用的唯一来源）。
 *
 * ⚠ 唯一的例外是**国旗档的已作答标签仍写国名**：绿/红反馈要能被读懂（"我刚认出来的这面旗是哪国"），
 * 而一张没有配文的国旗在答错时什么也没教给用户。浏览态才画旗。
 */
export interface QuestionNaming {
  world: 'country' | 'capital' | 'flag';
  lang: 'zh' | 'en';
  province: 'full' | 'capital' | 'abbr';
}

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
  onInput(v: string): void;
  onUnitClick(adcode: string): boolean | void;
  onUnitDblClick(adcode: string): void;
  onUnitHover(adcode: string): void;
  onUnitHoverEnd(): void;
  onSkip(): void;
  onEnd(): void;
  /** 重置会话（未实现 = 不支持重置）。 */
  onReset?(): void;
  onViewChange(): void;
  /** 地图空白点击返回全国（从单省/省级全国下钻返回）：模式自定义返回目标粒度。缺省走通用返回（exit + renderer.backToNation + enter）。 */
  onBackToNation?(): void;
  pause(): void;
  resume(): void;
  isPaused(): boolean;
  getProgress(): ModeProgress | null;
  getScopeProvince(): string | null;
  /** 快照当前会话结果（结算卡片用），未开始返回 null */
  collectResult(): RoundResult | null;
  /**
   * 结算卡片已弹出（外壳在弹卡片后调用）：把它记为「已结束」，让未开始的浏览标签复现。
   * 与「暂停」区分：暂停仍是进行中，不走这里。未实现的模式（拼图/无尽/留言板）无需实现。
   */
  onSettlementShown?(): void;
  /** 是否已有会话进度（切换模式前的确认提示用） */
  hasProgress(): boolean;
  /** 模式会话是否已经开始（地图空白返回确认用） */
  isStarted(): boolean;
  /** 该模式的设置面板（设置按钮显示内容），返回 null 表示不显示设置按钮 */
  getModeSettings(): ModeSettingsPanel | null;
  /** 省级全国（省级地图 + 34 省池）视图标记，供表现层决定港澳放大框/按钮布局。非测验模式返回 false。 */
  isProvinceNation?(): boolean;
  /** 世界全国（世界地图 + 195 国池）视图标记。非测验模式返回 false。 */
  isWorldNation?(): boolean;
  /** 当前粒度（输入/点击/自由/熟练度分析用；其它模式返回 null）。 */
  getGranularity?(): Granularity | null;
  /**
   * 拼图模式的两阶段：`scope` = 选范围（显示地图，可下钻）、`board` = 拼图盘面（隐藏地图）。
   * 外壳据此决定「地图 / 拼图画布 / 粒度行 / 进度行」的显隐；非拼图模式返回 undefined。
   */
  puzzlePhase?(): 'scope' | 'board';
  /**
   * 自己维护缩放倍率的模式（拼图盘面）用它报给外壳；返回 null/undefined 表示走地图渲染器的倍率。
   */
  getZoomDisplay?(): number | null;
  /** 切换全国层的世界/省级/市级粒度（输入/点击模式；熟练度分析用 setAnalysisGranularity）。 */
  setGranularity?(g: Granularity): void;
  /** 世界粒度下的当前大洲范围（null=全世界；非世界粒度返回 null）。 */
  getWorldContinent?(): Continent | null;
  /** 切换世界粒度下的大洲范围（仅世界粒度且未开始测试时生效）。 */
  setWorldContinent?(c: Continent | null): void;
  /** 世界粒度下的当前次区域范围（null=全洲；非世界粒度或无大洲时返回 null）。 */
  getWorldSubregion?(): SubregionId | null;
  /** 切换世界粒度下的次区域范围（null=全洲；仅当该大洲分区数 > 1 时生效）。 */
  setWorldSubregion?(s: SubregionId | null): void;
  /** 当前出题顺序（输入/点击用；其它模式返回 null）。 */
  getOrderMode?(): OrderMode | ClickOrderMode | null;
  /** 当前题面/标签的取名口径（输入/点击用；其它模式返回 null）。 */
  getQuestionNaming?(): QuestionNaming | null;
  /** 切换取名口径（只传要改的字段；与 setGranularity 一样：仅未开始时生效）。 */
  setQuestionNaming?(patch: Partial<QuestionNaming>): void;
}
