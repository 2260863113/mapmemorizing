import { $, showTimer, showStopwatch } from './dom';
import { t } from '../i18n';
import { isNationLikeScope, isWorldScope, PROVINCE_NATION_SCOPE, type Granularity } from '../province';
import { hasGranularityToggle, isLeaderboardMode, isTimedTestMode } from '../modes/capabilities';
import type { ModeController, OrderMode } from '../modes/types';
import type { SidePanelController } from './sidePanelController';
import { CONTINENTS, type AppData, type Continent, type SubregionMeta } from '../types';
import { hasSubregions, subregionsOf } from '../subregions';

/** ChromeSync 读取的「当前应用状态」快照。current 与 zoom 会随运行变化，故用函数取值。 */
export interface ChromeState {
  current(): ModeController | null;
  sidePanel: SidePanelController;
  zoom(): number;
  /** 应用数据（次区域行按大洲动态取分区列表用）。 */
  data: AppData;
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
    const isPuzzle = mode === 'puzzle';
    // 拼图两阶段：选范围（地图可见、可下钻）→ 拼图盘面（地图隐藏、只留画布）
    const puzzleBoard = isPuzzle && current?.puzzlePhase?.() === 'board';
    const isAnalysis = mode === 'free';
    const isTest = isTimedTestMode(mode);
    const showLeaderboard = isLeaderboardMode(mode);
    if (!isTest) {
      showTimer(null);
      showStopwatch(null);
    }
    $('app').dataset.mode = mode ?? '';
    // 点击/输入模式（以及拼图模式的选范围阶段）处于省级全国（含港澳放大框）时，
    // 左下说明/缩放按钮上移避免被放大框遮挡
    const puzzleScopePhase = isPuzzle && !puzzleBoard;
    const provinceNationInset =
      (mode === 'click' || mode === 'self' || puzzleScopePhase) && (current?.isProvinceNation?.() ?? false);
    $('app').dataset.provinceInset = provinceNationInset ? '1' : '';
    $('map').classList.toggle('hidden', isNonMap || puzzleBoard);
    $('puzzle').classList.toggle('hidden', !puzzleBoard);
    $('board').classList.toggle('hidden', mode !== 'board');
    $('admin').classList.toggle('hidden', mode !== 'admin');
    $('mode-info').classList.toggle('hidden', isNonMap);
    // 说明按钮：留言板/管理端没有模式说明（AppController.currentModeHelp 对它们返回 null）
    $('btn-help').classList.toggle('hidden', isNonMap);
    $('endless-status').classList.toggle('hidden', mode !== 'endless' || !current?.isStarted());
    // 拼图顶部进度行：盘面阶段显示（进行中与已获胜都显示，内容由 PuzzleMode 写入）
    $('puzzle-status').classList.toggle('hidden', !puzzleBoard);
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
    $('mode-actions').classList.toggle('hidden', !isTest && !isAnalysis && !isNonMap && !isPuzzle);
    this.syncSegments();
    ($('btn-reset') as HTMLButtonElement).textContent = isAnalysis ? t('common.resetMastery') : t('common.reset');
    // 拼图难度行：只在本模式显示；**运行中收起**（不允许中途切换），结束后/回开始卡片后再放出
    const puzzleRunning = isPuzzle && !!current?.isStarted();
    $('puzzle-break').classList.toggle('hidden', !isPuzzle || puzzleRunning);
    $('puzzle-difficulty-toggle').classList.toggle('hidden', !isPuzzle || puzzleRunning);
    if (isPuzzle) {
      this.syncSegmentedToggle('puzzle-difficulty-toggle', (current as { getDifficulty?: () => string })?.getDifficulty?.() ?? 'easy');
    }
    this.syncViewChrome();
  }

  /**
   * 取名口径行的显隐与高亮：世界档「国名 / 首都」+「中文 / 英文」（两者一起显隐），
   * 省级全国档「省名 / 简称」。
   *
   * 只在**对应的全国视图**且未开始测试时显示 —— 与粒度/大洲/次区域行同一口径：出题范围与
   * 题面口径都不允许中途改（改了当前题的题面与答案就对不上了；模式层也有同样的守卫）。
   * 世界档的三种范围（全世界 / 某洲 / 某次区域）都共用这两行，故判 `isWorldScope` 而不是「世界全国」哨兵。
   */
  private syncNamingRows(
    isGranularityMode: boolean,
    testStarted: boolean,
    granularity: Granularity | null,
    scope: string | null | undefined,
  ) {
    const worldVisible = isGranularityMode && !testStarted && granularity === 'world' && isWorldScope(scope);
    const provinceVisible = isGranularityMode && !testStarted && granularity === 'province' && scope === PROVINCE_NATION_SCOPE;
    $('world-name-toggle').classList.toggle('hidden', !worldVisible);
    $('world-lang-toggle').classList.toggle('hidden', !worldVisible);
    $('province-name-toggle').classList.toggle('hidden', !provinceVisible);
    const naming = this.s.current()?.getQuestionNaming?.() ?? null;
    if (!naming) return;
    if (worldVisible) {
      this.syncSegmentedToggle('world-name-toggle', naming.world);
      this.syncSegmentedToggle('world-lang-toggle', naming.lang);
    }
    if (provinceVisible) this.syncSegmentedToggle('province-name-toggle', naming.province);
  }

  syncViewChrome() {
    // 拼图盘面自成一幅可缩放画布：它的 1x 与地图 1x 比例一致（见 projection.unitScale），
    // 缩放范围也一致（0.8–28x），所以角标照常显示 —— 模式自己报倍率，其余模式走地图渲染器。
    const current = this.s.current();
    const zoom = current?.getZoomDisplay?.() ?? this.s.zoom();
    $('zoom-pill').textContent = zoom.toFixed(2) + 'x';
  }

  syncSegmentedToggle(containerId: string, current: string) {
    document.querySelectorAll<HTMLButtonElement>('#' + containerId + ' button').forEach((btn) => {
      const value =
        btn.dataset.order ??
        btn.dataset.granularity ??
        btn.dataset.analysisGranularity ??
        btn.dataset.puzzleDifficulty ??
        btn.dataset.subregion ??
        btn.dataset.continent ??
        btn.dataset.worldName ??
        btn.dataset.worldLang ??
        btn.dataset.provinceName ??
        btn.dataset.mode;
      const active = value === current;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-checked', String(active));
    });
  }

  /**
   * 次区域行按当前大洲**动态重建**按钮（各大洲的次区域列表不同，无法静态写死在 HTML 里）。
   *
   * 首项是「全亚洲/全欧洲/…」（Q23）——与「全世界」同构，给用户一个明确的「回到全洲」出口，
   * 不用去猜「再点一次亚洲」。只在按钮集合变化时重建，避免每次 sync 都重排 DOM。
   */
  private renderSubregionButtons(continent: Continent, subregions: SubregionMeta[]) {
    const el = $('subregion-toggle');
    const signature = continent + ':' + subregions.map((s) => s.id).join(',');
    if (el.dataset.signature === signature) return;
    el.dataset.signature = signature;
    const continentName = CONTINENTS.find((c) => c.id === continent)?.name ?? '';
    el.innerHTML = [
      `<button type="button" data-subregion="" role="radio" aria-checked="false">全${continentName}</button>`,
      ...subregions.map(
        (s) => `<button type="button" data-subregion="${s.id}" role="radio" aria-checked="false">${s.name}</button>`,
      ),
    ].join('');
  }

  /** 当前模式的世界范围状态（大洲 + 次区域）；不支持时返回 null。 */
  private worldScope(): { continent: Continent | null; subregion: string | null } | null {
    const current = this.s.current();
    if (!current?.getWorldContinent && !current?.getWorldSubregion) return null;
    return {
      continent: (current?.getWorldContinent?.() ?? null) as Continent | null,
      subregion: (current?.getWorldSubregion?.() ?? null) as string | null,
    };
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

  /** 分段按钮显隐与锁定：click/self 的「世界/省级/市级」与「顺序/随机/错题」开始后整组隐藏。 */
  syncSegments() {
    const current = this.s.current();
    const mode = current?.id;
    const isPuzzle = mode === 'puzzle';
    const testStarted = !!current?.isStarted();
    const scope = current?.getScopeProvince();
    const scopeIsNation = isNationLikeScope(scope);
    const isGranularityMode = hasGranularityToggle(mode);
    const isTestMode = isTimedTestMode(mode);
    // 跳过/暂停/重置显隐：click/self 未开始只留「重置」，开始后显示 跳过·暂停·重置（顺序：跳过→暂停→重置）
    // 拼图模式：没有跳过；开始前只留「重置」，开始后给出「暂停」与「重置」
    $('btn-skip').classList.toggle('hidden', !isTestMode || mode === 'endless' || (isGranularityMode && !testStarted));
    $('btn-end').classList.toggle('hidden', isPuzzle ? !testStarted : !isTestMode || (isGranularityMode && !testStarted));
    $('btn-reset').classList.toggle('hidden', isPuzzle ? false : isGranularityMode ? false : !isTestMode && mode !== 'free');
    // 搜索输入框：输入/自测仅测试开始时显示；无尽闯关输入框常驻
    const searchVisible = mode === 'endless' || (mode === 'self' && testStarted);
    $('search-row').classList.toggle('hidden', !searchVisible);
    // 「世界/省级/市级」：点击/输入模式（全国范围且未开始测试时）
    // 与拼图模式（**仅在选范围阶段**——开始后地图与粒度行一起收起，防止中途换范围）
    const showsGranularity = isGranularityMode || isPuzzle;
    const granularityVisible =
      showsGranularity && (isPuzzle ? current?.puzzlePhase?.() === 'scope' : !testStarted && scopeIsNation);
    $('granularity-toggle').classList.toggle('hidden', !granularityVisible);
    const granularity = (current?.getGranularity?.() ?? null) as Granularity | null;
    if (granularityVisible && granularity) {
      this.syncSegmentedToggle('granularity-toggle', granularity);
    }
    // 取名口径行（2026-09 新增）：世界档「国名/首都」+「中文/英文」，省级全国档「省名/简称」。
    this.syncNamingRows(isGranularityMode, testStarted, granularity, scope);
    // 「全世界/…大洲」：仅世界粒度、全国范围、未开始测试时显示（选中某洲后出题范围缩到该洲）
    // 熟练度分析（free）世界档无「开始测试」概念，故单独放行（Q21）。
    // 拼图模式的世界档同样用它选范围。
    const isAnalysisWorld = mode === 'free' && (current?.getGranularity?.() ?? 'city') === 'world';
    const isWorldGranularity =
      isAnalysisWorld || (granularityVisible && (current?.getGranularity?.() ?? 'province') === 'world');
    $('continent-toggle').classList.toggle('hidden', !isWorldGranularity);
    // 换行占位随洲按钮一同显隐，否则非世界粒度时会凭空多出一个空行
    $('continent-break').classList.toggle('hidden', !isWorldGranularity);
    if (isWorldGranularity) {
      const c = (current?.getWorldContinent?.() ?? null) as string | null;
      this.syncSegmentedToggle('continent-toggle', c ?? '');
    }
    // 「次区域行」：已选大洲、该洲分区数 > 1、且未开始测试（分析模式无此限制）时显示。
    const worldScope = this.worldScope();
    const subregionVisible =
      isWorldGranularity &&
      worldScope?.continent != null &&
      (!testStarted || isAnalysisWorld) &&
      hasSubregions(this.s.data, worldScope.continent);
    $('subregion-toggle').classList.toggle('hidden', !subregionVisible);
    $('subregion-break').classList.toggle('hidden', !subregionVisible);
    if (subregionVisible && worldScope?.continent) {
      this.renderSubregionButtons(worldScope.continent, subregionsOf(this.s.data, worldScope.continent));
      this.syncSegmentedToggle('subregion-toggle', worldScope.subregion ?? '');
    }
    // 「顺序/随机/错题」：click/self 未开始测试时显示（测试中整组隐藏）
    $('self-order-toggle').classList.toggle('hidden', mode !== 'self' || testStarted);
    $('click-order-toggle').classList.toggle('hidden', mode !== 'click' || testStarted);
    // 熟练度分析：世界/省级/地级切换（自由模式常显）
    $('analysis-granularity-toggle').classList.toggle('hidden', mode !== 'free');
    if (mode === 'free') {
      this.syncSegmentedToggle('analysis-granularity-toggle', (current?.getGranularity?.() ?? 'city') as Granularity);
    }
    this.syncSegmentedToggle('self-order-toggle', (current?.getOrderMode?.() ?? 'sequential') as OrderMode);
    this.syncSegmentedToggle('click-order-toggle', (current?.getOrderMode?.() ?? 'random') as OrderMode);
  }
}
