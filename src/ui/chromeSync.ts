import { $, showTimer, showStopwatch } from './dom';
import { t } from '../i18n';
import { PROVINCE_NATION_SCOPE, type Granularity } from '../province';
import type { ModeController, OrderMode } from '../modes/types';
import type { SidePanelController } from './sidePanelController';

/** ChromeSync 读取的「当前应用状态」快照。current 与 zoom 会随运行变化，故用函数取值。 */
export interface ChromeState {
  current(): ModeController | null;
  sidePanel: SidePanelController;
  zoom(): number;
}

/**
 * 视图 chrome 同步器：把「当前模式 + 会话状态」反映到 DOM（模式 tab、各面板显隐、
 * 分段按钮锁定、进度条、暂停遮罩、缩放角标、每模式设置按钮）。
 * 从 main.ts 的 boot 闭包抽出，让 boot 只负责装配与接线，不再持有这些纯表现层同步逻辑。
 */
export class ChromeSync {
  constructor(private s: ChromeState) {}

  showPauseOverlay() {
    $('pause-overlay').classList.remove('hidden');
    $('app').classList.add('test-paused');
  }

  hidePauseOverlay() {
    $('pause-overlay').classList.add('hidden');
    $('app').classList.remove('test-paused');
  }

  syncPauseOverlay() {
    if (this.s.current()?.isPaused()) this.showPauseOverlay();
    else this.hidePauseOverlay();
  }

  syncModeChrome() {
    const current = this.s.current();
    const mode = current?.id;
    const isNonMap = mode === 'board' || mode === 'admin';
    const isAnalysis = mode === 'free';
    const isTest = mode === 'self' || mode === 'endless' || mode === 'click';
    const showLeaderboard = mode === 'self' || mode === 'click' || mode === 'endless';
    if (!isTest) {
      showTimer(null);
      showStopwatch(null);
    }
    $('app').dataset.mode = mode ?? '';
    // 点击/输入模式处于省级全国（含港澳放大框）时，左下说明/缩放按钮上移避免被放大框遮挡
    const provinceNationInset = (mode === 'click' || mode === 'self') && (current?.isProvinceNation?.() ?? false);
    $('app').dataset.provinceInset = provinceNationInset ? '1' : '';
    $('map').classList.toggle('hidden', isNonMap);
    $('board').classList.toggle('hidden', mode !== 'board');
    $('admin').classList.toggle('hidden', mode !== 'admin');
    $('mode-info').classList.toggle('hidden', isNonMap);
    $('endless-status').classList.toggle('hidden', mode !== 'endless' || !current?.isStarted());
    // 每模式设置按钮：该模式提供设置面板时显示
    $('btn-mode-settings').classList.toggle('hidden', !current?.getModeSettings());
    $('endless-items').classList.toggle('hidden', mode !== 'endless');
    $('endless-token').classList.toggle('hidden', mode !== 'endless');
    $('endless-food').classList.toggle('hidden', mode !== 'endless');
    if (mode !== 'endless') {
      $('endless-shop').classList.add('hidden');
    }
    const showSidePanel = (isAnalysis || showLeaderboard) && !isNonMap;
    const panelOpen = this.s.sidePanel.isOpen(isAnalysis);
    $('side-panel').classList.toggle('hidden', !showSidePanel);
    $('side-panel').classList.toggle('collapsed', showSidePanel && !panelOpen);
    ($('side-panel-toggle') as HTMLButtonElement).setAttribute('aria-expanded', String(panelOpen));
    $('stats').classList.toggle('hidden', !isAnalysis);
    $('leaderboard').classList.toggle('hidden', !showLeaderboard);
    $('side-panel-title').classList.toggle('hidden', !isAnalysis);
    $('side-panel-title').textContent = t('main.sideTitle');
    $('side-panel-tip').textContent = isAnalysis ? t('main.sideTipAnalysis') : t('main.sideTipLeaderboard');
    $('mode-actions').classList.toggle('hidden', !isTest && !isAnalysis && !isNonMap);
    this.syncSegments();
    ($('btn-reset') as HTMLButtonElement).textContent = isAnalysis ? t('common.resetMastery') : t('common.reset');
    this.syncViewChrome();
  }

