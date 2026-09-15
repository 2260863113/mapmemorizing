import type { Continent, Mode, RenderState, RoundResult, SubregionId, Unit } from '../types';
import { CONTINENTS } from '../types';
import type { ModeCtx, OrderMode, ProgressSegment, QuestionNaming } from './types';
import type { QuizSessionDiagnostics } from './quizDiagnostics';
import { loadStoredGranularity, saveStoredGranularity } from './granularityStore';
import { loadStoredNaming, saveStoredNaming } from './namingStore';
import { browseLabelState, type BrowseLabelScope } from './browseLabels';
import { BaseMode } from './baseMode';
import { Stopwatch } from '../ui/stopwatch';
import { clearProgress, loadProgress, loadScopeProvince, progressOf, saveProgress, saveScopeProvince, scopedUnits, syncScopeView } from './progress';
import { initWrongOrderState, pickWrongNext, type WrongOrderState } from './wrongOrder';
import { t } from '../i18n';
import type { ModeSettingsPanel } from '../modeSettings';
import {
  buildProvinceAdjacency,
  canDrillProvince,
  continentScope,
  provinceAbbr,
  provinceByAdcode,
  provinceShortName,
  provinceUnits,
  PROVINCE_NATION_SCOPE,
  subregionScope,
  WORLD_NATION_SCOPE,
  type Granularity,
} from '../province';
import { countryUnits } from '../world';
import { hasSubregions, subregionById, subregionOfContinent, subregionOfIso } from '../subregions';
import { ignoredIsos } from '../tinyCountries';

/**
 * 错误回滚的红显时长（毫秒）。
 * 700ms 在实测中「还没看清就没了」，故延长到 1.5s（用户要求）。
 * 导出供运行时探针断言，避免探针复制一份常量后与实现漂移。
 */
export const ROLLBACK_RED_MS = 1500;

/**
 * 地图测验模式共享基类（输入模式 / 点击模式）：
 * 两者只有「判题方式」与「出题顺序」不同，其余状态机（粒度、作用域、进度持久化、
 * 错误回滚、省级虚拟单位、生命周期）完全一致。
 *
 * 子类通过少量 protected 钩子表达差异；钩子名即其职责，未覆写时使用无副作用默认实现。
 */
export abstract class MapQuizMode extends BaseMode {
  abstract readonly id: Mode;
  abstract readonly title: string;

  protected green = new Set<string>();
  protected red = new Set<string>();
  protected question: string | null = null;
  /** 市级单省作用域：null=全国（可能是省级全国或市级全国），省 adcode=该省地级练习（下钻而来）。 */
  protected scopeProvince: string | null = null;
  /** 世界粒度的大洲范围：null=全世界，非空=该洲（会话状态，不跨刷新恢复）。 */
  protected worldContinent: Continent | null = null;
  /** 世界粒度的次区域范围：null=全洲，非空=该次区域（必然属于 worldContinent；会话状态）。 */
  protected worldSubregion: SubregionId | null = null;
  /** 全国层粒度：'province'（省级全国，默认）| 'city'（市级全国）。下钻单省不改变它（返回全国后回到原全国粒度）。 */
  protected granularity: Granularity = this.loadGranularity();
  protected started = false;
  protected order: string[] = [];
  protected results: ProgressSegment[] = [];
  protected ok = 0;
  protected fail = 0;
  protected stopwatch = new Stopwatch();
  protected paused = false;
  protected scopeLoaded = false;
  protected syncingScope = false;
  protected orderMode: OrderMode = this.loadOrderMode();
  /** 题面/标签取名口径（世界档「国名/首都」+「中文/英文」，省级档「省名/简称」）。 */
  protected naming: QuestionNaming = loadStoredNaming(this.storagePrefix());
  protected wrongOrder: WrongOrderState = initWrongOrderState([], () => 0);
  protected errorRollback = false;
  protected rollbackCounted = new Set<string>(); // 错误回滚中已计入第一次答错的单位
  protected rollbacking = false; // 错误回滚展示中，暂不接受作答
  protected rollbackTimer: number | null = null; // 回滚延时定时器
  /**
   * 已弹出结算卡片（中途终止提交成绩）：此时算「已结束」，浏览标签据此复现。
   * 与 `started` 分开是因为结算流程是「先 pause（仍在进行中）→ 弹卡片」，pause 本身不算结束。
   */
  protected settled = false;
  protected provinceAdjacency = new Map<string, string[]>();
  protected provincePool: Unit[] = [];
  protected worldPool: Unit[] = [];

  protected constructor(protected ctx: ModeCtx) {
    super();
    this.provinceAdjacency = buildProvinceAdjacency(ctx.data);
    this.provincePool = provinceUnits(ctx.data, this.provinceAdjacency);
    this.worldPool = countryUnits(ctx.data.countries);
    this.errorRollback = this.loadErrorRollback();
  }

  // ==================== 差异点：子类必须实现 ====================

  /** localStorage 键前缀（'self' / 'click'）。 */
  protected abstract storagePrefix(): string;
  /** 出题顺序默认值（输入 'sequential'，点击 'random'）。 */
  protected abstract defaultOrderMode(): OrderMode;
  /** 解析已持久化的出题顺序（非法值回落默认）。 */
  protected abstract parseOrderMode(raw: string | null): OrderMode;
  /** 加载「错误回滚」开关。 */
  protected abstract loadErrorRollback(): boolean;
  /** 持久化「错误回滚」开关。 */
  protected abstract saveErrorRollback(v: boolean): void;
  /** 答错/超时的提示文案。 */
  protected abstract wrongToast(name: string, timedOut: boolean): string;
  /** 结束时的摘要 HTML。 */
  protected abstract summaryHtml(elapsedMs: number): string;

