import './styles.css';
import { loadData, buildIndex } from './data';
import { Matcher } from './matcher';
import { MapRenderer } from './map/renderer';
import { MemoryStore, loadSettings } from './store';
import { SearchBox } from './ui/searchBox';
import { StatsPanel } from './ui/statsPanel';
import { openSettings } from './ui/settingsPanel';
import { $, toast, setHint, showTimer, showStopwatch, showSummary, hideSummary } from './ui/dom';
import { FreeMode } from './modes/free';
import { SelfTestMode } from './modes/selfTest';
import { ChallengeMode } from './modes/challenge';
import { MemoryMode } from './modes/memory';
import { ClickMode } from './modes/click';
import type { Mode, Settings, Unit } from './types';
import type { ModeCtx, ModeController } from './modes/types';

function applyTheme(darkMode: boolean) {
  document.body.classList.toggle('theme-dark', darkMode);
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

  let current: ModeController | null = null;
  let statsVisible = true;
  let zoomDisplay = 1;
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
  zoomDisplay = renderer.currentZoom();
  renderer.onViewChange = () => {
    current?.onViewChange?.();
    current?.refresh();
    updateProgress();
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
    showSummary,
    hideSummary,
    updateProgress,
    randomUnit: (pool: Unit[]) => pool[Math.floor(Math.random() * pool.length)],
  };

  const modes: Record<Mode, ModeController> = {
    free: new FreeMode(ctx),
    self: new SelfTestMode(ctx),
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
    const currentStarted = active?.isStarted?.() ?? false;
    const currentPaused = active?.isPaused?.() ?? false;
    if (active && currentStarted && !currentPaused) {
      active.pause?.();
      if (active.isPaused?.()) showPauseOverlay();
      syncModeChrome();
      updateProgress();
      return;
    }
    active?.exit();
    current = modes[mode];
    document.querySelectorAll<HTMLButtonElement>('#mode-tabs button').forEach((b) => {
      b.classList.toggle('active', b.dataset.mode === mode);
    });
    const inputMode = mode === 'self' || mode === 'challenge';
    $('search-row').classList.toggle('hidden', !inputMode);
    hidePauseOverlay();
    current.enter();
    syncModeChrome();
    updateProgress();
  }

  function showPauseOverlay() {
    $('pause-overlay').classList.remove('hidden');
    $('app').classList.add('test-paused');
  }

  function hidePauseOverlay() {
    $('pause-overlay').classList.add('hidden');
    $('app').classList.remove('test-paused');
  }

  function syncModeChrome() {
    const mode = current?.id;
    const isAnalysis = mode === 'free';
    const isTest = mode === 'self' || mode === 'challenge' || mode === 'click';
    if (!isTest) {
      showTimer(null);
      showStopwatch(null);
      hidePauseOverlay();
    }
    $('app').dataset.mode = mode ?? '';
    $('side-panel').classList.toggle('hidden', !isAnalysis || !statsVisible);
    $('btn-stats').classList.toggle('hidden', !isAnalysis);
    $('mode-actions').classList.toggle('hidden', !isTest && !isAnalysis);
    $('btn-skip').classList.toggle('hidden', !isTest);
    $('btn-end').classList.toggle('hidden', !isTest);
    $('btn-reset').classList.toggle('hidden', !isTest && !isAnalysis);
    ($('btn-reset') as HTMLButtonElement).textContent = isAnalysis ? '重置熟练度' : '重置';
    syncViewChrome();
  }

  function syncViewChrome() {
    $('zoom-pill').textContent = `${zoomDisplay.toFixed(2)}x`;
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

  ($('pause-overlay') as HTMLElement).addEventListener('click', () => {
    if (!current?.isPaused?.()) return;
    hidePauseOverlay();
    current.resume?.();
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
        body: '输入地名进行作答。答对后题目会沿相邻地级单位继续扩张；答错保持红色并计入熟练度。可以使用跳过、中断和重置。',
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
        body: '地图按累计答题分数分层着色。悬停地级市可查看正确和错误次数；此模式不响应点击和输入。',
      };
    }
    if (mode === 'click') {
      return {
        title: '点击模式说明',
        body: '按照顶部提示点击对应地级市。答对变绿，答错时正确答案变红；本模式不使用自动跟随。',
      };
    }
    return {
      title: '自由模式说明',
      body: '这是自由浏览模式，可以查看全部地级市名称并自由缩放、双击区域进入该省。',
    };
  }

  // 模式切换
  document.querySelectorAll<HTMLButtonElement>('#mode-tabs button').forEach((btn) => {
    btn.addEventListener('click', () => switchMode(btn.dataset.mode as Mode));
  });

  ($('btn-stats') as HTMLButtonElement).addEventListener('click', () => {
    statsVisible = !statsVisible;
    syncModeChrome();
  });

  // 设置
  ($('btn-settings') as HTMLButtonElement).addEventListener('click', () => {
    openSettings(settings, (s) => {
      Object.assign(settings, s);
      search.setRequireEnter(settings.requireEnter);
      applyTheme(settings.darkMode);
      renderer.setDarkMode(settings.darkMode);
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
