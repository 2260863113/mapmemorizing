import { buildIndex } from './data';
import { Matcher } from './matcher';
import { MapRenderer } from './map/renderer';
import { AuthStore } from './authStore';
import { LeaderboardStore } from './leaderboardStore';
import { isLeaderboardMode } from './modes/capabilities';
import { MemoryStore, loadSettings, saveSettings } from './store';
import { SearchBox } from './ui/searchBox';
import { AuthPanel } from './ui/authPanel';
import { LeaderboardPanel } from './ui/leaderboardPanel';
import { StatsPanel } from './ui/statsPanel';
import { openSettings } from './ui/settingsPanel';
import { openModeSettings } from './ui/modeSettingsPanel';
import { SidePanelController } from './ui/sidePanelController';
import { ChromeSync } from './ui/chromeSync';
import { $, toast, setHint, showTimer, showStopwatch, showSummary, hideSummary, showSettlement, hideSettlement } from './ui/dom';
import { formatElapsedCentiseconds } from './ui/format';
import { t } from './i18n';
import { AnalysisMode, provinceLevelOf, PROVINCE_LEVEL_WORD_KEY } from './modes/analysis';
import { InputMode } from './modes/input';
import { EndlessMode } from './modes/endless';
import { PuzzleMode, type PuzzleDifficulty } from './modes/puzzle';
import { ClickMode } from './modes/click';
import { continentFromScope, isNationLikeScope, isWorldScope, PROVINCE_NATION_SCOPE, subregionFromScope, WORLD_NATION_SCOPE, type Granularity } from './province';
import { CONTINENTS, type Continent, type SubregionId } from './types';
import { BoardMode } from './modes/board';
import { BoardStore } from './boardStore';
import { BoardPanel } from './ui/boardPanel';
import { AdminMode } from './modes/admin';
import { AdminPanel } from './ui/adminPanel';
import { AnnouncementStore } from './announcementStore';
import { AnnouncementPanel } from './ui/announcementPanel';
import { IntroCard } from './ui/introCard';
import { api } from './api';
import { ScoreSubmitter } from './scoreSubmitter';
import { canSubmitScore } from './scoreRules';
import { parseScopeQuery, type ScopeQuery } from './scopeQuery';
import { applyIgnoreTiny, ensureTinyCountries, ignoredIsos, loadTinyCountries } from './tinyCountries';
import type { AppData, Mode, RoundResult, Settings, Unit } from './types';
import type { ModeCtx, ModeController, ClickOrderMode, OrderMode, QuestionNaming } from './modes/types';
import type { AppDiagnostics } from './appDiagnostics';

function applyTheme(darkMode: boolean) {
  document.body.classList.toggle('theme-dark', darkMode);
}

/**
 * 应用编排层：装配全部面板/渲染器/模式，并把「模式切换、视图 chrome 同步、结算提交、
 * 帮助与悬停统计、DOM 事件接线」集中到一处。main.ts 的 boot 只负责加载数据并启动本控制器，
 * 不再持有任何编排逻辑。
 */
export class AppController {
  private data: AppData;
  private idx: ReturnType<typeof buildIndex>;
  private store: MemoryStore;
  private settings: Settings;
  private matcher: Matcher;
  private search: SearchBox;
  private stats: StatsPanel;
  private authStore: AuthStore;
  private authPanel: AuthPanel;
  private leaderboardStore: LeaderboardStore;
  private leaderboard: LeaderboardPanel;
  private boardPanel: BoardPanel;
  private announcementStore: AnnouncementStore;
  private announcementPanel: AnnouncementPanel;
  private introCard: IntroCard;
  private adminPanel: AdminPanel;
  private adminMode: AdminMode;

  private current: ModeController | null = null;
  private zoomDisplay = 1;
  private sidePanel: SidePanelController;
  private renderer: MapRenderer;
  private chrome: ChromeSync;
  private selfMode: InputMode;
  private clickMode: ClickMode;
  private freeMode: AnalysisMode;
  private puzzleMode: PuzzleMode;
  private modes: Record<Mode, ModeController>;
  private scoreSubmitter: ScoreSubmitter;
  private confirmTimers = new Map<string, number>();