  abstract getModeSettings(): ModeSettingsPanel | null;
  abstract refresh(): void;
  abstract onSubmit(v: string): void;
  abstract onInput(v: string): void;
  abstract onUnitClick(adcode: string): boolean | void;
  /** 出题：设当前题并渲染（输入模式含自动跟随/聚焦，点击模式含题卡提示）。 */
  abstract ask(u: Unit): void;
  /** 后续选题（输入模式顺序 BFS，点击模式随机/错题）。 */
  abstract nextUnit(pool: Unit[]): Unit;
  abstract showStartHint(): void;

  // ==================== 差异点：子类按需覆写（默认无副作用） ====================

  /** enter 时配置搜索框（输入模式设 placeholder/requireEnter，点击模式无需）。 */
  protected configureSearch(_paused: boolean): void {}
  /** 新会话开始时清子类特有状态（输入模式清 lastGreen/activeProvince）。 */
  protected resetSessionSpecific(): void {}
  /** enter 完成后的收尾（输入模式清空搜索框）。 */
  protected onEntered(): void {}
  /** 作用域变化后的子类同步（输入模式同步 activeProvince）。 */
  protected onScopeChanged(): void {}
  /** 省级全国下钻后的子类同步（输入模式同步 activeProvince）。 */
  protected onDrill(_provinceAdcode: string): void {}
  /** answer 开始时的收尾（输入模式清计时器）。 */
  protected onAnswerStart(): void {}
  /** 答对后的子类同步（输入模式记 lastGreen，点击模式弹答对提示）。 */
  protected onCorrect(_q: string): void {}
  /** 错误回滚撤回后的收尾（输入模式重新聚焦搜索框）。 */
  protected onRollbackRestored(): void {}
  /** 暂停时的子类同步（输入模式清计时器）。 */
  protected onPause(): void {}
  /** 恢复时的子类同步（点击模式重显题卡 + 秒表）。 */
  protected onResume(): void {}
  /** 重置时的子类同步（点击模式清秒表显示）。 */
  protected onResetHook(): void {}
  /** start 前的子类同步（输入模式同步 activeProvince）。 */
  protected beforeStartPool(): void {}
  /** start 后的子类同步（输入模式补 activeProvince + 刷新进度 + 清题卡）。 */
  protected onStarted(_first: Unit): void {}
  /** 是否允许开始（输入模式禁止暂停态重开）。 */
  protected canStart(): boolean { return !this.started; }
  /** 是否允许双击下钻（输入模式暂停态禁止）。 */
  protected canDoubleClickDrill(): boolean { return true; }
  /** 加载进度时是否用旧格式兜底（输入模式兼容旧记录）。 */
  protected legacyResults(): boolean { return false; }
  /** 持久化进度时附加的子类字段。 */
  protected persistExtra(): Record<string, unknown> { return { wrongToastShown: this.wrongOrder.toastShown }; }
  /** 从已存进度恢复子类特有字段。 */
  protected restoreSessionSpecific(_record: Record<string, unknown>): void {}

  // ==================== 粒度 ====================

  /** 省级全国（省级地图 + 34 省池）。 */
  isProvinceNation() {
    return this.granularity === 'province' && this.scopeProvince === null;
  }

  /** 世界全国（世界地图 + 195 国池）。 */
  isWorldNation() {
    return this.granularity === 'world' && this.scopeProvince === null;
  }

  /** 世界粒度下的大洲范围（null = 全世界）。 */
  getWorldContinent(): Continent | null {
    return this.granularity === 'world' ? this.worldContinent : null;
  }

  /** 世界粒度下的次区域范围（null = 全洲；非世界粒度或无大洲时返回 null）。 */
  getWorldSubregion(): SubregionId | null {
    if (this.granularity !== 'world' || !this.worldContinent) return null;
    return this.worldSubregion;
  }

  /**
   * 切换世界粒度下的大洲范围（仅世界粒度且未开始时生效）。
   *
   * Q31 守卫：以前只靠 UI 隐藏（chromeSync）保证「未开始时才可切换」，代码本身没有判断；
   * 「单击国家下钻」与「点空白返回」都会走这条路径，故把守卫下沉到代码里。
   */
  setWorldContinent(c: Continent | null) {
    if (this.granularity !== 'world' || this.started || this.worldContinent === c) return;
    this.worldContinent = c;
    // 换洲必须清空次区域（次区域 ⊆ 大洲，跨洲保留会渲染出空地图）
    this.worldSubregion = null;
    this.enter();
  }

  /**
   * 切换世界粒度下的次区域范围（null = 全洲）。
   * 仅当该大洲确实提供次区域（`hasSubregions`：分区数 > 1 且不在 `NO_SUBREGION_DRILL` 里）时生效；
   * 跨洲、未选洲或大洋洲这类不再细分的大洲一律忽略。
   */
  setWorldSubregion(s: SubregionId | null) {
    if (this.granularity !== 'world' || this.started) return;
    if (!this.worldContinent || !hasSubregions(this.ctx.data, this.worldContinent)) return;
    const target = s && subregionOfContinent(this.ctx.data, s) === this.worldContinent ? s : null;
    if (this.worldSubregion === target) return;
    this.worldSubregion = target;
    this.enter();
  }

  getGranularity(): Granularity {
    return this.granularity;
  }

