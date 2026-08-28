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
import { $, toast, setHint, showTimer, showStopwatch, showSummary, hideSummary } from './ui/dom';
import { FreeMode } from './modes/free';
import { SelfTestMode } from './modes/selfTest';
import { ChallengeMode } from './modes/challenge';
import { MemoryMode } from './modes/memory';
import { ClickMode } from './modes/click';
import type { AuthUser, Mode, RoundResult, Settings, Unit } from './types';
import type { ModeCtx, ModeController } from './modes/types';

const SIDE_PANEL_KEY = 'china-admin-leaderboard-panel-v1';
const SIDE_PANEL_MIN_WIDTH = 240;
const SIDE_PANEL_MAX_WIDTH = 420;
const SIDE_PANEL_DEFAULT_WIDTH = 300;

function applyTheme(darkMode: boolean) {
  document.body.classList.toggle('theme-dark', darkMode);
}

function loadSidePanelOpen() {
  try {
    const raw = localStorage.getItem(SIDE_PANEL_KEY);
    if (!raw) return true;
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
  search.setRequireEnter(settings.requireEnter);
  const stats = new StatsPanel('stats', data, store);
  const authStore = new AuthStore();
  const authPanel = new AuthPanel(authStore, data);
  const leaderboardStore = new LeaderboardStore();
  const leaderboard = new LeaderboardPanel('leaderboard', leaderboardStore);

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
        toast('测试期间无法返回全国');
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
  const modes: Record<Mode, ModeController> = {
    free: new FreeMode(ctx),
    self: selfMode,
    challenge: new ChallengeMode(ctx),
    click: new ClickMode(ctx),
    memory: new MemoryMode(ctx),
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
    btn.textContent = '确认';
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
    const active = current;
    if (active?.isStarted?.() && !active.isPaused?.()) active.pause?.();
    if (active && !active.isPaused?.()) active.exit();
    current = modes[mode];
    document.querySelectorAll<HTMLButtonElement>('#mode-tabs button').forEach((b) => {
      b.classList.toggle('active', b.dataset.mode === mode);
    });
    const inputMode = mode === 'self' || mode === 'challenge';
    $('search-row').classList.toggle('hidden', !inputMode);
    current.enter();
    syncModeChrome();
    syncPauseOverlay();
    updateProgress();
    refreshSidePanel();
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
    const isAnalysis = mode === 'free';
    const isTest = mode === 'self' || mode === 'challenge' || mode === 'click';
    if (!isTest) {
      showTimer(null);
      showStopwatch(null);
    }
    $('app').dataset.mode = mode ?? '';
    const showSidePanel = isAnalysis ? statsVisible : isTest;
    $('side-panel').classList.toggle('hidden', !showSidePanel);
    $('side-panel').classList.toggle('collapsed', isTest && !sidePanelOpen);
    ($('side-panel-toggle') as HTMLButtonElement).textContent = isAnalysis ? '收' : '榜';
    ($('side-panel-toggle') as HTMLButtonElement).setAttribute('aria-expanded', String(!isTest || sidePanelOpen));
    $('stats').classList.toggle('hidden', !isAnalysis);
    $('leaderboard').classList.toggle('hidden', !isTest);
    $('side-panel-title').textContent = isAnalysis ? '熟练度分析' : '排行榜';
    $('side-panel-tip').textContent = isAnalysis ? '进度自动保存在本机浏览器（localStorage）' : '排行榜按当前测试范围筛选，仅保存本机成绩';
    $('btn-stats').classList.toggle('hidden', !isAnalysis);
    $('mode-actions').classList.toggle('hidden', !isTest && !isAnalysis);
    $('btn-skip').classList.toggle('hidden', !isTest);
    $('btn-end').classList.toggle('hidden', !isTest);
    $('btn-reset').classList.toggle('hidden', !isTest && !isAnalysis);
    $('self-order-toggle').classList.toggle('hidden', mode !== 'self');
    syncSelfOrderToggle();
    ($('btn-reset') as HTMLButtonElement).textContent = isAnalysis ? '重置熟练度' : '重置';
    syncViewChrome();
  }

  function syncViewChrome() {
    $('zoom-pill').textContent = `${zoomDisplay.toFixed(2)}x`;
  }

  function syncSelfOrderToggle() {
    const mode = selfMode.getOrderMode();
    document.querySelectorAll<HTMLButtonElement>('#self-order-toggle button').forEach((btn) => {
      const active = btn.dataset.order === mode;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-checked', String(active));
    });
  }

  function updateProgress() {
    const el = $('mode-progress');
    const progress = current?.getProgress?.() ?? null;
    if (!progress || (current?.id !== 'self' && current?.id !== 'challenge' && current?.id !== 'click')) {
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
    const unit = idx.byAdcode.get(adcode);
    if (!unit) return;
    const practice = store.getPractice(adcode);
    const card = $('hover-stats');
    card.textContent = `${unit.name}  正确次数：${practice.correctCount}次 ｜ 错误次数：${practice.wrongCount}次`;
    card.classList.remove('hidden');
  }

  function hideHoverStats() {
    $('hover-stats').classList.add('hidden');
  }

  function submitRoundResult(result: RoundResult) {
    hideSummary();
    if (!canSubmit(result)) {
      toast('本轮有错题或跳过，未提交成绩');
      return;
    }
    const user = authStore.currentUser();
    if (!user) {
      pendingLeaderboardResult = result;
      authPanel.requestLogin(() => submitPendingLeaderboard());
      toast('请先登录，登录后将自动提交');
      return;
    }
    submitLeaderboard(result, user);
  }

  function submitPendingLeaderboard() {
    const result = pendingLeaderboardResult;
    pendingLeaderboardResult = null;
    if (!result) return;
    if (!canSubmit(result)) {
      toast('本轮有错题或跳过，未提交成绩');
      return;
    }
    const user = authStore.currentUser();
    if (!user) return;
    submitLeaderboard(result, user);
  }

  function submitLeaderboard(result: RoundResult, user: AuthUser) {
    const status = leaderboardStore.submit(result, user);
    refreshSidePanel();
    if (status === 'kept') {
      toast('已有更快成绩，本次未更新');
      return;
    }
    toast(status === 'improved' ? '成绩已刷新' : '成绩已提交');
  }

  function canSubmit(result: RoundResult) {
    return result.totalUnits > 0 && result.correct + result.wrong === result.totalUnits && result.correct === result.totalUnits && result.wrong === 0;
  }

  function refreshSidePanel() {
    if (current?.id === 'free') {
      stats.refresh(renderer.currentProvince());
      return;
    }
    if (!isLeaderboardMode(current?.id)) return;
    const scopeProvince = current.getScopeProvince?.() ?? null;
    leaderboard.refresh(current.id, scopeProvince, scopeLabel(scopeProvince));
  }

  function scopeLabel(scopeProvince: string | null) {
    return scopeProvince ? data.provinces.find((p) => p.adcode === scopeProvince)?.name ?? '当前省份' : '全国';
  }

  function isLeaderboardMode(mode: Mode | undefined): mode is LeaderboardMode {
    return mode === 'self' || mode === 'challenge' || mode === 'click';
  }

  let sidePanelDrag: { pointerId: number; x: number; width: number; moved: boolean } | null = null;

  function updateSidePanelWidth(width: number) {
    sidePanelWidth = clamp(width, SIDE_PANEL_MIN_WIDTH, SIDE_PANEL_MAX_WIDTH);
    $('side-panel').style.setProperty('--side-panel-width', `${sidePanelWidth}px`);
    saveSidePanelState(sidePanelOpen, sidePanelWidth);
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
      return {
        title: '输入模式说明',
        body: '输入地名进行作答。答对后题目会沿相邻地图单位继续扩张；答错保持红色并计入熟练度。可以使用跳过、暂停和重置。',
      };
    }
    if (mode === 'challenge') {
      return {
        title: '挑战模式说明',
        body: '系统会连续随机出题。输入正确立即进入下一题；答错或超时会显示正确答案并继续。',
      };
    }
    if (mode === 'free') {
      return {
        title: '熟练度分析说明',
        body: '地图按累计答题分数分层着色。悬停地图单位可查看正确和错误次数；此模式不响应点击和输入。',
      };
    }
    if (mode === 'click') {
      return {
        title: '点击模式说明',
        body: '按照顶部提示点击对应地图单位。答对变绿，答错时正确答案变红；本模式不使用自动跟随。',
      };
    }
    return {
      title: '自由模式说明',
      body: '这是自由浏览模式，可以查看全部地图单位名称并自由缩放、双击区域进入该省。',
    };
  }

  // 模式切换
  document.querySelectorAll<HTMLButtonElement>('#mode-tabs button').forEach((btn) => {
    btn.addEventListener('click', () => switchMode(btn.dataset.mode as Mode));
  });

  ($('btn-stats') as HTMLButtonElement).addEventListener('click', () => {
    statsVisible = !statsVisible;
    syncModeChrome();
    refreshSidePanel();
  });

  const sidePanelToggle = $('side-panel-toggle') as HTMLButtonElement;
  sidePanelToggle.addEventListener('pointerdown', (event) => {
    if (!isLeaderboardMode(current?.id)) return;
    sidePanelDrag = { pointerId: event.pointerId, x: event.clientX, width: sidePanelWidth, moved: false };
    sidePanelToggle.setPointerCapture(event.pointerId);
  });
  sidePanelToggle.addEventListener('pointermove', (event) => {
    if (!sidePanelDrag || sidePanelDrag.pointerId !== event.pointerId) return;
    const nextWidth = clamp(sidePanelDrag.width - (event.clientX - sidePanelDrag.x), SIDE_PANEL_MIN_WIDTH, SIDE_PANEL_MAX_WIDTH);
    if (Math.abs(nextWidth - sidePanelDrag.width) > 4) sidePanelDrag.moved = true;
    sidePanelOpen = true;
    updateSidePanelWidth(nextWidth);
    syncModeChrome();
  });
  sidePanelToggle.addEventListener('pointerup', (event) => {
    if (!sidePanelDrag || sidePanelDrag.pointerId !== event.pointerId) return;
    suppressSidePanelClick = sidePanelDrag.moved;
    sidePanelDrag = null;
    sidePanelToggle.releasePointerCapture(event.pointerId);
  });
  sidePanelToggle.addEventListener('click', () => {
    if (suppressSidePanelClick) {
      suppressSidePanelClick = false;
      return;
    }
    if (current?.id === 'free') {
      statsVisible = false;
    } else {
      sidePanelOpen = !sidePanelOpen;
      saveSidePanelState(sidePanelOpen, sidePanelWidth);
    }
    syncModeChrome();
    refreshSidePanel();
  });

  document.querySelectorAll<HTMLButtonElement>('#self-order-toggle button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.order === 'random' ? 'random' : 'sequential';
      selfMode.setOrderMode(mode);
      syncSelfOrderToggle();
    });
  });

  // 设置
  ($('btn-settings') as HTMLButtonElement).addEventListener('click', () => {
    openSettings(settings, (s) => {
      Object.assign(settings, s);
      search.setRequireEnter(settings.requireEnter);
      applyTheme(settings.darkMode);
      renderer.setDarkMode(settings.darkMode);
      renderer.setBoundaryTones(settings.cityBoundaryTone, settings.provinceBoundaryTone);
    });
  });

  ($('btn-skip') as HTMLButtonElement).addEventListener('click', () => current?.onSkip?.());
  ($('btn-end') as HTMLButtonElement).addEventListener('click', () => {
    current?.onEnd?.();
    if (current?.isPaused?.()) showPauseOverlay();
  });
  ($('btn-reset') as HTMLButtonElement).addEventListener('click', (event) => {
    confirmAction(event.currentTarget as HTMLButtonElement, () => {
      if (current?.id === 'free') {
        store.resetPractice();
        stats.refresh(renderer.currentProvince());
        current.refresh();
        toast('已重置熟练度');
        return;
      }
      if (current?.onReset) {
        current.onReset();
        updateProgress();
      }
    });
  });

  // 搜索框接线（无下拉联想）
  search.onSubmit((v) => current?.onSubmit(v));
  search.onInput((v) => current?.onInput?.(v));

  switchMode('free');
}

boot().catch((e) => {
  console.error(e);
  toast(`启动失败：${e instanceof Error ? e.message : String(e)}`);
});
