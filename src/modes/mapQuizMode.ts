import type { Continent, Mode, RoundResult, SubregionId, Unit } from '../types';
import { CONTINENTS } from '../types';
import type { ModeCtx, OrderMode, ProgressSegment } from './types';
import { BaseMode } from './baseMode';
import { Stopwatch } from '../ui/stopwatch';
import { clearProgress, loadProgress, loadScopeProvince, progressOf, saveProgress, saveScopeProvince, scopedUnits, syncScopeView } from './progress';
import { initWrongOrderState, pickWrongNext, type WrongOrderState } from './wrongOrder';
import { t } from '../i18n';
import type { ModeSettingsPanel } from '../modeSettings';
import {
  buildProvinceAdjacency,
  continentScope,
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
  protected wrongOrder: WrongOrderState = initWrongOrderState([], () => 0);
  protected errorRollback = false;
  protected rollbackCounted = new Set<string>(); // 错误回滚中已计入第一次答错的单位
  protected rollbacking = false; // 错误回滚展示中，暂不接受作答
  protected rollbackTimer: number | null = null; // 回滚延时定时器
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
   * 仅当该大洲确实提供次区域（分区数 > 1）时生效；跨洲或未选洲时忽略。
   */
  setWorldSubregion(s: SubregionId | null) {
    if (this.granularity !== 'world' || this.started) return;
    if (!this.worldContinent) return;
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
      this.worldSubregion = q.subregion;
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

  private granularityStorageKey() {
    return 'china-admin-mode-granularity:' + this.storagePrefix();
  }

  private loadGranularity(): Granularity {
    try {
      const raw = localStorage.getItem(this.granularityStorageKey());
      if (raw === 'city') return 'city';
      if (raw === 'world') return 'world';
      return 'province'; // 首次默认省级
    } catch {
      return 'province';
    }
  }

  private persistGranularity() {
    try {
      localStorage.setItem(this.granularityStorageKey(), this.granularity);
    } catch {
      /* 忽略存储失败 */
    }
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

  // ==================== 生命周期 ====================

  enter() {
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
    this.rollbacking = false;
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

  /** 当前粒度+范围下的有效题目池（省级全国 → 34 个省级虚拟单位；世界全国 → 195 国或某洲国家；否则地级单位）。 */
  protected activePool(): Unit[] {
    if (this.isProvinceNation()) return this.provincePool;
    if (this.isWorldNation()) return this.worldScopedPool();
    return scopedUnits(this.ctx.data, this.scopeProvince);
  }

  /** 世界池按大洲/次区域范围过滤（两级都为 null 时返回全部 195 国）。 */
  protected worldScopedPool(): Unit[] {
    if (!this.worldContinent) return this.worldPool;
    const isoToContinent = new Map(this.ctx.data.countries.map((c) => [c.iso, c.continent]));
    if (this.worldSubregion) {
      return this.worldPool.filter((u) => subregionOfIso(this.ctx.data, u.adcode) === this.worldSubregion);
    }
    return this.worldPool.filter((u) => isoToContinent.get(u.adcode) === this.worldContinent);
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

  /** 省级全国未开始点省：下钻该省并进入其地级练习（粒度保持省级，返回全国后恢复省级全国）。 */
  protected drillFromProvinceNation(provinceAdcode: string) {
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
    const name = this.currentUnitOf(q)?.name ?? q;

    // 错误回滚：第一次答错计入 fail/熟练度/进度红格，随后短暂显示红色并撤回，重答同一题直到答对
    if (this.errorRollback && !correct) {
      const firstWrong = !this.rollbackCounted.has(q);
      if (firstWrong) {
        this.rollbackCounted.add(q);
        this.recordPractice(q, false);
        this.red.add(q);
        this.fail += 1;
        this.results.push('red');
      }
      this.question = null;
      this.ctx.toast(this.wrongToast(name, timedOut));
      this.persist();
      // 先显示红色标记，短暂停留后撤回，恢复当前题重新作答
      this.refresh();
      this.rollbacking = true;
      if (this.rollbackTimer !== null) window.clearTimeout(this.rollbackTimer);
      this.rollbackTimer = window.setTimeout(() => {
        this.rollbackTimer = null;
        this.rollbacking = false;
        this.red.delete(q);
        this.question = q;
        this.refresh();
        this.onRollbackRestored();
      }, 700);
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

  /** 熟练度记录：省级全国 → 省级熟练度；世界全国 → 国家熟练度；市级 → 地级熟练度（完全隔离）。 */
  protected recordPractice(adcode: string, correct: boolean) {
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
}