  /**
   * 应用 SEO 落地页深链参数（Q26）。仅启动时调用一次，故无需 started 守卫
   * （启动时不可能已有会话开始）。
   *
   * 参数已在 parseScopeQuery 中校验过合法性，这里只按序落状态：
   * 粒度 → 省下钻（仅 city）→ 大洲/次区域（仅 world）。
   */
  applyScopeQuery(q: { granularity: Granularity | null; continent: Continent | null; subregion: SubregionId | null; province: string | null }) {
    if (q.granularity && q.granularity !== this.granularity) {
      this.granularity = q.granularity;
      this.persistGranularity();
      this.worldContinent = null;
      this.worldSubregion = null;
    }
    if (this.granularity === 'city' && q.province) {
      // 省下钻：只接受真实存在的省，且该省确有地级单位
      const exists = this.ctx.data.provinces.some((p) => p.adcode === q.province);
      if (exists) this.setScopeProvince(q.province);
    }
    if (this.granularity === 'world' && q.continent) {
      this.worldContinent = q.continent;
      // 深链可能带来已关闭的次区域（如大洋洲）：这类大洲不再细分，忽略参数避免"有次区域视图却没有次区域行"
      this.worldSubregion = hasSubregions(this.ctx.data, q.continent) ? q.subregion : null;
    }
  }

  /** 全国层切换省级/市级/世界（仅全国视图且未开始时可调用）。 */
  setGranularity(g: Granularity) {
    if (this.granularity === g || this.started) return;
    this.granularity = g;
    // 离开世界粒度即清除大洲与次区域范围（二者仅在世界粒度语义下有效）
    if (g !== 'world') {
      this.worldContinent = null;
      this.worldSubregion = null;
    }
    this.persistGranularity();
    this.enter();
  }

  private loadGranularity(): Granularity {
    return loadStoredGranularity(this.storagePrefix(), 'province'); // 首访默认省级
  }

  private persistGranularity() {
    saveStoredGranularity(this.storagePrefix(), this.granularity);
  }

  // ==================== 出题顺序 ====================

  setOrderMode(mode: OrderMode) {
    this.orderMode = mode;
    this.persistOrderMode();
  }

  getOrderMode(): OrderMode {
    return this.orderMode;
  }

  private orderModeStorageKey() {
    return 'china-admin-mode-order:' + this.storagePrefix();
  }

  private loadOrderMode(): OrderMode {
    try {
      const raw = localStorage.getItem(this.orderModeStorageKey());
      return this.parseOrderMode(raw);
    } catch {
      return this.defaultOrderMode();
    }
  }

  private persistOrderMode() {
    try {
      localStorage.setItem(this.orderModeStorageKey(), this.orderMode);
    } catch {
      /* 忽略存储失败 */
    }
  }

  // ==================== 题面口径（国名/首都、中文/英文、省名/简称） ====================

  getQuestionNaming(): QuestionNaming {
    return { ...this.naming };
  }

  /**
   * 切换题面/取名口径。只改传入的字段（UI 上三组分段按钮各自切换）。
   *
   * 守卫与「粒度」一致：**答题进行中不允许切换** —— 题面已经发出去了，换口径会让同一题
   * 的题目与答案对不上（UI 侧这些分段按钮在开始后也整组收起，这里把守卫下沉到代码里，
   * 免得将来某条路径绕过 UI 直接调用）。
   */
  setQuestionNaming(patch: Partial<QuestionNaming>) {
    if (this.started) return;
    const next: QuestionNaming = { ...this.naming, ...patch };
    if (next.world === this.naming.world && next.lang === this.naming.lang && next.province === this.naming.province) return;
    this.naming = next;
    saveStoredNaming(this.storagePrefix(), next);
    this.onNamingChanged();
    this.refresh();
  }

  /** 口径变化后的子类收尾（点击模式要按新口径重写题卡；输入模式无需）。 */
  protected onNamingChanged(): void {}

  // ==================== 浏览标签（未开始时的全量地名） ====================

  /** 当前视图该显示哪一层的浏览标签（世界=国名 / 省级全国=省名 / 其余=地级市名）。 */
  protected browseLabelScope(): BrowseLabelScope {
    if (this.isWorldNation()) return 'world';
    if (this.isProvinceNation()) return 'provinceNation';
    return 'city'; // 市级全国 / 单省 / 省级全国下钻某省：显示该范围内的地级市名
  }

  /**
   * 浏览标签片段（喂给 `refresh()` 的渲染状态）。
   *
   * 只在**未开始**或**已结算**时给全量地名；答题进行中返回空 —— 此时地图上只保留已作答的绿/红标签，
   * 未作答的没有文字（用户口径：开始后标签清空，但答题反馈不退化）。
   */
  protected browseLabelState(): Partial<RenderState> {
    if (this.started && !this.settled) return {};
    return browseLabelState(this.browseLabelScope(), this.ctx.settings.showBrowseLabels);
  }

  /**
   * 结算卡片已弹出（外壳调用）：把这次会话记为「已结束」，让浏览标签复现。
   * 暂停（`onEnd`）不走这里 —— 暂停仍是进行中，回来继续答题。
   */
  onSettlementShown() {
    if (this.settled) return;
    this.settled = true;
    this.refresh();
  }

  // ==================== 生命周期 ====================