  constructor(data: AppData) {
    this.data = data;
    this.idx = buildIndex(data);
    this.store = new MemoryStore();
    this.settings = loadSettings();
    applyTheme(this.settings.darkMode);
    this.matcher = new Matcher(data);
    this.search = new SearchBox('search-input');
    this.search.setRequireEnter(true); // 每模式设置中按需调整（输入/无尽）
    this.stats = new StatsPanel('stats', data, this.store);
    this.authStore = new AuthStore();
    this.authPanel = new AuthPanel(this.authStore, data);
    this.leaderboardStore = new LeaderboardStore();
    this.leaderboard = new LeaderboardPanel('leaderboard', this.leaderboardStore, data);
    const boardStore = new BoardStore();
    this.boardPanel = new BoardPanel('board', boardStore, this.authStore, this.authPanel);
    this.announcementStore = new AnnouncementStore();
    this.announcementPanel = new AnnouncementPanel('announcement-panel', this.announcementStore);
    this.introCard = new IntroCard('intro-card', this.announcementStore);
    this.adminPanel = new AdminPanel('admin', this.authStore, this.announcementStore, data);
    this.adminMode = new AdminMode(this.adminPanel);

    this.sidePanel = new SidePanelController($('side-panel'), $('side-panel-toggle') as HTMLButtonElement);

    this.renderer = this.createRenderer(data);
    this.zoomDisplay = this.renderer.currentZoom();

    const modes = this.createModes(this.buildModeCtx(data));
    this.selfMode = modes.selfMode;
    this.clickMode = modes.clickMode;
    this.freeMode = modes.freeMode;
    this.puzzleMode = modes.puzzleMode;
    this.modes = modes.modes;

    this.chrome = new ChromeSync({
      current: () => this.current,
      sidePanel: this.sidePanel,
      zoom: () => this.zoomDisplay,
      data,
    });

    this.scoreSubmitter = new ScoreSubmitter(
      this.authStore,
      this.leaderboardStore,
      this.authPanel,
      toast,
      () => void this.refreshSidePanel(),
      (result) => this.rejectToast(result),
      (result) => this.canSubmit(result),
    );
  }

  /**
   * 建渲染器并接上相机回调。
   *
   * 抽出来是因为「new + 5 条回调 + 3 处初始化」原本和 20 行 `new 面板` 挤在同一个构造器里，
   * 读的人分不清哪几行属于地图、哪几行属于面板。cameras 回调里的 `this.renderer` 是延迟求值，
   * 因此这里用局部 `renderer` 更稳。
   */
  private createRenderer(data: AppData): MapRenderer {
    const renderer = new MapRenderer($('map'), data, {
      onUnitClick: (adcode) => this.current?.onUnitClick(adcode),
      onUnitDblClick: (adcode) => this.current?.onUnitDblClick(adcode),
      onBlankClick: () => {
        if (this.current?.isStarted()) {
          toast(t('common.backToNationBlocked'));
          return;
        }
        this.backToNationFromMap();
      },
      onUnitHover: (adcode) => this.showHoverStats(adcode),
      onUnitHoverEnd: () => this.hideHoverStats(),
    });
    renderer.setDarkMode(this.settings.darkMode);
    renderer.setBoundaryTones(this.settings.cityBoundaryTone, this.settings.provinceBoundaryTone, this.settings.worldBoundaryTone);
    renderer.onViewChange = () => {
      this.current?.onViewChange();
      this.current?.refresh();
      this.updateProgress();
      void this.refreshSidePanel();
    };
    renderer.onZoomChange = () => {
      this.zoomDisplay = renderer.currentZoom();
      this.syncViewChrome();
    };
    return renderer;
  }

  /** 模式共享上下文：模式只通过它接触外壳（地图、匹配器、存储、进度行…）。 */
  private buildModeCtx(data: AppData): ModeCtx {
    return {
      data,
      renderer: this.renderer,
      matcher: this.matcher,
      store: this.store,
      search: this.search,
      stats: this.stats,
      settings: this.settings,
      byAdcode: this.idx.byAdcode,
      toast,
      setHint,
      showTimer,
      showStopwatch,
      showSummary: (html, onRestart, result, restartLabel) =>
        showSummary(html, onRestart, result ? () => this.submitRoundResult(result) : undefined, restartLabel),
      hideSummary,
      updateProgress: () => this.updateProgress(),
      syncChrome: () => this.syncModeChrome(),
      randomUnit: (pool: Unit[]) => pool[Math.floor(Math.random() * pool.length)],
      setTestRunning: (running: boolean) => this.setTestRunning(running),
    };
  }

  /**
   * 建全部模式。四个「既进 `modes` 表、又被外壳直接调用」的模式（输入/点击/自由/拼图）
   * 连表一并返回，由构造器落地字段 —— 这样严格遵守 `strictPropertyInitialization`，
   * 不必给字段加 `!` 断言。
   */
  private createModes(ctx: ModeCtx) {
    const selfMode = new InputMode(ctx);
    const clickMode = new ClickMode(ctx);
    const freeMode = new AnalysisMode(ctx);
    const puzzleMode = new PuzzleMode(ctx);
    const modes: Record<Mode, ModeController> = {
      free: freeMode,
      self: selfMode,
      endless: new EndlessMode(ctx),
      click: clickMode,
      puzzle: puzzleMode,
      board: new BoardMode(this.boardPanel),
      admin: this.adminMode,
    };
    return { selfMode, clickMode, freeMode, puzzleMode, modes };
  }

