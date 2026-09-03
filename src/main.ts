import './styles.css';
import { loadData, buildIndex } from './data';
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
import { $, toast, setHint, showTimer, showStopwatch, showSummary, hideSummary, showSettlement, hideSettlement } from './ui/dom';
import { formatElapsedCentiseconds } from './ui/format';
import { ApiError } from './api';
import { t } from './i18n';
import { FreeMode, provinceLevelOf, PROVINCE_LEVEL_WORD_KEY } from './modes/free';
import { SelfTestMode } from './modes/selfTest';
import { EndlessMode } from './modes/endless';
import { MemoryMode } from './modes/memory';
import { ClickMode } from './modes/click';
import { DailyMode, type DailyAnswerMode } from './modes/daily';
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
import type { Mode, RoundResult, Settings, Unit } from './types';
import type { ModeCtx, ModeController, ClickOrderMode, OrderMode } from './modes/types';

const SIDE_PANEL_KEY = 'china-admin-leaderboard-panel-v2';
const SIDE_PANEL_MIN_WIDTH = 240;
const SIDE_PANEL_MAX_WIDTH = 420;
const SIDE_PANEL_DEFAULT_WIDTH = 300;

function applyTheme(darkMode: boolean) {
  document.body.classList.toggle('theme-dark', darkMode);
}

function loadSidePanelOpen() {
  try {
    const raw = localStorage.getItem(SIDE_PANEL_KEY);
    if (!raw) return true; // 首次进入默认打开排行榜侧边栏
    return JSON.parse(raw)?.open !== false;
  } catch {
    return true;
  }
}

function loadSidePanelWidth() {
  try {
    const raw = localStorage.getItem(SIDE_PANEL_KEY);
    const width = raw ? Number(JSON.parse(raw)?.width) : SIDE_PANEL_DEFAULT_WIDTH;
    return clamp(width, SIDE_PANEL_MIN_WIDTH, SIDE_PANEL_MAX_WIDTH);
  } catch {
    return SIDE_PANEL_DEFAULT_WIDTH;
  }
}