  enter() {
    this.settled = false; // 回到开始状态：浏览标签复现
    if (this.paused) {
      this.syncScopeView();
      this.configureSearch(true);
      this.ctx.setHint('');
      this.refresh();
      this.ctx.showStopwatch(this.stopwatch.elapsedMs());
      this.ctx.updateProgress();
      this.onEntered();
      return;
    }
    this.exit();
    this.resetSessionSpecific();
    this.ensureScopeProvince();
    this.order = this.activePool().map((u) => u.adcode);
    this.restore();
    this.syncScopeView();
    this.configureSearch(false);
    this.showStartHint();
    this.refresh();
    this.ctx.updateProgress();
    this.onEntered();
  }

  exit() {
    this.stopwatch.stop();
    this.started = false;
    this.paused = false;
    this.settled = false;
    this.rollbacking = false;
    if (this.rollbackTimer !== null) {
      window.clearTimeout(this.rollbackTimer);
      this.rollbackTimer = null;
    }
    this.ctx.showTimer(null);
    this.ctx.showStopwatch(null);
  }

  pause() {
    if (!this.started || this.paused) return;
    this.paused = true;
    this.stopwatch.pause();
    this.onPause();
    this.ctx.showStopwatch(this.stopwatch.elapsedMs());
  }

  resume() {
    if (!this.started || !this.paused) return;
    this.paused = false;
    this.stopwatch.resume();
    this.onResume();
  }

  isPaused() { return this.paused; }
  getProgress() { return progressOf(this.order.length, this.results); }
  hasProgress() { return this.green.size > 0 || this.red.size > 0 || !!this.question; }
  isStarted() { return this.started; }

  onUnitDblClick(adcode: string) {
    if (!this.canDoubleClickDrill()) return;
    if (this.isWorldNation()) return; // 世界粒度：国家为最小单元，永不钻取
    if (this.started) {
      this.ctx.toast(t('common.underTestNoDrill'));
      return;
    }
    const u = this.ctx.byAdcode.get(adcode);
    if (u) this.ctx.renderer.drillToProvince(u.provinceAdcode);
  }

  onSkip() {
    if (!this.started || this.rollbacking || !this.question) return;
    this.answer(false, false);
  }

  onEnd() { this.pause(); }

  onReset() {
    this.stopwatch.stop();
    this.onResetHook();
    this.started = false;
    this.paused = false;
    this.settled = false;
    this.rollbacking = false;
    this.ctx.setTestRunning?.(false); // 重置也是「结束」：展开排行榜侧栏
    if (this.rollbackTimer !== null) {
      window.clearTimeout(this.rollbackTimer);
      this.rollbackTimer = null;
    }
    this.clearSaved();
    this.enter();
  }

  onViewChange() {
    if (this.started || this.syncingScope) return;
    this.setScopeProvince(this.ctx.renderer.currentProvince());
    this.onScopeChanged();
    this.order = this.activePool().map((u) => u.adcode);
    this.restore();
    this.showStartHint();
    this.ctx.updateProgress();
  }

  /** 地图空白点击返回全国：按当前全国粒度恢复（省级全国或市级全国）。 */
  // （世界层级内的「退一级」见下方的 onBackToNation 实现）

  // ==================== 内部：作用域 ====================

  private scopeStorageKey() {
    return 'china-admin-mode-scope:' + this.storagePrefix();
  }

  private ensureScopeProvince() {
    if (this.scopeLoaded) return;
    if (this.granularity === 'province' || this.granularity === 'world') {
      // 省级全国 / 世界全国是入口：会话级钻省不跨刷新/切换恢复，总是从全国粒度开始
      this.scopeProvince = null;
      this.scopeLoaded = true;
      return;
    }
    const saved = loadScopeProvince(this.ctx.data, this.scopeStorageKey());
    this.scopeProvince = saved === undefined ? null : saved;
    this.scopeLoaded = true;
  }

  private setScopeProvince(scopeProvince: string | null) {
    this.scopeProvince = scopeProvince;
    this.scopeLoaded = true;
    // 仅市级粒度持久化单省记忆；省级全国/世界全国下钻的单省是会话状态（返回全国后回原粒度）
    if (this.granularity === 'city') saveScopeProvince(this.scopeStorageKey(), scopeProvince);
  }

  /** 当前粒度+范围下的有效题目池（省级全国 → 34 个省级虚拟单位；世界全国 → 答题国；否则地级单位）。 */
  protected activePool(): Unit[] {
    if (this.isProvinceNation()) return this.provincePool;
    if (this.isWorldNation()) return this.worldScopedPool();
    return scopedUnits(this.ctx.data, this.scopeProvince);
  }

  /**
   * 世界池按大洲/次区域范围过滤（两级都为 null 时返回全部答题国），
   * 并剔除「忽略面积极小的国家」设置排除的国家（该设置只影响练习，不影响排行榜范围）。
   */
  protected worldScopedPool(): Unit[] {
    const ignored = ignoredIsos();
    const base = ignored.size ? this.worldPool.filter((u) => !ignored.has(u.adcode)) : this.worldPool;
    if (!this.worldContinent) return base;
    const isoToContinent = new Map(this.ctx.data.countries.map((c) => [c.iso, c.continent]));
    if (this.worldSubregion) {
      return base.filter((u) => subregionOfIso(this.ctx.data, u.adcode) === this.worldSubregion);
    }
    return base.filter((u) => isoToContinent.get(u.adcode) === this.worldContinent);
  }