  /**
   * 验收探针的**装配视图**（见 `appDiagnostics.ts` 的说明）。
   *
   * 生产路径不调用（只有 URL 带 `?probe=1` 时探针取一次）。存在的意义是把「探针依赖哪些
   * 私有字段」变成一份**编译器可校验**的契约：方法体在类内部，字段改名 / 删除会让 `tsc`
   * 直接报错，而不是让探针在验收时静默读到 `undefined`。
   */
  diagnostics(): AppDiagnostics {
    const self = this;
    return {
      renderer: this.renderer,
      clickMode: this.clickMode,
      selfMode: this.selfMode,
      freeMode: this.freeMode,
      puzzleMode: this.puzzleMode,
      data: this.data,
      settings: this.settings,
      sidePanel: this.sidePanel,
      get current() { return self.current; },
      syncModeChrome: () => self.syncModeChrome(),
    };
  }

  /**
   * 当前模式的「世界范围」目标（大洲/次区域按钮的作用对象）。
   * 修掉了旧代码的隐患：它写的是 `current === selfMode ? selfMode : clickMode`，
   * 对任何非 self 模式都回落到 clickMode —— 熟练度分析（free）加了大洲行后这会改错模式。
   */
  private worldScopeTarget(): ModeController | null {
    const current = this.current;
    if (!current) return null;
    return current.getWorldContinent ? current : null;
  }

  /** 启动：后台会话恢复、访问日志、公告/管理员/介绍卡片入口，再接线 DOM 并进入默认模式。 */
  start() {
    void this.authStore.restoreSession(); // 后台校验已存会话，不阻塞启动
    void api.visit(this.authStore.sessionToken() ?? undefined).catch(() => {});
    $('btn-announcement').addEventListener('click', () => void this.announcementPanel.open());
    this.authPanel.onAdminAction = (view) => {
      this.adminMode.setView(view);
      this.switchMode('admin');
    };
    void this.introCard.maybeShow();
    this.wireDom();
    this.syncThemeButton();
    void this.initTinyCountrySetting(); // 全局设置：极小国家的清单是异步取的
    void this.applyScopeQuery(); // 落地页深链参数（Q26）：必须在 enter 之前应用
    this.switchMode('click'); // 默认展示点击模式
  }

  /**
   * 把「忽略面积极小的国家」这一全局设置灌进渲染器与出题池。
   *
   * 三条路径必须同时生效，否则会出现割裂体验（能出题却点不动 / 灰显却仍在池里）：
   *   1. 渲染器：极小国家灰显且 `silent`，悬停不高亮、点击无响应；
   *   2. 出题池：所有模式的 `worldScopedPool()` 都按 `ignoredIsos()` 过滤；
   *   3. 排行榜范围：**不裁剪**——成绩单如实标注本次范围，排名池仍按全部答题国，
   *      这样开与不开该设置的用户处在同一张榜上（用户确认的口径）。
   */
  private applyTinyCountrySetting() {
    const on = this.settings.ignoreTinyCountries === true;
    applyIgnoreTiny(on, loadTinyCountries());
    this.renderer.setExcludedCountries(ignoredIsos());
    // 池子变了，当前正在展示的题面/统计需要重算
    this.current?.refresh();
  }

  /** 清单是异步取的：启动时就绪后再应用一次，避免首屏开着设置却没生效。 */
  private async initTinyCountrySetting() {
    try {
      await ensureTinyCountries();
    } catch {
      /* 清单不可用时按「无极小国家」降级，不阻塞启动 */
    }
    this.applyTinyCountrySetting();
  }

  /**
   * 应用 URL 范围参数（Q26）。SEO 落地页上的地名深链到这里，例如
   *   /?g=world&c=AS&s=EAS   → 点击模式 + 世界粒度 + 亚洲 + 东亚
   *   /?g=city&p=440000      → 点击模式 + 市级粒度 + 下钻广东省
   *
   * 非法/过期参数已被 parseScopeQuery 静默丢弃，这里只负责把合法结果灌进点击模式。
   * 不引入 router：地址栏保持 `/`，故与 404 修复（Q27）完全兼容。
   */
  private applyScopeQuery() {
    let q: ScopeQuery;
    try {
      q = parseScopeQuery(window.location.search, this.data);
    } catch {
      return; // 解析失败绝不阻塞启动
    }
    if (!q.granularity && !q.province) return;
    this.clickMode.applyScopeQuery(q);
  }

  // ==================== 确认按钮（二次确认） ====================

  private resetConfirmButton(btn: HTMLButtonElement) {
    const timer = this.confirmTimers.get(btn.id);
    if (timer !== undefined) window.clearTimeout(timer);
    this.confirmTimers.delete(btn.id);
    btn.classList.remove('confirming');
    btn.textContent = btn.dataset.label ?? btn.textContent;
  }

  private resetConfirmButtons() {
    document.querySelectorAll<HTMLButtonElement>('.mode-action.confirming').forEach((b) => this.resetConfirmButton(b));
  }

  private confirmAction(btn: HTMLButtonElement, run: () => void) {
    if (btn.classList.contains('confirming')) {
      this.resetConfirmButton(btn);
      run();
      return;
    }
    this.resetConfirmButtons();
    btn.dataset.label = btn.textContent ?? '';
    btn.textContent = t('common.confirm');
    btn.classList.add('confirming');
    const timer = window.setTimeout(() => this.resetConfirmButton(btn), 3000);
    this.confirmTimers.set(btn.id, timer);
  }