  syncViewChrome() {
    $('zoom-pill').textContent = this.s.zoom().toFixed(2) + 'x';
  }

  syncSegmentedToggle(containerId: string, current: string) {
    document.querySelectorAll<HTMLButtonElement>('#' + containerId + ' button').forEach((btn) => {
      const value = btn.dataset.order ?? btn.dataset.granularity ?? btn.dataset.analysisGranularity ?? btn.dataset.mode;
      const active = value === current;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-checked', String(active));
    });
  }

  updateProgress() {
    // 分段按钮显隐/锁定随模式状态同步：开始/作答/结束/重置都会经过这里
    this.syncSegments();
    const el = $('mode-progress');
    const current = this.s.current();
    const progress = current?.getProgress() ?? null;
    if (!progress || (current?.id !== 'self' && current?.id !== 'click')) {
      el.classList.add('hidden');
      el.innerHTML = '';
      return;
    }
    el.classList.remove('hidden');
    el.innerHTML = progress.segments
      .map((segment) => '<span class="progress-segment ' + segment + '"></span>')
      .join('');
  }

  /** 分段按钮显隐与锁定：click/self 的「省级/市级」与「顺序/随机/错题」开始后整组隐藏。 */
  syncSegments() {
    const current = this.s.current();
    const mode = current?.id;
    const testStarted = !!current?.isStarted();
    const scopeIsNation = current?.getScopeProvince() === null || current?.getScopeProvince() === PROVINCE_NATION_SCOPE;
    const isGranularityMode = mode === 'click' || mode === 'self';
    const isTestMode = mode === 'self' || mode === 'click' || mode === 'endless';
    // 跳过/暂停/重置显隐：click/self 未开始只留「重置」，开始后显示 跳过·暂停·重置（顺序：跳过→暂停→重置）
    $('btn-skip').classList.toggle('hidden', !isTestMode || mode === 'endless' || (isGranularityMode && !testStarted));
    $('btn-end').classList.toggle('hidden', !isTestMode || (isGranularityMode && !testStarted));
    $('btn-reset').classList.toggle('hidden', isGranularityMode ? false : !isTestMode && mode !== 'free');
    // 搜索输入框：输入/自测仅测试开始时显示；无尽闯关输入框常驻
    const searchVisible = mode === 'endless' || (mode === 'self' && testStarted);
    $('search-row').classList.toggle('hidden', !searchVisible);
    // 「省级/市级」：仅全国范围且未开始测试时显示（下钻单省 / 测试中隐藏）
    const granularityVisible = isGranularityMode && !testStarted && scopeIsNation;
    $('granularity-toggle').classList.toggle('hidden', !granularityVisible);
    if (granularityVisible) {
      const g = (current?.getGranularity?.() ?? 'city') as Granularity;
      this.syncSegmentedToggle('granularity-toggle', g);
    }
    // 「顺序/随机/错题」：click/self 未开始测试时显示（测试中整组隐藏）
    $('self-order-toggle').classList.toggle('hidden', mode !== 'self' || testStarted);
    $('click-order-toggle').classList.toggle('hidden', mode !== 'click' || testStarted);
    // 熟练度分析：省级/地级切换（自由模式常显）
    $('analysis-granularity-toggle').classList.toggle('hidden', mode !== 'free');
    if (mode === 'free') {
      this.syncSegmentedToggle('analysis-granularity-toggle', (current?.getGranularity?.() ?? 'city') as Granularity);
    }
    this.syncSegmentedToggle('self-order-toggle', (current?.getOrderMode?.() ?? 'sequential') as OrderMode);
    this.syncSegmentedToggle('click-order-toggle', (current?.getOrderMode?.() ?? 'random') as OrderMode);
  }
}