  /** 由 adcode 反查当前池中的单位（省级全国池、世界国家池或地级池）。 */
  protected currentUnitOf(adcode: string | null): Unit | null {
    if (!adcode) return null;
    if (this.isProvinceNation()) return this.provincePool.find((u) => u.adcode === adcode) ?? null;
    if (this.isWorldNation()) return this.worldPool.find((u) => u.adcode === adcode) ?? null;
    return this.ctx.byAdcode.get(adcode) ?? null;
  }

  private syncScopeView() {
    this.ensureScopeProvince();
    this.syncingScope = true;
    try {
      if (this.isProvinceNation()) {
        // 省级全国：省级地图视图，不渲染地级；含港澳放大框；不下钻
        this.ctx.renderer.setProvinceMode(true, { inset: true, allowDrill: false });
        if (this.ctx.renderer.currentProvince()) this.ctx.renderer.backToNation();
        return;
      }
      if (this.isWorldNation()) {
        // 世界全国：世界地图视图；无放大框、无省级下钻。大洲/次区域范围非空时聚焦并隐藏其他面。
        this.ctx.renderer.setWorldMode(true, this.worldContinent, this.worldSubregion);
        return;
      }
      // 市级（全国或单省）：地级地图
      this.ctx.renderer.setProvinceMode(false, { inset: false });
      syncScopeView(this.scopeProvince, this.ctx.renderer.currentProvince(), this.ctx.renderer);
    } finally {
      this.syncingScope = false;
    }
  }

  /**
   * 世界粒度未开始时点击某国：逐层下钻 —— 世界层 → 该洲；已在大洲层 → 该国所属次区域。
   * （Q12：世界 → 大洲 → 次区域（叶子）；次区域内点国家不再下钻。）
   * 已是当前范围则不重复下钻（避免无谓重进会话）。
   */
  protected drillFromWorldNation(continent: Continent, iso: string) {
    if (this.granularity !== 'world' || this.started) return;
    if (this.worldContinent !== continent) {
      this.worldContinent = continent;
      this.worldSubregion = null;
      this.enter();
      return;
    }
    // 已在该洲内：若该洲有次区域且该国所属次区域与当前不同，则再下一层
    if (!hasSubregions(this.ctx.data, continent)) return;
    const sr = subregionOfIso(this.ctx.data, iso);
    if (!sr || this.worldSubregion === sr) return;
    this.worldSubregion = sr;
    this.enter();
  }

  /**
   * 地图空白点击：返回上一级（Q13）。
   * 次区域内 → 回大洲；大洲内 → 回世界；中国钻省 → 回全国。
   * 答题进行中不生效（Q7）——大洲/次区域常常正是答题层，故此处必须拦。
   */
  onBackToNation() {
    if (this.started) {
      this.ctx.toast(t('common.backToNationBlocked'));
      return;
    }
    if (this.scopeProvince === null && this.granularity === 'world') {
      return this.backWorldLevel();
    }
    this.setScopeProvince(null);
    this.onScopeChanged();
    this.order = this.activePool().map((u) => u.adcode);
    this.restore();
    this.syncScopeView();
    this.showStartHint();
    this.refresh();
    this.ctx.updateProgress();
  }

  /** 世界层级内退一级：次区域 → 大洲 → 世界（按钮状态随之回退，见 Q13）。 */
  private backWorldLevel() {
    if (this.worldSubregion) this.worldSubregion = null;
    else if (this.worldContinent) this.worldContinent = null;
    else return; // 已在世界层，无上级
    this.enter();
  }

  /**
   * 省级全国未开始点省：下钻该省并进入其地级练习（粒度保持省级，返回全国后恢复省级全国）。
   *
   * **唯一层级的省级单位（京津沪渝/港澳台）不下钻**：它们各自只有一个下级单位（就是它自己），
   * 钻进去只是"1 个单位的练习"（用户口径 2026-09 + `canDrillProvince`）。
   */
  protected drillFromProvinceNation(provinceAdcode: string) {
    if (!canDrillProvince(provinceAdcode)) {
      this.ctx.toast(t('common.noDrillSingleUnit'));
      return;
    }
    const p = provinceByAdcode(this.ctx.data, provinceAdcode);
    if (!p) return;
    this.scopeProvince = provinceAdcode;
    this.scopeLoaded = true;
    this.onDrill(provinceAdcode);
    this.order = scopedUnits(this.ctx.data, this.scopeProvince).map((u) => u.adcode);
    this.restore();
    this.syncScopeView(); // setProvinceMode(false) + drill
    this.showStartHint();
    this.refresh();
    this.ctx.updateProgress();
  }

  // ==================== 内部：进度持久化 ====================

  private storageKey() {
    if (this.scopeProvince !== null) return 'china-admin-mode-progress:' + this.storagePrefix() + ':' + this.scopeProvince;
    if (this.granularity === 'province')
      return 'china-admin-mode-progress:' + this.storagePrefix() + ':province-nation';
    if (this.granularity === 'world') {
      // 大洲/次区域范围各自独立进度键（全世界 :world-nation，某洲 :world-continent-XX，某次区域 :world-subregion-XXX）
      if (this.worldSubregion)
        return 'china-admin-mode-progress:' + this.storagePrefix() + ':world-subregion-' + this.worldSubregion;
      return this.worldContinent
        ? 'china-admin-mode-progress:' + this.storagePrefix() + ':world-continent-' + this.worldContinent
        : 'china-admin-mode-progress:' + this.storagePrefix() + ':world-nation';
    }
    return 'china-admin-mode-progress:' + this.storagePrefix() + ':nation';
  }