  // ==================== 主题（黑夜/白天模式） ====================

  /**
   * 顶栏主题开关：切换黑夜/白天模式并立即持久化（与全局设置面板同一份 Settings）。
   * 按钮文案始终显示「点击后会切到哪一边」，故需与主题同步刷新。
   */
  private toggleTheme() {
    this.settings.darkMode = !this.settings.darkMode;
    saveSettings(this.settings);
    applyTheme(this.settings.darkMode);
    this.renderer.setDarkMode(this.settings.darkMode);
    this.syncThemeButton();
  }

  private syncThemeButton() {
    const btn = $('btn-theme') as HTMLButtonElement;
    const dark = this.settings.darkMode;
    btn.textContent = dark ? t('topbar.themeLight') : t('topbar.themeDark');
    btn.setAttribute('aria-pressed', String(dark));
  }

  // ==================== 模式切换 ====================

  private switchMode(mode: Mode) {
    if (this.current === this.modes[mode]) return;
    this.resetConfirmButtons();
    hideSummary();
    this.hideHelp();
    this.hideHoverStats();
    // 修复：切换到留言板/管理界面后，顶部开始卡片不消失
    setHint('');
    $('mode-settings-panel').classList.add('hidden'); // 切换模式时收起设置浮层
    const active = this.current;
    if (active?.isStarted() && !active.isPaused()) active.pause();
    if (active && !active.isPaused()) active.exit();
    this.current = this.modes[mode];
    this.renderer.setProvinceMode(false);
    document.querySelectorAll<HTMLButtonElement>('#mode-tabs button').forEach((b) => {
      b.classList.toggle('active', b.dataset.mode === mode);
    });
    this.current.enter();
    this.syncModeChrome();
    this.syncPauseOverlay();
    this.updateProgress();
    void this.refreshSidePanel();
    // 从留言板/管理员切回地图模式时，地图容器由隐藏转显示，需重算画布尺寸
    // （拼图模式用 #puzzle 自己的画布，不需要动隐藏中的 ECharts 画布）
    if (mode !== 'board' && mode !== 'admin' && mode !== 'puzzle') this.renderer.resize();
  }

  // ==================== 视图 chrome 同步（薄委托到 ChromeSync） ====================

  private showPauseOverlay() { this.chrome.showPauseOverlay(); }
  private hidePauseOverlay() { this.chrome.hidePauseOverlay(); }
  private syncPauseOverlay() { this.chrome.syncPauseOverlay(); }
  private syncModeChrome() { this.chrome.syncModeChrome(); }
  private syncViewChrome() { this.chrome.syncViewChrome(); }
  private syncSegmentedToggle(containerId: string, value: string) { this.chrome.syncSegmentedToggle(containerId, value); }
  private updateProgress() { this.chrome.updateProgress(); }
  private syncSegments() { this.chrome.syncSegments(); }

  /**
   * 测验开始/结束时收起或展开排行榜侧栏。
   *
   * 开始测验时收起，答题过程中不占视野；结算或重置后自动展开，方便看榜与提交成绩。
   * 仅对**排行榜**侧栏生效——熟练度分析侧栏（free 模式）与测验无关，不在这里动。
   */
  private setTestRunning(running: boolean) {
    // 熟练度分析模式没有测验生命周期，防御一下避免误改它的侧栏
    if (this.current?.id === 'free') return;
    this.sidePanel.setLeaderboardOpen(!running);
    this.syncModeChrome();
  }

  private backToNationFromMap() {
    hideSummary();
    this.hidePauseOverlay();
    if (this.current?.onBackToNation) {
      // 点击/输入模式的省级全国钻省返回省级全国（下钻后的地级练习返回其所属省，其余走通用返回）
      this.current.onBackToNation();
      this.updateProgress();
      this.syncPauseOverlay();
      // Q13：空白返回会改变世界范围（次区域→大洲→全世界），分段按钮的高亮必须跟着回退。
      // 以前这里不调 syncSegments 也没问题——那时只有省级下钻会走这条路径，
      // 而省级下钻本来就会隐藏整组粒度按钮；现在次区域层是可见的答题层，不刷新就会「按钮说东亚、地图是世界」。
      this.syncSegments();
      return;
    }
    this.current?.exit();
    this.renderer.backToNation();
    this.current?.enter();
    this.updateProgress();
    this.syncSegments();
  }

  // ==================== 帮助 / 悬停统计 ====================

  private showHelp() {
    const help = this.currentModeHelp();
    if (!help) return; // 非地图模式（留言板/管理端）没有说明：按钮已由 chromeSync 隐藏
    ($('help-title') as HTMLElement).textContent = help.title;
    ($('help-body') as HTMLElement).innerHTML = `<div class="help-text">${help.body}</div>`;
    $('help-panel').classList.remove('hidden');
  }

  private hideHelp() {
    $('help-panel').classList.add('hidden');
  }

