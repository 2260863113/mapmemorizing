import { $, showTimer, showStopwatch } from './dom';
import { t } from '../i18n';
import { isNationLikeScope, isWorldScope, PROVINCE_NATION_SCOPE, type Granularity } from '../province';
import {
  defaultOrderOf,
  hasGranularityToggle,
  isAnalysisMode,
  isLeaderboardMode,
  isNonMapMode,
  isTimedTestMode,
  isTwoPhaseMode,
  ORDER_TOGGLE_IDS,
  orderToggleIdOf,
  showsSearchBox,
  testButtonsVisible,
  ALL_MODES,
} from '../modes/capabilities';
import { NAMING_GROUPS, choiceAvailableIn } from '../modes/naming';
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
    // 模式事实一律走模式表（`src/modes/capabilities.ts`）：这里不再出现 `mode === 'xx'` 的枚举
    const isNonMap = isNonMapMode(mode);
    const isPuzzle = isTwoPhaseMode(mode);
    // 拼图两阶段：选范围（地图可见、可下钻）→ 拼图盘面（地图隐藏、只留画布）
    const puzzleBoard = isPuzzle && current?.puzzlePhase?.() === 'board';
    const isAnalysis = isAnalysisMode(mode);
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
      // 「有粒度行的计时测验」= 输入/点击模式（这两者正是唯一会进入省级全国的测验）
      (hasGranularityToggle(mode) || puzzleScopePhase) && (current?.isProvinceNation?.() ?? false);
    $('app').dataset.provinceInset = provinceNationInset ? '1' : '';
    $('map').classList.toggle('hidden', isNonMap || puzzleBoard);
    $('puzzle').classList.toggle('hidden', !puzzleBoard);
    // 非地图模式各自的整块界面（留言板 / 管理端）：元素 id 与模式 id 同名，故按模式表遍历
    for (const m of ALL_MODES) {
      if (!isNonMapMode(m)) continue;
      $(m).classList.toggle('hidden', mode !== m);
    }
    $('mode-info').classList.toggle('hidden', isNonMap);
    // 说明按钮：留言板/管理端没有模式说明（AppController.currentModeHelp 对它们返回 null）
    $('btn-help').classList.toggle('hidden', isNonMap);
    $('endless-status').classList.toggle('hidden', mode !== 'endless' || !current?.isStarted());
    // 拼图顶部进度行：盘面阶段显示（进行中与已获胜都显示，内容由 PuzzleMode 写入）
    $('puzzle-status').classList.toggle('hidden', !puzzleBoard);
    // 每模式设置按钮：该模式提供设置面板时显示
    $('btn-mode-settings').classList.toggle('hidden', !current?.getModeSettings());
    // 无尽闯关专属的三块行（道具/令符/美食）：不是地图模式通例，故留在这条显式清单里
    for (const id of ['endless-items', 'endless-token', 'endless-food']) {
      $(id).classList.toggle('hidden', mode !== 'endless');
    }
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
   * 取名口径行的显隐与高亮：世界档「国名 / 首都 / 国旗」+「中文 / 英文」，省级全国档「省名 / 省会 / 简称」。
   *
   * 三组行、每行有几档、某一档只在哪些模式出现 —— **全部来自口径注册表**（`src/modes/naming.ts`），
   * 这里只负责「按当前模式 + 粒度 + 是否已开始」把它们显示/收起/高亮。
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
    const mode = this.s.current()?.id;
    const naming = this.s.current()?.getQuestionNaming?.() ?? null;
    // 当前视图落在哪一档粒度上（世界全国 / 省级全国；其余一律不显示口径行）
    const onGranularity = isGranularityMode && !testStarted
      ? granularity === 'world' && isWorldScope(scope)
        ? 'world'
        : granularity === 'province' && scope === PROVINCE_NATION_SCOPE
          ? 'province'
          : null
      : null;
    for (const group of NAMING_GROUPS) {
      const rowVisible = onGranularity === group.granularity;
      $(group.toggleId).classList.toggle('hidden', !rowVisible);
      // 段按钮级的模式限制（如「国旗」只在点击模式：输入模式没有"看图点地图"这条路，
      // 给了它一段按了也没用的按钮只会让人以为坏了）。整组共用一行，故只隐藏那一段按钮。
      for (const choice of group.choices) {
        const btn = document.querySelector<HTMLButtonElement>(
          `#${group.toggleId} button[data-naming-value="${choice.value}"]`,
        );
        btn?.classList.toggle('hidden', !choiceAvailableIn(choice, mode));
      }
      if (rowVisible && naming) this.syncSegmentedToggle(group.toggleId, naming[group.field]);
    }
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
        // 取名口径三组由注册表生成，值统一挂 `data-naming-value`（不再每个字段一个 dataset 名）
        btn.dataset.namingValue ??
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
    // 进度条只有带粒度的测验模式有（模式表：granularity）
    if (!progress || !hasGranularityToggle(current?.id)) {
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
    const isPuzzle = isTwoPhaseMode(mode);
    const testStarted = !!current?.isStarted();
    const scope = current?.getScopeProvince();
    const scopeIsNation = isNationLikeScope(scope);
    const isGranularityMode = hasGranularityToggle(mode);
    // 跳过/暂停/重置显隐：三条规则都是**模式事实**（拼图没跳过、无尽没有重置、熟练度分析没有"开始"），
    // 故由 `testButtonsVisible` 唯一实现并逐模式断言（原先散在这里的三个嵌套三元表达式）。
    const buttons = testButtonsVisible(mode, { started: testStarted, board: current?.puzzlePhase?.() === 'board' });
    $('btn-skip').classList.toggle('hidden', !buttons.skip);
    $('btn-end').classList.toggle('hidden', !buttons.pause);
    $('btn-reset').classList.toggle('hidden', !buttons.reset);
    // 搜索输入框：输入模式仅测试开始时显示；无尽闯关常驻（模式表 search 字段）
    $('search-row').classList.toggle('hidden', !showsSearchBox(mode, testStarted));
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
    // 未开始时的按钮纵向顺序（2026-09 用户口径）：… → 大洲 → 次区域 → 世界/省级/市级 → 重置，
    // 重置独占左上角按钮区的最后一行。两个换行占位只在「有开始概念的模式未开始」时可见：
    //   · 开始答题后收起 → `跳过·暂停·重置` 回到同一行（开始后的布局一字不变）；
    //   · 熟练度分析（free）没有"开始"，不在这条规则内（它的粒度行是另一个元素、与重置同行）；
    //   · 留言板/管理端没有这些行，占位也跟着隐藏（免得留出一条空档）；
    //   · 粒度行的占位只在粒度行本身可见时才要 —— 无尽未开始没有粒度行，两个占位同时可见会多出一个空行。
    const notStartedTestLayout = (isTimedTestMode(mode) || isPuzzle) && !testStarted;
    $('granularity-break').classList.toggle('hidden', !granularityVisible);
    $('reset-break').classList.toggle('hidden', !notStartedTestLayout);
    // 取名口径行（2026-09 新增）：世界档「国名/首都」+「中文/英文」，省级全国档「省名/简称」。
    this.syncNamingRows(isGranularityMode, testStarted, granularity, scope);
    // 「全世界/…大洲」：仅世界粒度、全国范围、未开始测试时显示（选中某洲后出题范围缩到该洲）
    // 熟练度分析的世界档无「开始测试」概念，故单独放行（Q21）。拼图模式的世界档同样用它选范围。
    const isAnalysisWorld = isAnalysisMode(mode) && (current?.getGranularity?.() ?? 'city') === 'world';
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
    // 「顺序/随机/错题」：有该行的模式（表里的 orderToggleId）在未开始测试时显示，测试中整组收起。
    // 行的集合由模式表推导 —— 将来某个模式再加一组顺序行，只改表，这里不用动。
    const orderId = orderToggleIdOf(mode);
    for (const id of ORDER_TOGGLE_IDS) {
      $(id).classList.toggle('hidden', id !== orderId || testStarted);
    }
    if (orderId) {
      this.syncSegmentedToggle(orderId, (current?.getOrderMode?.() ?? defaultOrderOf(mode) ?? 'random') as OrderMode);
    }
    // 熟练度分析：世界/省级/地级切换（分析模式常显，与「开始」无关）
    $('analysis-granularity-toggle').classList.toggle('hidden', !isAnalysisMode(mode));
    if (isAnalysisMode(mode)) {
      this.syncSegmentedToggle('analysis-granularity-toggle', (current?.getGranularity?.() ?? 'city') as Granularity);
    }
  }
}