  protected restore() {
    this.resetProgressState();
    const saved = loadProgress(this.storageKey(), this.order, this.legacyResults());
    this.green = saved.green;
    this.red = saved.red;
    this.results = saved.results;
    this.question = saved.question;
    this.restoreSessionSpecific(saved.record);
    this.ok = this.green.size;
    this.fail = this.red.size;
    this.wrongOrder.toastShown = saved.record.wrongToastShown === true;
  }

  protected persist() {
    saveProgress(this.storageKey(), {
      green: this.green,
      red: this.red,
      results: this.results,
      question: this.question,
    }, this.persistExtra());
    this.ctx.updateProgress();
  }

  protected clearSaved() {
    clearProgress(this.storageKey());
  }

  private resetProgressState() {
    this.green.clear();
    this.red.clear();
    this.question = null;
    this.ok = 0;
    this.fail = 0;
    this.results = [];
    this.rollbackCounted.clear();
    this.wrongOrder = initWrongOrderState(this.activePool(), this.scoreOf);
    this.resetSessionSpecific();
  }

  // ==================== 内部：开始 / 作答 ====================

  protected start(continueSaved: boolean) {
    if (!this.canStart()) return;
    this.ensureScopeProvince();
    this.syncScopeView();
    this.beforeStartPool();
    this.order = this.activePool().map((u) => u.adcode);
    if (continueSaved) {
      this.restore();
    } else {
      this.clearSaved();
      this.resetProgressState();
    }

    const resumed = this.question ? this.currentUnitOf(this.question) : null;
    const pool = this.unvisited();
    const first = resumed ?? (pool.length ? this.chooseFirst(pool) : null);
    if (!first) {
      this.finish();
      return;
    }
    this.started = true;
    this.paused = false;
    this.settled = false; // 开始答题：浏览标签收起
    this.ctx.setTestRunning?.(true); // 开始测验：收起排行榜侧栏
    this.onStarted(first);
    this.stopwatch.start((elapsedMs) => this.ctx.showStopwatch(elapsedMs));
    this.ask(first);
  }

  protected unvisited(): Unit[] {
    const pool = this.activePool();
    return pool.filter((u) => !this.green.has(u.adcode) && !this.red.has(u.adcode));
  }

  /** 首题选择：错题模式按分数最低，其余随机。 */
  protected chooseFirst(pool: Unit[]): Unit {
    if (this.orderMode === 'wrong') return pickWrongNext(pool, this.scoreOf, this.wrongOrder, this.ctx.toast);
    return this.ctx.randomUnit(pool);
  }

  protected answer(correct: boolean, scored: boolean, timedOut = false) {
    this.onAnswerStart();
    const q = this.question;
    if (!q) return;
    // 答错提示里的「正确答案」也走当前口径：题卡写首都/简称时，答案提示不能还写国名/省全名
    const unit = this.currentUnitOf(q);
    const name = unit ? this.displayNameOf(unit) : q;

    // 错误回滚：答错即计入 fail/熟练度/进度红格（仅第一次计入），随后短暂显示红色并撤回，
    // 重答同一题直到答对。**每次答错都标红**（不只是第一次），红显时长 ROLLBACK_RED_MS。
    if (this.errorRollback && !correct) {
      const firstWrong = !this.rollbackCounted.has(q);
      if (firstWrong) {
        this.rollbackCounted.add(q);
        this.recordPractice(q, false);
        this.fail += 1;
        this.results.push('red'); // 永久进度：只有第一次答错在进度条上留红格
      }
      // 标红与计分解耦：无论第几次答错，当前题都要亮红（用户要求「每次都要标红」）。
      // this.red 在这里只承担**临时高亮**，撤回时统一清掉；永久红格由上面的 results 记录。
      this.red.add(q);
      this.question = null;
      this.ctx.toast(this.wrongToast(name, timedOut));
      this.panToUnit(q); // 答错：镜头跟随到正确答案位置（缩放不变）
      this.persist();
      // 先显示红色标记，停留后撤回，恢复当前题重新作答
      this.refresh();
      this.rollbacking = true;
      if (this.rollbackTimer !== null) window.clearTimeout(this.rollbackTimer);
      this.rollbackTimer = window.setTimeout(() => {
        this.rollbackTimer = null;
        this.rollbacking = false;
        this.red.delete(q); // 临时高亮结束（进度红格已记在 results 里，不受影响）
        this.question = q;
        this.refresh();
        this.onRollbackRestored();
      }, ROLLBACK_RED_MS);
      return;
    }

    this.question = null;
    if (scored) this.recordPractice(q, correct);
    if (correct) {
      this.green.add(q);
      // 错误回滚后的最终答对：地图变绿，但不计入 ok/进度（进度保留第一次红格），也不重复记熟练度
      if (!this.rollbackCounted.has(q)) {
        this.ok += 1;
        this.results.push('green');
      }
      this.onCorrect(q);
      this.ctx.renderer.flash(q);
    } else {
      this.red.add(q);
      this.fail += 1;
      this.results.push('red');
      this.ctx.toast(this.wrongToast(name, timedOut));
      this.panToUnit(q); // 答错：镜头跟随到正确答案位置（缩放不变）
    }
    this.persist();
    const pool = this.unvisited();
    if (!pool.length) {
      this.refresh();
      this.finish();
      return;
    }
    this.ask(this.nextUnit(pool));
  }