  /**
   * 悬停统计卡片。
   *
   * 三档粒度（世界 / 省级 / 地级）各自取名字与熟练度的方式不同，但卡片本身逐字相同 ——
   * 原先那份 `t('main.hoverStatsProvince', …)` + 档位词 + 显示，在三个分支里各抄了一遍。
   */
  private showHoverCard(name: string, practice: { correctCount: number; wrongCount: number; score: number }) {
    const level = provinceLevelOf(practice.score);
    const card = $('hover-stats');
    card.innerHTML = t('main.hoverStatsProvince', {
      name,
      levelClass: level,
      levelWord: t(PROVINCE_LEVEL_WORD_KEY[level]),
      correct: practice.correctCount,
      wrong: practice.wrongCount,
    });
    card.classList.remove('hidden');
  }

  private showHoverStats(adcode: string) {
    if (this.current?.id !== 'free') return;
    const granularity = this.freeMode.getAnalysisGranularity();
    if (granularity === 'world') {
      // 世界档：悬停国家 → 顶部卡片显示国名 + 档位词（颜色同地图档位）+ 对错次数
      const country = this.data.countries.find((c) => c.iso === adcode);
      if (country) this.showHoverCard(country.name, this.store.getWorldPractice(adcode));
      return;
    }
    if (granularity === 'province') {
      // 省级档：悬停省面 → 顶部卡片显示省名 + 档位词（颜色同地图档位）+ 对错次数
      const province = this.data.provinces.find((p) => p.adcode === adcode);
      if (province) this.showHoverCard(province.name, this.store.getProvincePractice(adcode));
      return;
    }
    const unit = this.idx.byAdcode.get(adcode);
    if (unit) this.showHoverCard(unit.name, this.store.getPractice(adcode));
  }

  private hideHoverStats() {
    $('hover-stats').classList.add('hidden');
  }

  /**
   * 当前模式的说明文案；返回 `null` 表示该模式没有说明（留言板/管理端不是地图模式，
   * 说明按钮由 chromeSync 在这两个模式下隐藏 —— 以前它们会回落到「自由模式说明」，是错的）。
   */
  private currentModeHelp(): { title: string; body: string } | null {
    const mode = this.current?.id;
    if (mode === 'self') return { title: t('help.self.title'), body: t('help.self.body') };
    if (mode === 'endless') return { title: t('help.endless.title'), body: t('help.endless.body') };
    if (mode === 'free') return { title: t('help.free.title'), body: t('help.free.body') };
    if (mode === 'puzzle') return { title: t('help.puzzle.title'), body: t('help.puzzle.body') };
    if (mode === 'click') return { title: t('help.click.title'), body: t('help.click.body') };
    return null;
  }

  // ==================== 成绩提交 / 侧栏刷新 ====================

  private submitRoundResult(result: RoundResult, onDone?: () => void) {
    hideSummary();
    this.scoreSubmitter.submit(result, onDone);
  }

  /** 无法提交时的提示文案（按模式区分）。 */
  private rejectToast(result: RoundResult) {
    if (result.mode === 'endless') return t('main.rejectEndless');
    if (result.mode === 'puzzle') return t('main.rejectPuzzle');
    return t('main.rejectNotAllCorrect');
  }

  /** 提交资格：endless 需有金币；全国 self/click 允许未答完（已答全对即可）；省级维持全对。 */
  private canSubmit(result: RoundResult) {
    return canSubmitScore(result);
  }

  private refreshSidePanel(): Promise<void> {
    if (this.current?.id === 'free') {
      const granularity = this.freeMode.getAnalysisGranularity();
      if (granularity === 'world') this.stats.refreshWorldLevel();
      else if (granularity === 'province') this.stats.refreshProvinceLevel();
      else this.stats.refresh(this.renderer.currentProvince());
      return Promise.resolve();
    }
    if (!isLeaderboardMode(this.current?.id)) return Promise.resolve();
    const scopeProvince = this.current.getScopeProvince() ?? null;
    return this.leaderboard.refresh(this.current.id, scopeProvince, this.scopeLabel(scopeProvince));
  }

  private scopeLabel(scopeProvince: string | null) {
    if (scopeProvince === PROVINCE_NATION_SCOPE) return t('common.provinceNation');
    if (scopeProvince === WORLD_NATION_SCOPE) return t('common.world');
    const cont = continentFromScope(scopeProvince);
    if (cont) return CONTINENTS.find((c) => c.id === cont)?.name ?? t('common.world');
    const sr = subregionFromScope(scopeProvince);
    if (sr) return this.data.subregions.find((s) => s.id === sr)?.name ?? t('common.world');
    return scopeProvince ? this.data.provinces.find((p) => p.adcode === scopeProvince)?.name ?? t('common.currentProvince') : t('common.nation');
  }

  // ==================== 结算流程 ====================

