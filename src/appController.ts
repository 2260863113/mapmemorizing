import { buildIndex } from './data';
import { Matcher } from './matcher';
import { MapRenderer } from './map/renderer';
import { AuthStore } from './authStore';
import { LeaderboardStore, type LeaderboardMode } from './leaderboardStore';
import { MemoryStore, loadSettings } from './store';
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
import { FreeBrowseMode } from './modes/freeBrowse';
import { ClickMode } from './modes/click';
import { PROVINCE_NATION_SCOPE, type Granularity } from './province';
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
import type { AppData, Mode, RoundResult, Settings, Unit } from './types';
import type { ModeCtx, ModeController, ClickOrderMode, OrderMode } from './modes/types';

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

    this.renderer = new MapRenderer($('map'), data, {
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
    this.renderer.setDarkMode(this.settings.darkMode);
    this.renderer.setBoundaryTones(this.settings.cityBoundaryTone, this.settings.provinceBoundaryTone);
    this.zoomDisplay = this.renderer.currentZoom();
    this.renderer.onViewChange = () => {
      this.current?.onViewChange();
      this.current?.refresh();
      this.updateProgress();
      void this.refreshSidePanel();
    };
    this.renderer.onZoomChange = () => {
      this.zoomDisplay = this.renderer.currentZoom();
      this.syncViewChrome();
    };

    const ctx: ModeCtx = {
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
      showSummary: (html, onRestart, result) => showSummary(html, onRestart, result ? () => this.submitRoundResult(result) : undefined),
      hideSummary,
      updateProgress: () => this.updateProgress(),
      randomUnit: (pool: Unit[]) => pool[Math.floor(Math.random() * pool.length)],
    };

    this.selfMode = new InputMode(ctx);
    this.clickMode = new ClickMode(ctx);
    this.freeMode = new AnalysisMode(ctx);
    this.modes = {
      free: this.freeMode,
      self: this.selfMode,
      endless: new EndlessMode(ctx),
      click: this.clickMode,
      memory: new FreeBrowseMode(ctx),
      board: new BoardMode(this.boardPanel),
      admin: this.adminMode,
    };

    this.chrome = new ChromeSync({
      current: () => this.current,
      selfMode: this.selfMode,
      clickMode: this.clickMode,
      freeMode: this.freeMode,
      sidePanel: this.sidePanel,
      zoom: () => this.zoomDisplay,
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
    this.switchMode('click'); // 默认展示点击模式
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
    if (mode !== 'board' && mode !== 'admin') this.renderer.resize();
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

  private backToNationFromMap() {
    hideSummary();
    this.hidePauseOverlay();
    if (this.current?.onBackToNation) {
      // 点击/输入模式的省级全国钻省返回省级全国、自由模式省级档钻省返回省级档
      this.current.onBackToNation();
      this.updateProgress();
      this.syncPauseOverlay();
      return;
    }
    this.current?.exit();
    this.renderer.backToNation();
    this.current?.enter();
    this.updateProgress();
  }

  // ==================== 帮助 / 悬停统计 ====================

  private showHelp() {
    const help = this.currentModeHelp();
    ($('help-title') as HTMLElement).textContent = help.title;
    ($('help-body') as HTMLElement).innerHTML = `<div class="help-text">${help.body}</div>`;
    $('help-panel').classList.remove('hidden');
  }

  private hideHelp() {
    $('help-panel').classList.add('hidden');
  }

  private showHoverStats(adcode: string) {
    if (this.current?.id !== 'free') return;
    if (this.freeMode.getAnalysisGranularity() === 'province') {
      // 省级档：悬停省面 → 顶部卡片显示省名 + 档位词（颜色同地图档位）+ 对错次数
      const province = this.data.provinces.find((p) => p.adcode === adcode);
      if (!province) return;
      const practice = this.store.getProvincePractice(adcode);
      const level = provinceLevelOf(practice.score);
      const card = $('hover-stats');
      card.innerHTML = t('main.hoverStatsProvince', {
        name: province.name,
        levelClass: level,
        levelWord: t(PROVINCE_LEVEL_WORD_KEY[level]),
        correct: practice.correctCount,
        wrong: practice.wrongCount,
      });
      card.classList.remove('hidden');
      return;
    }
    const unit = this.idx.byAdcode.get(adcode);
    if (!unit) return;
    const practice = this.store.getPractice(adcode);
    const level = provinceLevelOf(practice.score);
    const card = $('hover-stats');
    card.innerHTML = t('main.hoverStatsProvince', {
      name: unit.name,
      levelClass: level,
      levelWord: t(PROVINCE_LEVEL_WORD_KEY[level]),
      correct: practice.correctCount,
      wrong: practice.wrongCount,
    });
    card.classList.remove('hidden');
  }

  private hideHoverStats() {
    $('hover-stats').classList.add('hidden');
  }

  private currentModeHelp(): { title: string; body: string } {
    const mode = this.current?.id;
    if (mode === 'self') return { title: t('help.self.title'), body: t('help.self.body') };
    if (mode === 'endless') return { title: t('help.endless.title'), body: t('help.endless.body') };
    if (mode === 'free') return { title: t('help.free.title'), body: t('help.free.body') };
    if (mode === 'click') return { title: t('help.click.title'), body: t('help.click.body') };
    return { title: t('help.memory.title'), body: t('help.memory.body') };
  }

  // ==================== 成绩提交 / 侧栏刷新 ====================

  private submitRoundResult(result: RoundResult, onDone?: () => void) {
    hideSummary();
    this.scoreSubmitter.submit(result, onDone);
  }

  /** 无法提交时的提示文案（按模式区分）。 */
  private rejectToast(result: RoundResult) {
    return result.mode === 'endless' ? t('main.rejectEndless') : t('main.rejectNotAllCorrect');
  }

  /** 提交资格：endless 需有金币；全国 self/click 允许未答完（已答全对即可）；省级维持全对。 */
  private canSubmit(result: RoundResult) {
    if (result.mode === 'endless') return typeof result.coins === 'number' && result.coins > 0;
    if (result.scopeProvince === null) return result.correct > 0 && result.wrong === 0;
    return result.totalUnits > 0 && result.correct + result.wrong === result.totalUnits && result.correct === result.totalUnits && result.wrong === 0;
  }

  private refreshSidePanel(): Promise<void> {
    if (this.current?.id === 'free') {
      if (this.freeMode.getAnalysisGranularity() === 'province') this.stats.refreshProvinceLevel();
      else this.stats.refresh(this.renderer.currentProvince());
      return Promise.resolve();
    }
    if (!this.isLeaderboardMode(this.current?.id)) return Promise.resolve();
    const scopeProvince = this.current.getScopeProvince() ?? null;
    return this.leaderboard.refresh(this.current.id, scopeProvince, this.scopeLabel(scopeProvince));
  }

  private scopeLabel(scopeProvince: string | null) {
    if (scopeProvince === PROVINCE_NATION_SCOPE) return t('common.provinceNation');
    return scopeProvince ? this.data.provinces.find((p) => p.adcode === scopeProvince)?.name ?? t('common.currentProvince') : t('common.nation');
  }

  private isLeaderboardMode(mode: Mode | undefined): mode is LeaderboardMode {
    return mode === 'self' || mode === 'click' || mode === 'endless';
  }

  // ==================== 结算流程 ====================

  private showSettlementCard() {
    const mode = this.current?.id;
    if (mode !== 'self' && mode !== 'click') return;
    const active = this.current as ModeController;
    active.pause();
    const result = active.collectResult() ?? null;
    if (!result) {
      this.doReset();
      return;
    }
    showSettlement(
      `<div style="text-align:center;line-height:1.8;">${t('main.settlementTitle')}<div class="sum-stats">${t('main.settlementSummary', { correct: result.correct, wrong: result.wrong, done: result.correct + result.wrong, total: result.totalUnits, time: formatElapsedCentiseconds(result.elapsedMs) })}</div><div class="sum-stats">${result.scopeProvince === PROVINCE_NATION_SCOPE ? t('main.settlementNoteProvince') : t('main.settlementNote')}</div></div>`,
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

  private wireDom() {
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

    document.querySelectorAll<HTMLButtonElement>('#mode-tabs button').forEach((btn) => {
      btn.addEventListener('click', () => this.switchMode(btn.dataset.mode as Mode));
    });

    // 右区按钮：熟练度分析 → 自由模式；留言板 → 留言板模式
    ($('btn-free') as HTMLButtonElement).addEventListener('click', () => this.switchMode('free'));
    ($('btn-board') as HTMLButtonElement).addEventListener('click', () => this.switchMode('board'));

    const sidePanelToggle = $('side-panel-toggle') as HTMLButtonElement;
    const isAnalysisPanel = () => this.current?.id === 'free';
    sidePanelToggle.addEventListener('pointerdown', (event) => {
      if (!isAnalysisPanel() && !this.isLeaderboardMode(this.current?.id)) return;
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

    document.querySelectorAll<HTMLButtonElement>('#self-order-toggle button').forEach((btn) => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.order as OrderMode;
        this.selfMode.setOrderMode(mode);
        this.syncSegmentedToggle('self-order-toggle', mode);
      });
    });
    document.querySelectorAll<HTMLButtonElement>('#click-order-toggle button').forEach((btn) => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.order as ClickOrderMode;
        this.clickMode.setOrderMode(mode);
        this.syncSegmentedToggle('click-order-toggle', mode);
      });
    });
    // 点击/输入模式的省级/市级粒度切换（仅全国视图、未开始测试时可操作）
    document.querySelectorAll<HTMLButtonElement>('#granularity-toggle button').forEach((btn) => {
      btn.addEventListener('click', () => {
        const g = btn.dataset.granularity as Granularity;
        const target = this.current === this.selfMode ? this.selfMode : this.clickMode;
        if (target.setGranularity) target.setGranularity(g);
        this.syncSegments();
        this.syncModeChrome();
        this.updateProgress();
        void this.refreshSidePanel();
      });
    });

    // 熟练度分析的省级/地级切换
    document.querySelectorAll<HTMLButtonElement>('#analysis-granularity-toggle button').forEach((btn) => {
      btn.addEventListener('click', () => {
        const g = btn.dataset.analysisGranularity as Granularity;
        this.freeMode.setAnalysisGranularity(g);
        this.syncSegments();
        this.syncModeChrome();
        this.updateProgress();
        void this.refreshSidePanel();
      });
    });

    // 点击「开始」按钮后立即锁定分段按钮（开始动作不经过 switchMode，同步需在此重新调用）
    document.addEventListener('click', (event) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest?.('.start-action')) this.syncSegments();
    });

    // 导航栏设置：仅个性化（黑夜模式、边界）
    ($('btn-settings') as HTMLButtonElement).addEventListener('click', () => {
      openSettings(this.settings, (s) => {
        Object.assign(this.settings, s);
        applyTheme(this.settings.darkMode);
        this.renderer.setDarkMode(this.settings.darkMode);
        this.renderer.setBoundaryTones(this.settings.cityBoundaryTone, this.settings.provinceBoundaryTone);
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

    ($('btn-skip') as HTMLButtonElement).addEventListener('click', () => this.current?.onSkip());
    ($('btn-end') as HTMLButtonElement).addEventListener('click', () => {
      this.current?.onEnd();
      if (this.current?.isPaused()) this.showPauseOverlay();
    });
    ($('btn-reset') as HTMLButtonElement).addEventListener('click', (event) => {
      this.confirmAction(event.currentTarget as HTMLButtonElement, () => {
        if (this.current?.isPaused()) this.hidePauseOverlay();
        if (this.current?.id === 'free') {
          if (this.freeMode.getAnalysisGranularity() === 'province') {
            this.store.resetProvincePractice();
            this.stats.refreshProvinceLevel();
          } else {
            this.store.resetPractice();
            this.stats.refresh(this.renderer.currentProvince());
          }
          this.current.refresh();
          toast(t('main.resetMasteryDone'));
          return;
        }
        const mode = this.current?.id;
        const scope = this.current?.getScopeProvince();
        if ((mode === 'self' || mode === 'click') && (scope === null || scope === PROVINCE_NATION_SCOPE) && this.current?.isStarted()) {
          this.showSettlementCard();
          return;
        }
        if (this.current?.onReset) {
          this.current.onReset();
          this.updateProgress();
          this.syncPauseOverlay();
        }
      });
    });

    // 搜索框接线（无下拉联想）
    this.search.onSubmit((v) => this.current?.onSubmit(v));
    this.search.onInput((v) => this.current?.onInput(v));
  }
}