  /**
   * 答错后把镜头跟随到**正确答案**的位置，但**不改变缩放**。
   *
   * 与世界档的「自动跟随」区分开：自动跟随是出题时按面积决定缩放（越小的国家放得越大），
   * 这里是答错后的纠错反馈——只平移，保留用户当前的缩放级别，避免视角被强行拉走。
   * 省级全国（虚拟省单位）没有真实几何，跳过。
   */
  protected panToUnit(adcode: string) {
    if (this.isProvinceNation()) return;
    if (this.isWorldNation()) this.ctx.renderer.panWorldCountry(adcode);
    else this.ctx.renderer.panUnit(adcode);
  }

  /** 熟练度记录：省级全国 → 省级熟练度；世界全国 → 国家熟练度；市级 → 地级熟练度（完全隔离）。 */  protected recordPractice(adcode: string, correct: boolean) {
    if (this.isProvinceNation()) this.ctx.store.recordProvinceAnswer(adcode, correct);
    else if (this.isWorldNation()) this.ctx.store.recordWorldAnswer(adcode, correct);
    else this.ctx.store.recordAnswer(adcode, correct);
  }

  // ==================== 内部：结算 ====================

  private finish() {
    const elapsedMs = this.stopwatch.elapsedMs();
    this.stopwatch.stop();
    this.started = false;
    this.paused = false;
    this.ctx.setTestRunning?.(false); // 结算：自动展开排行榜侧栏
    this.ctx.showTimer(null);
    this.ctx.showStopwatch(null);
    this.ctx.updateProgress();
    const result = this.buildResult(elapsedMs);
    this.ctx.showSummary(
      this.summaryHtml(elapsedMs),
      () => {
        this.clearSaved();
        this.enter();
      },
      result,
    );
  }

  getScopeProvince() {
    // 排行榜/结算的省级全国范围用哨兵；世界全国范围用世界哨兵；大洲/次区域范围各自哨兵；市级沿用 scopeProvince
    if (this.scopeProvince === null && this.granularity === 'province') return PROVINCE_NATION_SCOPE;
    if (this.scopeProvince === null && this.granularity === 'world') {
      if (this.worldSubregion) return subregionScope(this.worldSubregion);
      return this.worldContinent ? continentScope(this.worldContinent) : WORLD_NATION_SCOPE;
    }
    return this.scopeProvince;
  }

  /** 当前世界范围的排行榜哨兵（无世界范围时返回 null）。 */
  private worldScope(): string | null {
    if (this.scopeProvince !== null || this.granularity !== 'world') return null;
    if (this.worldSubregion) return subregionScope(this.worldSubregion);
    return this.worldContinent ? continentScope(this.worldContinent) : WORLD_NATION_SCOPE;
  }

  /** 快照当前会话结果（全国排行榜结算卡片用）。 */
  collectResult(): RoundResult | null {
    if (!this.started && !this.question && this.green.size === 0 && this.red.size === 0) return null;
    return this.buildResult(this.stopwatch.elapsedMs());
  }

  protected buildResult(elapsedMs: number): RoundResult {
    return {
      mode: this.id as Extract<Mode, 'self' | 'click'>,
      scopeProvince:
        this.scopeProvince === null && this.granularity === 'province'
          ? PROVINCE_NATION_SCOPE
          : (this.worldScope() ?? this.scopeProvince),
      scopeLabel: this.scopeLabel(),
      totalUnits: this.order.length,
      correct: this.ok,
      wrong: this.fail,
      elapsedMs,
      finishedAt: Date.now(),
    };
  }

  protected scopeLabel() {
    if (this.scopeProvince === null && this.granularity === 'province') return t('common.provinceNation');
    if (this.scopeProvince === null && this.granularity === 'world') {
      const continentName = this.worldContinent
        ? CONTINENTS.find((c) => c.id === this.worldContinent)?.name ?? t('common.world')
        : t('common.world');
      if (!this.worldSubregion) return continentName;
      const sr = subregionById(this.ctx.data, this.worldSubregion);
      return sr ? sr.name : continentName;
    }
    if (this.scopeProvince) return this.ctx.data.provinces.find((p) => p.adcode === this.scopeProvince)?.name ?? t('common.currentProvince');
    return t('common.nation');
  }

  /** 熟练度读取：世界粒度（含大洲）共用同一套国家熟练度（Q：大洲榜独立但熟练度共享）。 */
  protected scoreOf = (u: Unit) => {
    if (this.isProvinceNation()) return this.ctx.store.getProvincePractice(u.adcode).score;
    if (this.isWorldNation()) return this.ctx.store.getWorldPractice(u.adcode).score;
    return this.ctx.store.getPractice(u.adcode).score;
  };

  // ==================== 渲染状态片段（输入 / 点击共用） ====================

  /** 世界国家中文名（找不到就回落 iso）。 */
  protected countryName(iso: string): string {
    return this.ctx.data.countries.find((c) => c.iso === iso)?.name ?? iso;
  }

  /**
   * 某个单位在当前口径下的**显示名**：题卡（点击模式）、地图标签、答错提示共用这一处。
   *
   * 为什么不各自拼一份：这三处都要跟着「国名/首都」「中文/英文」「省名/简称」变，任何一处漏改
   * 就会出现「题卡写首都、标签写国名」这类自相矛盾的界面。数据缺失时逐级回落（首都 → 国名，
   * 英文 → 中文），保证永远有可显示文本。
   */
  protected displayNameOf(unit: Unit): string {
    if (this.isWorldNation()) return this.worldDisplayName(unit.adcode);
    // 省级全国：「省名」档沿用历史题面（省全名，如 广东省），「简称」档才是单字（沪）
    if (this.isProvinceNation()) return this.naming.province === 'abbr' ? provinceAbbr(this.ctx.data, unit.adcode) : unit.name;
    return unit.name; // 地级（市级全国 / 单省）不受取名口径影响
  }