  /**
   * 结算卡片（中途终止提交成绩）。
   *
   * 点击/输入模式：全国范围进行中按「重置」触发；
   * 拼图模式：**只有可提交的两个范围**（世界全国 / 市级全国）才弹，其余范围直接重置（用户口径）。
   */
  private showSettlementCard() {
    const mode = this.current?.id;
    if (mode !== 'self' && mode !== 'click' && mode !== 'puzzle') return;
    const active = this.current as ModeController;
    active.pause();
    // 记「已结束」：结算卡片既已弹出，未开始的浏览标签就该复现（口径见 browseLabels.ts）
    active.onSettlementShown?.();
    const result = active.collectResult() ?? null;
    if (!result) {
      this.doReset();
      return;
    }
    const isPuzzle = mode === 'puzzle';
    showSettlement(
      `<div style="text-align:center;line-height:1.8;">${t('main.settlementTitle')}<div class="sum-stats">${
        isPuzzle
          ? t('main.settlementSummaryPuzzle', { placed: result.correct, total: result.totalUnits, time: formatElapsedCentiseconds(result.elapsedMs) })
          : t('main.settlementSummary', { correct: result.correct, wrong: result.wrong, done: result.correct + result.wrong, total: result.totalUnits, time: formatElapsedCentiseconds(result.elapsedMs) })
      }</div><div class="sum-stats">${
        isPuzzle
          ? t('main.settlementNotePuzzle')
          : result.scopeProvince === PROVINCE_NATION_SCOPE
            ? t('main.settlementNoteProvince')
            : isWorldScope(result.scopeProvince)
              ? t('main.settlementNoteWorld')
              : t('main.settlementNote')
      }</div></div>`,
      () => this.submitSettlement(result),
      () => this.closeSettlement(),
    );
  }

  private submitSettlement(result: RoundResult) {
    if (!this.canSubmit(result)) {
      toast(this.rejectToast(result));
      return;
    }
    this.submitRoundResult(result, () => {
      hideSettlement();
      this.doReset();
    });
  }

  private closeSettlement() {
    hideSettlement();
    this.doReset();
  }

  private doReset() {
    if (this.current?.isPaused()) this.hidePauseOverlay();
    if (this.current?.onReset) {
      this.current.onReset();
      this.updateProgress();
      this.syncPauseOverlay();
    }
  }

  // ==================== DOM 事件接线 ====================

  /**
   * DOM 接线总表。
   *
   * 原先这里是一个 200 行的顺序函数：17 组互不相干的接线首尾相接，想找某个按钮的 handler
   * 必须读完全文；而且「改完范围后刷新外壳」的四步收尾在 4 个 handler 里逐字重复。
   * 现在按域拆成下面的方法，本函数只做分发 —— 一眼能看出应用一共接了哪些线。
   */
  private wireDom() {
    this.wireOverlays();
    this.wireModeNavigation();
    this.wireSidePanelToggle();
    this.wireOrderToggles();
    this.wireScopeToggles();
    this.wireSettings();
    this.wireTestControls();
    this.wireStartActionLock();
    this.wireSearch();
  }

  /** 两个浮层：暂停遮罩（点击恢复）与帮助面板。 */
  private wireOverlays() {
    ($('pause-overlay') as HTMLElement).addEventListener('click', () => {
      if (!this.current?.isPaused()) return;
      this.current.resume();
      this.syncPauseOverlay();
      this.syncModeChrome();
      this.updateProgress();
    });

    ($('btn-help') as HTMLButtonElement).addEventListener('click', () => this.showHelp());
    ($('help-close') as HTMLButtonElement).addEventListener('click', () => this.hideHelp());
    $('help-panel').addEventListener('click', (event) => {
      if (event.target === $('help-panel')) this.hideHelp();
    });
  }

  /** 模式切换入口：顶部模式标签 + 右区两个入口按钮。 */
  private wireModeNavigation() {
    document.querySelectorAll<HTMLButtonElement>('#mode-tabs button').forEach((btn) => {
      btn.addEventListener('click', () => this.switchMode(btn.dataset.mode as Mode));
    });

    // 右区按钮：熟练度分析 → free 模式；留言板 → 留言板模式
    ($('btn-free') as HTMLButtonElement).addEventListener('click', () => this.switchMode('free'));
    ($('btn-board') as HTMLButtonElement).addEventListener('click', () => this.switchMode('board'));
  }

  /** 侧栏把手：拖拽调宽 / 点击开合（仅排行榜与熟练度分析侧栏可用）。 */
  private wireSidePanelToggle() {
    const sidePanelToggle = $('side-panel-toggle') as HTMLButtonElement;
    const isAnalysisPanel = () => this.current?.id === 'free';
    sidePanelToggle.addEventListener('pointerdown', (event) => {
      if (!isAnalysisPanel() && !isLeaderboardMode(this.current?.id)) return;
      this.sidePanel.beginDrag(event.pointerId, event.clientX, isAnalysisPanel());
    });
    sidePanelToggle.addEventListener('pointermove', (event) => {
      this.sidePanel.moveDrag(event.pointerId, event.clientX, isAnalysisPanel());
      this.syncModeChrome();
    });
    sidePanelToggle.addEventListener('pointerup', (event) => this.sidePanel.endDrag(event.pointerId, isAnalysisPanel()));
    sidePanelToggle.addEventListener('pointercancel', (event) => this.sidePanel.endDrag(event.pointerId, isAnalysisPanel()));
    sidePanelToggle.addEventListener('lostpointercapture', (event) => this.sidePanel.endDrag(event.pointerId, isAnalysisPanel()));
    sidePanelToggle.addEventListener('click', () => {
      if (this.sidePanel.consumeSuppressClick()) return;
      this.sidePanel.toggle(isAnalysisPanel());
      this.syncModeChrome();
      void this.refreshSidePanel();
    });
  }