function saveSidePanelState(open: boolean, width: number) {
  try {
    localStorage.setItem(SIDE_PANEL_KEY, JSON.stringify({ open, width }));
  } catch {
    /* 忽略存储失败 */
  }
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

async function boot() {
  const data = await loadData();
  const idx = buildIndex(data);
  const store = new MemoryStore();
  const settings: Settings = loadSettings();
  applyTheme(settings.darkMode);
  const matcher = new Matcher(data);
  const search = new SearchBox('search-input');
  search.setRequireEnter(true); // 每模式设置中按需调整（输入/无尽）
  const stats = new StatsPanel('stats', data, store);
  const authStore = new AuthStore();
  void authStore.restoreSession(); // 后台校验已存会话，不阻塞启动
  const authPanel = new AuthPanel(authStore, data);
  const leaderboardStore = new LeaderboardStore();
  const leaderboard = new LeaderboardPanel('leaderboard', leaderboardStore, data);
  const boardStore = new BoardStore();
  const boardPanel = new BoardPanel('board', boardStore, authStore, authPanel);
  const announcementStore = new AnnouncementStore();
  const announcementPanel = new AnnouncementPanel('announcement-panel', announcementStore);
  const introCard = new IntroCard('intro-card', announcementStore);
  const adminPanel = new AdminPanel('admin', authStore, announcementStore, data);
  const adminMode = new AdminMode(adminPanel);

  // 访问日志上报（带 token 记录登录用户）
  void api.visit(authStore.sessionToken() ?? undefined).catch(() => {});
  // 公告按钮 → 弹出公告浮层
  $('btn-announcement').addEventListener('click', () => void announcementPanel.open());
  // 管理员入口回调：切换到 admin 模式并打开对应视图
  authPanel.onAdminAction = (view) => {
    adminMode.setView(view);
    switchMode('admin');
  };
  // 介绍卡片：首次进入弹出「站点介绍」
  void introCard.maybeShow();

  let pendingLeaderboardResult: RoundResult | null = null;
  let current: ModeController | null = null;
  let statsVisible = true;
  let sidePanelOpen = loadSidePanelOpen();
  let sidePanelWidth = loadSidePanelWidth();
  let suppressSidePanelClick = false;
  let zoomDisplay = 1;
  $('side-panel').style.setProperty('--side-panel-width', `${sidePanelWidth}px`);
  const renderer = new MapRenderer($('map'), data, {
    onUnitClick: (adcode) => current?.onUnitClick(adcode),
    onUnitDblClick: (adcode) => current?.onUnitDblClick(adcode),
    onBlankClick: () => {
      if (current?.isStarted?.()) {
        toast(t('common.backToNationBlocked'));
        return;
      }
      backToNationFromMap();
    },
    onUnitHover: (adcode) => showHoverStats(adcode),
    onUnitHoverEnd: () => hideHoverStats(),
  });
  renderer.setDarkMode(settings.darkMode);
  renderer.setBoundaryTones(settings.cityBoundaryTone, settings.provinceBoundaryTone);
  zoomDisplay = renderer.currentZoom();
  renderer.onViewChange = () => {
    current?.onViewChange?.();
    current?.refresh();
    updateProgress();
    refreshSidePanel();
  };
  renderer.onZoomChange = () => {
    zoomDisplay = renderer.currentZoom();
    syncViewChrome();
  };

  const ctx: ModeCtx = {
    data,
    renderer,
    matcher,
    store,
    search,
    stats,
    settings,
    byAdcode: idx.byAdcode,
    toast,
    setHint,
    showTimer,
    showStopwatch,
    showSummary: (html, onRestart, result) => showSummary(html, onRestart, result ? () => submitRoundResult(result) : undefined),
    hideSummary,
    updateProgress,
    randomUnit: (pool: Unit[]) => pool[Math.floor(Math.random() * pool.length)],
  };

  const selfMode = new SelfTestMode(ctx);
  const clickMode = new ClickMode(ctx);
  const dailyMode = new DailyMode(ctx);
  const freeMode = new FreeMode(ctx);
  const modes: Record<Mode, ModeController> = {
    daily: dailyMode,
    free: freeMode,
    self: selfMode,
    endless: new EndlessMode(ctx),
    click: clickMode,
    memory: new MemoryMode(ctx),
    board: new BoardMode(boardPanel),
    admin: adminMode,
  };

  const confirmTimers = new Map<string, number>();

  function resetConfirmButton(btn: HTMLButtonElement) {
    const timer = confirmTimers.get(btn.id);
    if (timer !== undefined) window.clearTimeout(timer);
    confirmTimers.delete(btn.id);
    btn.classList.remove('confirming');
    btn.textContent = btn.dataset.label ?? btn.textContent;
  }

  function resetConfirmButtons() {
    document.querySelectorAll<HTMLButtonElement>('.mode-action.confirming').forEach(resetConfirmButton);
  }

  function confirmAction(btn: HTMLButtonElement, run: () => void) {
    if (btn.classList.contains('confirming')) {
      resetConfirmButton(btn);
      run();
      return;
    }
    resetConfirmButtons();
    btn.dataset.label = btn.textContent ?? '';
    btn.textContent = t('common.confirm');
    btn.classList.add('confirming');
    const timer = window.setTimeout(() => resetConfirmButton(btn), 3000);
    confirmTimers.set(btn.id, timer);
  }

  function switchMode(mode: Mode) {
    if (current === modes[mode]) return;
    resetConfirmButtons();
    hideSummary();
    hideHelp();
    hideHoverStats();
    // 修复：切换到留言板/管理界面后，顶部开始卡片不消失
    setHint('');
    $('mode-settings-panel').classList.add('hidden'); // 切换模式时收起设置浮层
    const active = current;
    if (active?.isStarted?.() && !active.isPaused?.()) active.pause?.();
    if (active && !active.isPaused?.()) active.exit();
    current = modes[mode];
    // 退出每日竞速的省级视图：即使 daily 处于暂停（未 exit），进入其他模式也恢复地级边界
    if (mode !== 'daily') renderer.setProvinceMode(false);
    document.querySelectorAll<HTMLButtonElement>('#mode-tabs button').forEach((b) => {
      b.classList.toggle('active', b.dataset.mode === mode);
    });
    // 每日竞速：仅「输入」作答方式时显示搜索框
    const inputMode = mode === 'self' || mode === 'endless' || (mode === 'daily' && dailyMode.getAnswerMode() === 'input');
    $('search-row').classList.toggle('hidden', !inputMode);
    current.enter();
    syncModeChrome();
    syncPauseOverlay();
    updateProgress();
    refreshSidePanel();
    // 从留言板/管理员切回地图模式时，地图容器由隐藏转显示，需重算画布尺寸
    if (mode !== 'board' && mode !== 'admin') renderer.resize();
  }

  function showPauseOverlay() {
    $('pause-overlay').classList.remove('hidden');
    $('app').classList.add('test-paused');
  }

  function hidePauseOverlay() {
    $('pause-overlay').classList.add('hidden');
    $('app').classList.remove('test-paused');
  }

  function syncPauseOverlay() {
    if (current?.isPaused?.()) showPauseOverlay();
    else hidePauseOverlay();
  }

  function syncModeChrome() {
    const mode = current?.id;
    const isNonMap = mode === 'board' || mode === 'admin';
    const isAnalysis = mode === 'free';
    const isTest = mode === 'self' || mode === 'endless' || mode === 'click' || mode === 'daily';
    const showLeaderboard = mode === 'self' || mode === 'click' || mode === 'endless' || mode === 'daily';
    if (!isTest) {
      showTimer(null);
      showStopwatch(null);
    }
    $('app').dataset.mode = mode ?? '';
    // 点击/输入模式处于省级全国（含港澳放大框）时，左下说明/缩放按钮上移避免被放大框遮挡
    const provinceNationInset =
      (mode === 'click' || mode === 'self') &&
      (current === clickMode ? clickMode.isProvinceNation() : selfMode.isProvinceNation());
    $('app').dataset.provinceInset = provinceNationInset ? '1' : '';
    $('map').classList.toggle('hidden', isNonMap);
    $('board').classList.toggle('hidden', mode !== 'board');
    $('admin').classList.toggle('hidden', mode !== 'admin');
    $('mode-info').classList.toggle('hidden', isNonMap);
    $('endless-status').classList.toggle('hidden', mode !== 'endless' || !current?.isStarted?.());
    // 每模式设置按钮：该模式提供设置面板时显示
    $('btn-mode-settings').classList.toggle('hidden', !current?.getModeSettings?.());
    $('endless-items').classList.toggle('hidden', mode !== 'endless');
    $('endless-token').classList.toggle('hidden', mode !== 'endless');
    $('endless-food').classList.toggle('hidden', mode !== 'endless');
    if (mode !== 'endless') {
      $('endless-shop').classList.add('hidden');
    }
    const showSidePanel = (isAnalysis || showLeaderboard) && !isNonMap;
    const panelOpen = isAnalysis ? statsVisible : sidePanelOpen;
    $('side-panel').classList.toggle('hidden', !showSidePanel);
    $('side-panel').classList.toggle('collapsed', showSidePanel && !panelOpen);
    ($('side-panel-toggle') as HTMLButtonElement).setAttribute('aria-expanded', String(panelOpen));
    $('stats').classList.toggle('hidden', !isAnalysis);
    $('leaderboard').classList.toggle('hidden', !showLeaderboard);
    $('side-panel-title').classList.toggle('hidden', !isAnalysis);
    $('side-panel-title').textContent = t('main.sideTitle');
    $('side-panel-tip').textContent = isAnalysis ? t('main.sideTipAnalysis') : t('main.sideTipLeaderboard');
    $('mode-actions').classList.toggle('hidden', !isTest && !isAnalysis && !isNonMap);
    // 每日竞速无跳过按钮
    $('btn-skip').classList.toggle('hidden', !isTest || mode === 'endless' || mode === 'daily');
    $('btn-end').classList.toggle('hidden', !isTest);
    $('btn-reset').classList.toggle('hidden', !isTest && !isAnalysis);
    syncSegments();
    ($('btn-reset') as HTMLButtonElement).textContent = isAnalysis ? t('common.resetMastery') : t('common.reset');
    syncViewChrome();
  }

  function syncViewChrome() {
    $('zoom-pill').textContent = `${zoomDisplay.toFixed(2)}x`;
  }

  function syncSegmentedToggle(containerId: string, current: string) {
    document.querySelectorAll<HTMLButtonElement>(`#${containerId} button`).forEach((btn) => {
      const value = btn.dataset.order ?? btn.dataset.granularity ?? btn.dataset.analysisGranularity ?? btn.dataset.mode;
      const active = value === current;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-checked', String(active));
    });
  }

  function updateProgress() {
    // 分段按钮显隐/锁定随模式状态同步：开始/作答/结束/重置都会经过这里
    syncSegments();
    const el = $('mode-progress');
    const progress = current?.getProgress?.() ?? null;
    if (!progress || (current?.id !== 'self' && current?.id !== 'click' && current?.id !== 'daily')) {
      el.classList.add('hidden');
      el.innerHTML = '';
      return;
    }
    el.classList.remove('hidden');
    el.innerHTML = progress.segments
      .map((segment) => `<span class="progress-segment ${segment}"></span>`)
      .join('');
  }

  function backToNationFromMap() {
    hideSummary();
    hidePauseOverlay();
    if (current?.onBackToNation) {
      // 点击/输入模式的省级全国钻省返回省级全国、自由模式省级档钻省返回省级档
      current.onBackToNation();
      updateProgress();
      syncPauseOverlay();
      return;
    }
    current?.exit();
    renderer.backToNation();
    current?.enter();
    updateProgress();
  }

  function showHelp() {
    const help = currentModeHelp();
    ($('help-title') as HTMLElement).textContent = help.title;
    ($('help-body') as HTMLElement).innerHTML = `<div class="help-text">${help.body}</div>`;
    $('help-panel').classList.remove('hidden');
  }

  function hideHelp() {
    $('help-panel').classList.add('hidden');
  }

  function showHoverStats(adcode: string) {
    if (current?.id !== 'free') return;
    if (freeMode.getAnalysisGranularity() === 'province') {
      // 省级档：悬停省面 → 顶部卡片显示省名 + 档位词（颜色同地图档位）+ 对错次数
      const province = data.provinces.find((p) => p.adcode === adcode);
      if (!province) return;
      const practice = store.getProvincePractice(adcode);
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
    const unit = idx.byAdcode.get(adcode);
    if (!unit) return;
    const practice = store.getPractice(adcode);
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

  function hideHoverStats() {
    $('hover-stats').classList.add('hidden');
  }

  let pendingLeaderboardOnDone: (() => void) | null = null;

  function submitRoundResult(result: RoundResult, onDone?: () => void) {
    hideSummary();
    if (!canSubmit(result)) {
      toast(rejectToast(result));
      return;
    }
    const user = authStore.currentUser();
    if (!user) {
      pendingLeaderboardResult = result;
      pendingLeaderboardOnDone = onDone ?? null;
      authPanel.requestLogin(() => submitPendingLeaderboard());
      toast(t('main.loginFirst'));
      return;
    }
    submitLeaderboard(result);
    onDone?.();
  }

  function submitPendingLeaderboard() {
    const result = pendingLeaderboardResult;
    pendingLeaderboardResult = null;
    const onDone = pendingLeaderboardOnDone;
    pendingLeaderboardOnDone = null;
    if (!result) return;
    if (!canSubmit(result)) {
      toast(rejectToast(result));
      return;
    }
    if (!authStore.currentUser()) return;
    submitLeaderboard(result);
    onDone?.();
  }

  /** 云端提交成绩：内部异步，对外仍同步返回（onDone 时序不变，回合立刻重置，提交在后台进行）。 */
  function submitLeaderboard(result: RoundResult) {
    const token = authStore.sessionToken();
    if (!token) return;
    void (async () => {
      try {
        const status = await leaderboardStore.submit(result, token);
        void refreshSidePanel();
        toast(status === 'kept' ? t('main.keptScore') : t('main.submitted'));
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          authStore.clearSession();
          toast(t('main.loginExpired'));
          return;
        }
        console.error(err);
        toast(t('main.submitFailed'));
      }
    })();
  }

  /** 无法提交时的提示文案（按模式区分）。 */
  function rejectToast(result: RoundResult) {
    return result.mode === 'endless' ? t('main.rejectEndless') : t('main.rejectNotAllCorrect');
  }

  /** 提交资格：endless 需有金币；全国 self/click 允许未答完（已答全对即可）；省级维持全对；daily 需全国 34 省级全对。 */
  function canSubmit(result: RoundResult) {
    if (result.mode === 'endless') return typeof result.coins === 'number' && result.coins > 0;
    if (result.mode === 'daily') return result.totalUnits === 34 && result.correct === 34 && result.wrong === 0;
    if (result.scopeProvince === null) return result.correct > 0 && result.wrong === 0;
    return result.totalUnits > 0 && result.correct + result.wrong === result.totalUnits && result.correct === result.totalUnits && result.wrong === 0;
  }

  function refreshSidePanel(): Promise<void> {
    if (current?.id === 'free') {
      if (freeMode.getAnalysisGranularity() === 'province') stats.refreshProvinceLevel();
      else stats.refresh(renderer.currentProvince());
      return Promise.resolve();
    }
    if (!isLeaderboardMode(current?.id)) return Promise.resolve();
    const scopeProvince = current.getScopeProvince?.() ?? null;
    return leaderboard.refresh(current.id, scopeProvince, scopeLabel(scopeProvince));
  }

  function scopeLabel(scopeProvince: string | null) {
    if (scopeProvince === PROVINCE_NATION_SCOPE) return t('common.provinceNation');
    return scopeProvince ? data.provinces.find((p) => p.adcode === scopeProvince)?.name ?? t('common.currentProvince') : t('common.nation');
  }

  function isLeaderboardMode(mode: Mode | undefined): mode is LeaderboardMode {
    return mode === 'self' || mode === 'click' || mode === 'endless' || mode === 'daily';
  }

  let sidePanelDrag: { pointerId: number; x: number; width: number; moved: boolean; wasOpen: boolean } | null = null;

  function updateSidePanelWidth(width: number) {
    sidePanelWidth = clamp(width, SIDE_PANEL_MIN_WIDTH, SIDE_PANEL_MAX_WIDTH);
    $('side-panel').style.setProperty('--side-panel-width', `${sidePanelWidth}px`);
    saveSidePanelState(sidePanelOpen, sidePanelWidth);
  }

  function endSidePanelDrag(pointerId: number) {
    if (!sidePanelDrag || sidePanelDrag.pointerId !== pointerId) return;
    const drag = sidePanelDrag;
    const panelOpen = current?.id === 'free' ? statsVisible : sidePanelOpen;
    suppressSidePanelClick = drag.moved || (!drag.wasOpen && panelOpen);
    sidePanelDrag = null;
    if (sidePanelToggle.hasPointerCapture(pointerId)) sidePanelToggle.releasePointerCapture(pointerId);
  }

  ($('pause-overlay') as HTMLElement).addEventListener('click', () => {
    if (!current?.isPaused?.()) return;
    current.resume?.();
    syncPauseOverlay();
    syncModeChrome();
    updateProgress();
  });

  ($('btn-help') as HTMLButtonElement).addEventListener('click', showHelp);
  ($('help-close') as HTMLButtonElement).addEventListener('click', hideHelp);
  $('help-panel').addEventListener('click', (event) => {
    if (event.target === $('help-panel')) hideHelp();
  });

  function currentModeHelp(): { title: string; body: string } {
    const mode = current?.id;
    if (mode === 'self') {
      return { title: t('help.self.title'), body: t('help.self.body') };
    }
    if (mode === 'endless') {
      return { title: t('help.endless.title'), body: t('help.endless.body') };
    }
    if (mode === 'free') {
      return { title: t('help.free.title'), body: t('help.free.body') };
    }
    if (mode === 'click') {
      return { title: t('help.click.title'), body: t('help.click.body') };
    }
    if (mode === 'daily') {
      return { title: t('help.daily.title'), body: t('help.daily.body') };
    }
    return { title: t('help.memory.title'), body: t('help.memory.body') };
  }

  // 模式切换
  document.querySelectorAll<HTMLButtonElement>('#mode-tabs button').forEach((btn) => {
    btn.addEventListener('click', () => switchMode(btn.dataset.mode as Mode));
  });

  // 右区按钮：熟练度分析 → 自由模式；留言板 → 留言板模式
  ($('btn-free') as HTMLButtonElement).addEventListener('click', () => switchMode('free'));
  ($('btn-board') as HTMLButtonElement).addEventListener('click', () => switchMode('board'));

  const sidePanelToggle = $('side-panel-toggle') as HTMLButtonElement;
  sidePanelToggle.addEventListener('pointerdown', (event) => {
    if (current?.id !== 'free' && !isLeaderboardMode(current?.id)) return;
    const wasOpen = current?.id === 'free' ? statsVisible : sidePanelOpen;
    sidePanelDrag = { pointerId: event.pointerId, x: event.clientX, width: sidePanelWidth, moved: false, wasOpen };
    sidePanelToggle.setPointerCapture(event.pointerId);
  });
  sidePanelToggle.addEventListener('pointermove', (event) => {
    if (!sidePanelDrag || sidePanelDrag.pointerId !== event.pointerId) return;
    const nextWidth = clamp(sidePanelDrag.width - (event.clientX - sidePanelDrag.x), SIDE_PANEL_MIN_WIDTH, SIDE_PANEL_MAX_WIDTH);
    if (Math.abs(nextWidth - sidePanelDrag.width) > 4) sidePanelDrag.moved = true;
    if (current?.id === 'free') statsVisible = true;
    else sidePanelOpen = true;
    updateSidePanelWidth(nextWidth);
    syncModeChrome();
  });
  sidePanelToggle.addEventListener('pointerup', (event) => endSidePanelDrag(event.pointerId));
  sidePanelToggle.addEventListener('pointercancel', (event) => endSidePanelDrag(event.pointerId));
  sidePanelToggle.addEventListener('lostpointercapture', (event) => endSidePanelDrag(event.pointerId));
  sidePanelToggle.addEventListener('click', () => {
    if (suppressSidePanelClick) {
      suppressSidePanelClick = false;
      return;
    }
    if (current?.id === 'free') {
      statsVisible = !statsVisible;
    } else {
      sidePanelOpen = !sidePanelOpen;
      saveSidePanelState(sidePanelOpen, sidePanelWidth);
    }
    syncModeChrome();
    refreshSidePanel();
  });

  document.querySelectorAll<HTMLButtonElement>('#self-order-toggle button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.order as OrderMode;
      selfMode.setOrderMode(mode);
      syncSegmentedToggle('self-order-toggle', mode);
    });
  });
  document.querySelectorAll<HTMLButtonElement>('#click-order-toggle button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.order as ClickOrderMode;
      clickMode.setOrderMode(mode);
      syncSegmentedToggle('click-order-toggle', mode);
    });
  });
  document.querySelectorAll<HTMLButtonElement>('#daily-order-toggle button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.order as DailyAnswerMode;
      dailyMode.setAnswerMode(mode);
      syncSegmentedToggle('daily-order-toggle', mode);
      // 切换作答方式后同步搜索框显隐
      if (current?.id === 'daily') {
        $('search-row').classList.toggle('hidden', dailyMode.getAnswerMode() !== 'input');
      }
    });
  });

  // 点击/输入模式的省级/市级粒度切换（仅全国视图、未开始测试时可操作）
  document.querySelectorAll<HTMLButtonElement>('#granularity-toggle button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const g = btn.dataset.granularity as Granularity;
      const target = current === selfMode ? selfMode : clickMode;
      if (target.setGranularity) target.setGranularity(g);
      syncSegments();
      syncModeChrome();
      updateProgress();
      refreshSidePanel();
    });
  });

  // 熟练度分析的省级/地级切换
  document.querySelectorAll<HTMLButtonElement>('#analysis-granularity-toggle button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const g = btn.dataset.analysisGranularity as Granularity;
      freeMode.setAnalysisGranularity(g);
      syncSegments();
      syncModeChrome();
      updateProgress();
      refreshSidePanel();
    });
  });

  /** 分段按钮显隐与锁定：click/self 的「省级/市级」与「顺序/随机/错题」开始后整组隐藏；daily 开始后置灰。 */
  function syncSegments() {
    const mode = current?.id;
    const testStarted = !!current?.isStarted?.();
    const scopeIsNation = current?.getScopeProvince?.() === null || current?.getScopeProvince?.() === PROVINCE_NATION_SCOPE;
    const isGranularityMode = mode === 'click' || mode === 'self';
    // 「省级/市级」：仅全国范围且未开始测试时显示（下钻单省 / 测试中隐藏）
    const granularityVisible = isGranularityMode && !testStarted && scopeIsNation;
    $('granularity-toggle').classList.toggle('hidden', !granularityVisible);
    if (granularityVisible) {
      const g: Granularity = current === selfMode ? selfMode.getGranularity() : clickMode.getGranularity();
      syncSegmentedToggle('granularity-toggle', g);
    }
    // 「顺序/随机/错题」：click/self 未开始测试时显示（测试中整组隐藏）；daily 恒显示（但开始后置灰）
    $('self-order-toggle').classList.toggle('hidden', mode !== 'self' || testStarted);
    $('click-order-toggle').classList.toggle('hidden', mode !== 'click' || testStarted);
    $('daily-order-toggle').classList.toggle('hidden', mode !== 'daily');
    // 熟练度分析：省级/地级切换（自由模式常显）
    $('analysis-granularity-toggle').classList.toggle('hidden', mode !== 'free');
    if (mode === 'free') {
      syncSegmentedToggle('analysis-granularity-toggle', freeMode.getAnalysisGranularity());
    }
    syncSegmentedToggle('self-order-toggle', selfMode.getOrderMode());
    syncSegmentedToggle('click-order-toggle', clickMode.getOrderMode());
    syncSegmentedToggle('daily-order-toggle', dailyMode.getAnswerMode());
    // daily 开始后置灰锁定（click/self 已整组隐藏，无需 disabled）
    document.querySelectorAll<HTMLButtonElement>('#daily-order-toggle button').forEach((btn) => {
      btn.disabled = testStarted && mode === 'daily';
    });
  }

  // 点击「开始」按钮后立即锁定分段按钮（开始动作不经过 switchMode，同步需在此重新调用）
  document.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest?.('.start-action')) syncSegments();
  });

  // 导航栏设置：仅个性化（黑夜模式、边界）
  ($('btn-settings') as HTMLButtonElement).addEventListener('click', () => {
    openSettings(settings, (s) => {
      Object.assign(settings, s);
      applyTheme(settings.darkMode);
      renderer.setDarkMode(settings.darkMode);
      renderer.setBoundaryTones(settings.cityBoundaryTone, settings.provinceBoundaryTone);
    });
  });

  // 每模式设置按钮：打开当前模式的设置浮层
  ($('btn-mode-settings') as HTMLButtonElement).addEventListener('click', () => {
    const panel = current?.getModeSettings?.();
    if (panel) openModeSettings(panel);
  });
  // 模式切换时关闭设置浮层
  $('mode-settings-panel').addEventListener('click', (event) => {
    if (event.target === $('mode-settings-panel')) $('mode-settings-panel').classList.add('hidden');
  });

  ($('btn-skip') as HTMLButtonElement).addEventListener('click', () => current?.onSkip?.());
  ($('btn-end') as HTMLButtonElement).addEventListener('click', () => {
    current?.onEnd?.();
    if (current?.isPaused?.()) showPauseOverlay();
  });
  ($('btn-reset') as HTMLButtonElement).addEventListener('click', (event) => {
    confirmAction(event.currentTarget as HTMLButtonElement, () => {
      if (current?.isPaused?.()) hidePauseOverlay();
      if (current?.id === 'free') {
        if (freeMode.getAnalysisGranularity() === 'province') {
          store.resetProvincePractice();
          stats.refreshProvinceLevel();
        } else {
          store.resetPractice();
          stats.refresh(renderer.currentProvince());
        }
        current.refresh();
        toast(t('main.resetMasteryDone'));
        return;
      }
      const mode = current?.id;
      const scope = current?.getScopeProvince?.();
      if ((mode === 'self' || mode === 'click') && (scope === null || scope === PROVINCE_NATION_SCOPE) && current?.isStarted?.()) {
        showSettlementCard();
        return;
      }
      if (current?.onReset) {
        current.onReset();
        updateProgress();
        syncPauseOverlay();
      }
    });
  });

  function showSettlementCard() {
    const mode = current?.id;
    if (mode !== 'self' && mode !== 'click') return;
    const active = current as ModeController;
    active.pause?.();
    const result = active.collectResult?.() ?? null;
    if (!result) {
      doReset();
      return;
    }
    showSettlement(
      `<div style="text-align:center;line-height:1.8;">${t('main.settlementTitle')}<div class="sum-stats">${t('main.settlementSummary', { correct: result.correct, wrong: result.wrong, done: result.correct + result.wrong, total: result.totalUnits, time: formatElapsedCentiseconds(result.elapsedMs) })}</div><div class="sum-stats">${result.scopeProvince === PROVINCE_NATION_SCOPE ? t('main.settlementNoteProvince') : t('main.settlementNote')}</div></div>`,
      () => submitSettlement(result),
      () => closeSettlement(),
    );
  }

  function submitSettlement(result: RoundResult) {
    if (!canSubmit(result)) {
      toast(rejectToast(result));
      return;
    }
    submitRoundResult(result, () => {
      hideSettlement();
      doReset();
    });
  }

  function closeSettlement() {
    hideSettlement();
    doReset();
  }

  function doReset() {
    if (current?.isPaused?.()) hidePauseOverlay();
    if (current?.onReset) {
      current.onReset();
      updateProgress();
      syncPauseOverlay();
    }
  }

  // 搜索框接线（无下拉联想）
  search.onSubmit((v) => current?.onSubmit(v));
  search.onInput((v) => current?.onInput?.(v));

  switchMode('daily'); // 默认展示每日竞速
}

boot().catch((e) => {
  console.error(e);
  toast(t('main.bootFail', { message: e instanceof Error ? e.message : String(e) }));
});