  /**
   * 世界档显示名：国名 或 首都名，再按语言取中/英文。
   *
   * `flag` 档也走这里 → 返回**国名**：国旗档只换题面（标签里放不下旗帜，用户口径），
   * 语言开关照常作用于标签与答错提示里的名字。
   */
  protected worldDisplayName(iso: string): string {
    const names = this.ctx.data.countryNames[iso];
    if (this.naming.world === 'capital') {
      const capital = this.naming.lang === 'en' ? names?.capitalEn : names?.capital;
      return capital || this.countryName(iso);
    }
    if (this.naming.lang === 'en') return names?.en || this.countryName(iso);
    return this.countryName(iso);
  }

  /**
   * 某国国旗的资源路径（点击模式「国旗」档的题面用）；没有资源时返回 null，
   * 调用方回落到国名题面 —— 宁可退化成文字题，也不要给一张破图/空白卡片。
   */
  protected worldFlagSrc(iso: string): string | null {
    const file = this.ctx.data.countryFlags[iso];
    return file ? `data/flags/${file}` : null;
  }

  /**
   * 省级全国**地图标签**的文本。
   *
   * 与题面口径分开是因为两者历史上就不同：标签一直是去后缀省名（广东省 → 广东），
   * 而题面是省全名（广东省）。「简称」档两者统一成单字（沪）—— 这正是用户要的「标签也显示简称」。
   */
  protected provinceLabelTextOf(adcode: string): string {
    return this.naming.province === 'abbr'
      ? provinceAbbr(this.ctx.data, adcode)
      : provinceShortName(this.ctx.data, adcode);
  }

  /**
   * 省级全国的省名标签：已作答省显示绿/红简称，未作答返回 `null`。
   *
   * 非省级全国返回 `undefined`，即渲染状态里不使用这个系列。
   * 原先输入与点击两个子类各自抄了一份逐字相同的实现，且输入模式还私藏了一份
   * `provinceShortName`（与 `province.ts` 的同名函数完全等价），一并收敛到这里。
   */
  protected provinceLabelOf(): RenderState['provinceLabel'] {
    if (!this.isProvinceNation()) return undefined;
    return (provinceAdcode) => {
      if (this.green.has(provinceAdcode)) {
        return { text: this.provinceLabelTextOf(provinceAdcode), color: 'green' as const };
      }
      if (this.red.has(provinceAdcode)) {
        return { text: this.provinceLabelTextOf(provinceAdcode), color: 'red' as const };
      }
      return null;
    };
  }

  /** 世界全国的国名标签：已作答国显示绿/红**当前口径的名字**（国名/首都、中/英文）。非世界全国返回 `undefined`。 */
  protected worldLabelOf(): RenderState['worldLabel'] {
    if (!this.isWorldNation()) return undefined;
    return (iso) => {
      if (this.green.has(iso)) return { text: this.worldDisplayName(iso), color: 'green' as const };
      if (this.red.has(iso)) return { text: this.worldDisplayName(iso), color: 'red' as const };
      return null;
    };
  }

  /**
   * 验收探针的**会话状态视图**（见 `quizDiagnostics.ts` 的说明）。
   *
   * 生产路径不调用（只有 URL 带 `?probe=1` 时探针取两次）。存在的意义是把「探针依赖哪些
   * protected 状态」变成一份**编译器可校验**的契约：方法体在类内部，任何被改名 / 删除 /
   * 改签名的成员都会让 `tsc` 在这里直接报错，而不是让探针在验收时静默读到 `undefined`。
   *
   * 返回的是**活值**（getter / setter 直接读写当前字段），故探针取一次即可长期持有。
   */
  diagnostics(): QuizSessionDiagnostics {
    const self = this;
    return {
      get green() { return self.green; },
      set green(v: Set<string>) { self.green = v; },
      get red() { return self.red; },
      set red(v: Set<string>) { self.red = v; },
      get question() { return self.question; },
      set question(v: string | null) { self.question = v; },
      get results() { return self.results; },
      set results(v: ProgressSegment[]) { self.results = v; },
      get fail() { return self.fail; },
      set fail(v: number) { self.fail = v; },
      get started() { return self.started; },
      set started(v: boolean) { self.started = v; },
      get order() { return self.order; },
      get scopeProvince() { return self.scopeProvince; },
      set scopeProvince(v: string | null) { self.scopeProvince = v; },
      get worldContinent() { return self.worldContinent; },
      set worldContinent(v: Continent | null) { self.worldContinent = v; },
      get worldSubregion() { return self.worldSubregion; },
      set worldSubregion(v: SubregionId | null) { self.worldSubregion = v; },
      get orderMode() { return self.orderMode; },
      set orderMode(v: OrderMode) { self.orderMode = v; },
      get naming() { return self.naming; },
      set naming(v: QuestionNaming) { self.naming = v; },
      get errorRollback() { return self.errorRollback; },
      set errorRollback(v: boolean) { self.errorRollback = v; },
      get rollbackCounted() { return self.rollbackCounted; },
      get rollbacking() { return self.rollbacking; },
      activePool: () => self.activePool(),
      worldScopedPool: () => self.worldScopedPool(),
      persist: () => self.persist(),
      start: (continueSaved) => self.start(continueSaved),
      answer: (correct, scored, timedOut) => self.answer(correct, scored, timedOut),
    };
  }
}