  /**
   * 给一个分段按钮组接线：选择器统一为 `#<containerId> button`。
   * 原先 6 处 `querySelectorAll(...).forEach(addEventListener)` 是逐字重复的。
   */
  private wireSegmented(containerId: string, onPick: (btn: HTMLButtonElement) => void) {
    document.querySelectorAll<HTMLButtonElement>(`#${containerId} button`).forEach((btn) => {
      btn.addEventListener('click', () => onPick(btn));
    });
  }

  /**
   * 范围/粒度类按钮点完后的统一收尾：分段高亮 → 模式 chrome → 进度行 → 侧栏。
   *
   * 这四步原先在 4 个 handler 里逐字重复，漏一处就会出现「按钮说东亚、地图是世界」
   * （README 记过这个缺陷）。
   */
  private afterScopeChange() {
    this.syncSegments();
    this.syncModeChrome();
    this.updateProgress();
    void this.refreshSidePanel();
  }

  /** 出题顺序分段（输入模式支持 顺序/随机/错题；点击模式没有「顺序」）。 */
  private wireOrderToggles() {
    this.wireSegmented('self-order-toggle', (btn) => {
      const order = btn.dataset.order as OrderMode;
      this.selfMode.setOrderMode(order);
      this.syncSegmentedToggle('self-order-toggle', order);
    });
    this.wireSegmented('click-order-toggle', (btn) => {
      const order = btn.dataset.order as ClickOrderMode;
      this.clickMode.setOrderMode(order);
      this.syncSegmentedToggle('click-order-toggle', order);
    });
  }

  /** 范围类分段按钮：粒度、大洲、次区域、熟练度分析档位，以及拼图难度。 */
  private wireScopeToggles() {
    // 点击/输入模式的「世界/省级/市级」粒度切换（仅全国视图、未开始测试时可操作）
    this.wireSegmented('granularity-toggle', (btn) => {
      const g = btn.dataset.granularity as Granularity;
      // 以当前模式为准：输入/点击各自记住自己的粒度，其它支持粒度的模式自己处理
      const target = this.current?.setGranularity ? this.current : this.clickMode;
      target.setGranularity?.(g);
      this.afterScopeChange();
    });

    // 拼图模式的「简单/困难」：只影响是否显示省名，不是范围变化，故不走 afterScopeChange
    this.wireSegmented('puzzle-difficulty-toggle', (btn) => {
      this.puzzleMode.setDifficulty(btn.dataset.puzzleDifficulty as PuzzleDifficulty);
      this.syncSegmentedToggle('puzzle-difficulty-toggle', this.puzzleMode.getDifficulty());
    });

    // 世界粒度下的「全世界/各大洲」范围切换
    // （测验模式仅世界粒度、全国视图、未开始测试时可操作；熟练度分析世界档无「开始」概念，随时可切）
    this.wireSegmented('continent-toggle', (btn) => {
      const raw = btn.dataset.continent ?? '';
      this.worldScopeTarget()?.setWorldContinent?.(raw ? (raw as Continent) : null);
      this.afterScopeChange();
    });

    // 次区域行的按钮由 chromeSync 按当前大洲**动态重建**，故用事件委托而非逐按钮接线。
    $('subregion-toggle').addEventListener('click', (event) => {
      const btn = (event.target as HTMLElement | null)?.closest?.('button[data-subregion]') as HTMLButtonElement | null;
      if (!btn) return;
      const raw = btn.dataset.subregion ?? '';
      this.worldScopeTarget()?.setWorldSubregion?.(raw ? (raw as SubregionId) : null);
      this.afterScopeChange();
    });

    // 熟练度分析的省级/地级切换
    this.wireSegmented('analysis-granularity-toggle', (btn) => {
      this.freeMode.setAnalysisGranularity(btn.dataset.analysisGranularity as Granularity);
      this.afterScopeChange();
    });

    // 取名口径（2026-09 新增）：世界档「国名/首都」与「中文/英文」、省级全国档「省名/简称」。
    // 只改题面与地图标签的文字，**不动范围**，故不走 afterScopeChange（那会白刷进度条与侧栏）；
    // 模式自己负责重绘（setQuestionNaming 内部 refresh），这里只要把分段高亮同步过来。
    this.wireSegmented('world-name-toggle', (btn) => {
      this.namingTarget()?.setQuestionNaming?.({ world: btn.dataset.worldName as QuestionNaming['world'] });
      this.syncModeChrome();
    });
    this.wireSegmented('world-lang-toggle', (btn) => {
      this.namingTarget()?.setQuestionNaming?.({ lang: btn.dataset.worldLang as QuestionNaming['lang'] });
      this.syncModeChrome();
    });
    this.wireSegmented('province-name-toggle', (btn) => {
      this.namingTarget()?.setQuestionNaming?.({ province: btn.dataset.provinceName as QuestionNaming['province'] });
      this.syncModeChrome();
    });
  }

