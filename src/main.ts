import './styles.css';
import { loadData, buildIndex } from './data';
import { Matcher } from './matcher';
import { MapRenderer } from './map/renderer';
import { MemoryStore, loadSettings } from './store';
import { SearchBox } from './ui/searchBox';
import { StatsPanel } from './ui/statsPanel';
import { openSettings } from './ui/settingsPanel';
import { $, toast, setHint, showTimer, showSummary, hideSummary } from './ui/dom';
import { FreeMode } from './modes/free';
import { SelfTestMode } from './modes/selfTest';
import { ChallengeMode } from './modes/challenge';
import { MemoryMode } from './modes/memory';
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
    onBlankClick: () => backToNationFromMap(),
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
    showSummary,
    hideSummary,
    updateProgress,
    randomUnit: (pool: Unit[]) => pool[Math.floor(Math.random() * pool.length)],
  };

  const modes: Record<Mode, ModeController> = {
    free: new FreeMode(ctx),
    self: new SelfTestMode(ctx),
    challenge: new ChallengeMode(ctx),
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
    current?.exit();
    current = modes[mode];
    document.querySelectorAll<HTMLButtonElement>('#mode-tabs button').forEach((b) => {
      b.classList.toggle('active', b.dataset.mode === mode);
    });
    $('search-row').classList.toggle('hidden', mode === 'memory');
    $('mode-actions').classList.toggle('hidden', mode === 'memory');
    current.enter();
    syncModeChrome();
    updateProgress();
  }

  function syncModeChrome() {
    const mode = current?.id;
    const isFree = mode === 'free';
    const isTest = mode === 'self' || mode === 'challenge';
    $('app').dataset.mode = mode ?? '';
    $('side-panel').classList.toggle('hidden', !isFree || !statsVisible);
    $('btn-stats').classList.toggle('hidden', !isFree);
    $('mode-actions').classList.toggle('hidden', mode === 'memory');
    $('btn-skip').classList.toggle('hidden', !isTest);
    $('btn-end').classList.toggle('hidden', !isTest);
    $('btn-reset').classList.toggle('hidden', mode === 'memory');
    syncViewChrome();
  }

  function syncViewChrome() {
    $('zoom-pill').textContent = `${zoomDisplay.toFixed(2)}x`;
  }

  function updateProgress() {
    const el = $('mode-progress');
    const progress = current?.getProgress?.() ?? null;
    if (!progress || (current?.id !== 'self' && current?.id !== 'challenge')) {
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

  ($('btn-help') as HTMLButtonElement).addEventListener('click', showHelp);
  ($('help-close') as HTMLButtonElement).addEventListener('click', hideHelp);
  $('help-panel').addEventListener('click', (event) => {
    if (event.target === $('help-panel')) hideHelp();
  });

  function currentModeHelp(): { title: string; body: string } {
    const mode = current?.id;
    if (mode === 'self') {
      return {
        title: '自测模式说明',
        body: '输入地名进行作答。答对后题目会沿相邻地级单位继续扩张；答错保持红色。可以使用跳过、结束和重置。',
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
        title: '自由模式说明',
        body: '这是自由浏览和练习模式。可以查看进度、切换省份、使用搜索定位单位。',
      };
    }
    return {
      title: '记忆模式说明',
      body: '该模式用于回顾已记忆内容，界面会隐藏辅助控件，专注于地图查看。',
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
  ($('btn-end') as HTMLButtonElement).addEventListener('click', (event) => {
    confirmAction(event.currentTarget as HTMLButtonElement, () => current?.onEnd?.());
  });
  ($('btn-reset') as HTMLButtonElement).addEventListener('click', (event) => {
    confirmAction(event.currentTarget as HTMLButtonElement, () => {
      if (current?.onReset) {
        current.onReset();
        updateProgress();
        return;
      }
      store.reset();
      toast('已重置记忆进度');
    });
  });
  ($('btn-search') as HTMLButtonElement).addEventListener('click', () => search.submit());

  // 搜索框接线（无下拉联想）
  search.onSubmit((v) => current?.onSubmit(v));
  search.onInput((v) => current?.onInput?.(v));

  switchMode('free');
}

boot().catch((e) => {
  console.error(e);
  toast(`启动失败：${e instanceof Error ? e.message : String(e)}`);
});