  /** 支持取名口径切换的当前模式（输入/点击）；其它模式返回 null。 */
  private namingTarget(): ModeController | null {
    const current = this.current;
    return current?.getQuestionNaming ? current : null;
  }

  /** 主题开关 + 全局设置面板 + 每模式设置浮层。 */
  private wireSettings() {
    // 顶栏「黑夜模式 / 白天模式」开关（位于全局设置按钮左侧）：文案显示点击后将切换到的主题
    ($('btn-theme') as HTMLButtonElement).addEventListener('click', () => this.toggleTheme());

    // 导航栏设置：个性化（地级/省级/世界边界深浅）+ 答题范围（忽略面积极小的国家）
    ($('btn-settings') as HTMLButtonElement).addEventListener('click', () => {
      openSettings(this.settings, (s) => {
        Object.assign(this.settings, s);
        applyTheme(this.settings.darkMode);
        this.syncThemeButton();
        this.renderer.setDarkMode(this.settings.darkMode);
        this.renderer.setBoundaryTones(this.settings.cityBoundaryTone, this.settings.provinceBoundaryTone, this.settings.worldBoundaryTone);
        this.applyTinyCountrySetting();
      });
    });

    // 每模式设置按钮：打开当前模式的设置浮层
    ($('btn-mode-settings') as HTMLButtonElement).addEventListener('click', () => {
      const panel = this.current?.getModeSettings();
      if (panel) openModeSettings(panel);
    });
    // 模式切换时关闭设置浮层
    $('mode-settings-panel').addEventListener('click', (event) => {
      if (event.target === $('mode-settings-panel')) $('mode-settings-panel').classList.add('hidden');
    });
  }

  /** 答题控制：跳过 / 结束 / 重置。 */
  private wireTestControls() {
    ($('btn-skip') as HTMLButtonElement).addEventListener('click', () => this.current?.onSkip());
    ($('btn-end') as HTMLButtonElement).addEventListener('click', () => {
      this.current?.onEnd();
      if (this.current?.isPaused()) this.showPauseOverlay();
    });
    ($('btn-reset') as HTMLButtonElement).addEventListener('click', (event) => {
      this.confirmAction(event.currentTarget as HTMLButtonElement, () => this.onResetClicked());
    });
  }

  /**
   * 「重置」确认后真正执行：可提交的范围先弹结算卡片，否则走模式自己的重置。
   * 从 39 行的内联 handler 里抽出来 —— 那是唯一一处把业务判断混进 DOM 接线的地方。
   */
  private onResetClicked() {
    if (this.current?.isPaused()) this.hidePauseOverlay();

    if (this.current?.id === 'free') {
      this.resetMastery();
      return;
    }
    const mode = this.current?.id;
    const scope = this.current?.getScopeProvince();
    const isNationScope = isNationLikeScope(scope); // 含 null（市级全国）、省级/世界全国与大洲范围
    if ((mode === 'self' || mode === 'click') && isNationScope && this.current?.isStarted()) {
      this.showSettlementCard();
      return;
    }
    // 拼图模式：只有可提交的两个范围（世界全国 / 市级全国）进行中才弹结算卡片，
    // 其余范围（省级全国、大洲、次区域、下钻某省）直接重置（用户口径）
    if (mode === 'puzzle' && this.puzzleMode.isRankedScope() && this.current?.isStarted()) {
      this.showSettlementCard();
      return;
    }
    if (this.current?.onReset) {
      this.current.onReset();
      this.updateProgress();
      this.syncPauseOverlay();
    }
  }

  /** 熟练度分析的重置：按当前分析档位清空对应层级的熟练度。 */
  private resetMastery() {
    const granularity = this.freeMode.getAnalysisGranularity();
    if (granularity === 'world') {
      this.store.resetWorldPractice();
      this.stats.refreshWorldLevel();
    } else if (granularity === 'province') {
      this.store.resetProvincePractice();
      this.stats.refreshProvinceLevel();
    } else {
      this.store.resetPractice();
      this.stats.refresh(this.renderer.currentProvince());
    }
    this.current?.refresh();
    toast(t('main.resetMasteryDone'));
  }

  /**
   * 「开始」按钮不经过 `switchMode`，所以「开始后锁定分段按钮」需要在这里补一次同步。
   * 用委托而非逐按钮接线：开始卡片是被模式动态重建的。
   */
  private wireStartActionLock() {
    document.addEventListener('click', (event) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest?.('.start-action')) this.syncSegments();
    });
  }

  /** 搜索框接线（无下拉联想）。 */
  private wireSearch() {
    this.search.onSubmit((v) => this.current?.onSubmit(v));
    this.search.onInput((v) => this.current?.onInput(v));
  }

}
