import type { Mode, RoundResult, Unit } from '../types';
import type { ModeCtx, ModeController, OrderMode, ProgressSegment } from './types';
import { Stopwatch } from '../ui/stopwatch';
import { clearProgress, loadProgress, loadScopeProvince, progressOf, saveProgress, saveScopeProvince, scopedUnits, syncScopeView } from './progress';
import { formatElapsedSeconds } from '../ui/format';
import { initWrongOrderState, pickWrongNext, type WrongOrderState } from './wrongOrder';
import { t } from '../i18n';
import {
  loadSelfAutoFollow,
  loadSelfErrorRollback,
  loadSelfRequireEnter,
  SELF_FOLLOW_ZOOM,
  saveSelfAutoFollow,
  saveSelfErrorRollback,
  saveSelfRequireEnter,
  type ModeSettingsPanel,
} from '../modeSettings';
import {
  buildProvinceAdjacency,
  provinceByAdcode,
  provinceShortName,
  provinceUnits,
  PROVINCE_NATION_SCOPE,
  type Granularity,
} from '../province';
import { normalizeProvince } from '../matcher';

type SelfOrderMode = OrderMode;

/**
 * 自测/输入模式（BFS 扩张）：
 * - 市级（全国/单省）：随机起点作为当前题目（蓝色）→ 输入名称；答对变绿，下一个题目 = 与上一个绿点相邻的单位（优先同省）；
 *   无相邻候选时回退最近的未测单位（岛屿等）；答错保持红色（错误标记）并继续扩张。
 * - 省级（全国）：出题池为 34 个省级单元，BFS 在省-省邻接上扩张；省级答题只计入省级熟练度。
 */
export class SelfTestMode implements ModeController {
  id: Mode = 'self';
  title = t('mode.self.title');
  private green = new Set<string>();
  private red = new Set<string>();
  private question: string | null = null;
  private lastGreen: string | null = null;
  private activeProvince: string | null = null;
  /** 市级单省作用域：null=全国（省级全国或市级全国），省 adcode=该省地级练习（下钻而来）。 */
  private scopeProvince: string | null = null;
  /** 全国层粒度：'province'（省级全国，默认）| 'city'（市级全国）。下钻单省不改变它（返回全国后回到原全国粒度）。 */
  private granularity: Granularity = this.loadGranularity();
  private scopeLoaded = false;
  private syncingScope = false;
  private ok = 0;
  private fail = 0;
  private started = false;
  private order: string[] = [];
  private results: ProgressSegment[] = [];
  private stopwatch = new Stopwatch();
  private paused = false;
  private orderMode: SelfOrderMode = this.loadOrderMode();
  private wrongOrder: WrongOrderState = initWrongOrderState([], () => 0);
  private requireEnter = loadSelfRequireEnter(); // 按下 Enter 确认
  private errorRollback = loadSelfErrorRollback(); // 错误回滚：答错撤回重答
  private autoFollow = loadSelfAutoFollow(); // 自动跟随（倍率固定默认值）
  private rollbackCounted = new Set<string>(); // 错误回滚中已计入第一次答错的单位
  private rollbacking = false; // 错误回滚展示中，暂不接受作答
  private rollbackTimer: number | null = null; // 回滚延时定时器
  private provinceAdjacency = new Map<string, string[]>();
  private provincePool: Unit[] = [];

  constructor(private ctx: ModeCtx) {
    this.provinceAdjacency = buildProvinceAdjacency(ctx.data);
    this.provincePool = provinceUnits(ctx.data, this.provinceAdjacency);
  }

  getModeSettings(): ModeSettingsPanel | null {
    return {
      title: t('mode.self.title'),
      toggles: [
        { key: 'require-enter', label: t('settings.requireEnter'), value: this.requireEnter },
        { key: 'error-rollback', label: t('settings.errorRollback'), value: this.errorRollback },
        { key: 'auto-follow', label: t('settings.autoFollow'), value: this.autoFollow },
      ],
      onChange: (key, value) => {
        if (key === 'require-enter') {
          this.requireEnter = value;
          saveSelfRequireEnter(value);
          this.ctx.search.setRequireEnter(value);
        } else if (key === 'error-rollback') {
          this.errorRollback = value;
          saveSelfErrorRollback(value);
        } else if (key === 'auto-follow') {
          this.autoFollow = value;
          saveSelfAutoFollow(value);
        }
      },
    };
  }

  // ---------- 粒度 ----------

  /** 省级全国（省级地图 + 34 省池）。 */
  isProvinceNation() {
    return this.granularity === 'province' && this.scopeProvince === null;
  }

  getGranularity(): Granularity {
    return this.granularity;
  }

  /** 全国层切换省级/市级（仅全国视图且未开始时可调用）。 */
  setGranularity(g: Granularity) {
    if (this.granularity === g) return;
    this.granularity = g;
    this.persistGranularity();
    this.enter();
  }

  private granularityStorageKey() {
    return 'china-admin-mode-granularity:self';
  }

  private loadGranularity(): Granularity {
    try {
      const raw = localStorage.getItem(this.granularityStorageKey());
      return raw === 'city' ? 'city' : 'province'; // 首次默认省级
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

  // ---------- 生命周期 ----------

  enter() {
    if (this.paused) {
      this.syncScopeView();
      this.ctx.search.setPlaceholder(this.isProvinceNation() ? t('self.provincePlaceholder') : t('self.placeholderFull'));
      this.ctx.setHint('');
      this.refresh();
      this.ctx.showStopwatch(this.stopwatch.elapsedMs());
      this.ctx.updateProgress();
      this.ctx.search.clear();
      return;
    }
    this.exit();
    this.green.clear();
    this.red.clear();
    this.question = null;
    this.lastGreen = null;
    this.ensureScopeProvince();
    this.activeProvince = this.scopeProvince;
    this.ok = 0;
    this.fail = 0;
    this.started = false;
    this.paused = false;
    this.order = this.activePool().map((u) => u.adcode);
    this.restore();
    this.syncScopeView();
    this.ctx.search.setPlaceholder(this.isProvinceNation() ? t('self.provincePlaceholder') : t('self.placeholder'));
    this.ctx.search.setRequireEnter(this.requireEnter);
    this.showStartHint();
    this.refresh();
    this.ctx.updateProgress();
    this.ctx.search.clear();
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
    this.ctx.showTimer(null);
    this.ctx.showStopwatch(this.stopwatch.elapsedMs());
  }

  resume() {
    if (!this.started || !this.paused) return;
    this.paused = false;
    this.stopwatch.resume();
    this.ctx.showTimer(null);
  }

  isPaused() {
    return this.paused;
  }

  setOrderMode(mode: SelfOrderMode) {
    this.orderMode = mode;
    this.persistOrderMode();
  }

  getOrderMode(): SelfOrderMode {
    return this.orderMode;
  }

  refresh() {
    const provinceNation = this.isProvinceNation();
    this.ctx.renderer.render({
      colorOf: (adcode) => {
        if (this.green.has(adcode)) return 'green';
        if (this.question === adcode) return 'blue';
        if (this.red.has(adcode)) return 'red';
        return 'gray';
      },
      // 省级全国：已作答省显示绿/红省名简称标签；当前题蓝色高亮由省级地图渲染
      provinceLabel: provinceNation
        ? (provinceAdcode) => {
            if (this.green.has(provinceAdcode)) {
              return { text: provinceShortName(this.ctx.data, provinceAdcode), color: 'green' };
            }
            if (this.red.has(provinceAdcode)) {
              return { text: provinceShortName(this.ctx.data, provinceAdcode), color: 'red' };
            }
            return null;
          }
        : undefined,
    });
  }

  hasProgress() {
    return this.green.size > 0 || this.red.size > 0 || !!this.question;
  }

  getProgress() {
    return progressOf(this.order.length, this.results);
  }

  isStarted() {
    return this.started;
  }

  onSubmit(v: string) {
    if (this.paused || this.rollbacking || !this.question || !v.trim()) return;
    const best = this.matchInput(v);
    this.answer(!!best && best === this.question);
  }

  onInput(v: string) {
    if (this.paused || this.rollbacking || !this.question || !v.trim()) return;
    const best = this.matchInput(v);
    if (best === this.question) this.answer(true);
  }

  /** 输入匹配：省级全国 → 精确省名匹配；市级 → 地级单位匹配。 */
  private matchInput(v: string): string | null {
    if (this.isProvinceNation()) {
      const ni = normalizeProvince(v);
      if (!ni) return null;
      for (const p of this.provincePool) {
        if (normalizeProvince(p.name) === ni || normalizeProvince(p.shortName) === ni) return p.adcode;
      }
      return null;
    }
    return this.ctx.matcher.bestUnit(v)?.adcode ?? null;
  }

  onUnitClick(adcode: string) {
    if (this.paused || this.rollbacking) return true;
    if (this.started) {
      this.ctx.toast(t('common.underTestNoDrill'));
      return true;
    }
    // 省级全国：未开始时单击某省 → 下钻该省（变成该省地级输入练习；返回全国后回省级全国）
    if (this.isProvinceNation()) {
      this.drillFromProvinceNation(adcode);
      return true;
    }
    /* 市级模式未开始时单击地级市：由 renderer 自动下钻（返回非 true 即可） */
  }

  onUnitDblClick(adcode: string) {
    if (this.paused) return;
    if (this.started) {
      this.ctx.toast(t('common.underTestNoDrill'));
      return;
    }
    const u = this.ctx.byAdcode.get(adcode);
    if (u) this.ctx.renderer.drillToProvince(u.provinceAdcode);
  }

  onSkip() {
    if (!this.started || this.rollbacking || !this.question) return;
    this.answer(false, false, false);
  }

  onEnd() {
    this.pause();
  }

  onReset() {
    this.stopwatch.stop();
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
    this.activeProvince = this.scopeProvince;
    this.order = this.activePool().map((u) => u.adcode);
    this.restore();
    this.showStartHint();
    this.ctx.updateProgress();
  }

  /** 地图空白点击返回全国：按当前全国粒度恢复（省级全国或市级全国）。 */
  onBackToNation() {
    if (this.started) {
      this.ctx.toast(t('common.backToNationBlocked'));
      return;
    }
    this.setScopeProvince(null);
    this.activeProvince = this.scopeProvince;
    this.order = this.activePool().map((u) => u.adcode);
    this.restore();
    this.syncScopeView();
    this.showStartHint();
    this.refresh();
    this.ctx.updateProgress();
  }

  /** 省级全国未开始点省：下钻该省并进入其地级练习（粒度保持省级，返回全国后恢复省级全国）。 */
  private drillFromProvinceNation(provinceAdcode: string) {
    const p = provinceByAdcode(this.ctx.data, provinceAdcode);
    if (!p) return;
    this.scopeProvince = provinceAdcode;
    this.scopeLoaded = true;
    this.activeProvince = provinceAdcode;
    this.order = scopedUnits(this.ctx.data, this.scopeProvince).map((u) => u.adcode);
    this.restore();
    this.syncScopeView(); // setProvinceMode(false) + drill
    this.showStartHint();
    this.refresh();
    this.ctx.updateProgress();
  }

  // ---------- 内部 ----------

  private scopeStorageKey() {
    return 'china-admin-mode-scope:self';
  }

  private orderModeStorageKey() {
    return 'china-admin-mode-order:self';
  }

  private loadOrderMode(): SelfOrderMode {
    try {
      const raw = localStorage.getItem(this.orderModeStorageKey());
      return raw === 'random' || raw === 'wrong' ? raw : 'sequential';
    } catch {
      return 'sequential';
    }
  }

  private persistOrderMode() {
    try {
      localStorage.setItem(this.orderModeStorageKey(), this.orderMode);
    } catch {
      /* 忽略存储失败 */
    }
  }

  private ensureScopeProvince() {
    if (this.scopeLoaded) return;
    if (this.granularity === 'province') {
      // 省级全国是入口：会话级钻省不跨刷新/切换恢复，总是从省级全国开始
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
    // 仅市级粒度持久化单省记忆；省级全国下钻的单省是会话状态（返回全国后回省级全国）
    if (this.granularity === 'city') saveScopeProvince(this.scopeStorageKey(), scopeProvince);
  }

  /** 当前粒度+范围下的有效题目池（省级全国 → 34 个省级虚拟单位；否则地级单位）。 */
  private activePool(): Unit[] {
    if (this.granularity === 'province' && this.scopeProvince === null) return this.provincePool;
    return scopedUnits(this.ctx.data, this.scopeProvince);
  }

  /** 由 adcode 反查当前池中的单位（省级全国池或地级池）。 */
  private currentUnitOf(adcode: string | null): Unit | null {
    if (!adcode) return null;
    if (this.isProvinceNation()) return this.provincePool.find((u) => u.adcode === adcode) ?? null;
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
      // 市级（全国或单省）：地级地图
      this.ctx.renderer.setProvinceMode(false, { inset: false });
      syncScopeView(this.scopeProvince, this.ctx.renderer.currentProvince(), this.ctx.renderer);
    } finally {
      this.syncingScope = false;
    }
  }

  private storageKey() {
    if (this.scopeProvince !== null) return `china-admin-mode-progress:self:${this.scopeProvince}`;
    return this.granularity === 'province'
      ? 'china-admin-mode-progress:self:province-nation'
      : 'china-admin-mode-progress:self:nation';
  }

  private restore() {
    this.resetProgressState();
    const saved = loadProgress(this.storageKey(), this.order, true);
    this.green = saved.green;
    this.red = saved.red;
    this.results = saved.results;
    this.question = saved.question;
    this.lastGreen = typeof saved.record.lastGreen === 'string' && this.green.has(saved.record.lastGreen) ? saved.record.lastGreen : null;
    this.activeProvince = typeof saved.record.activeProvince === 'string' ? saved.record.activeProvince : this.scopeProvince;
    this.ok = this.green.size;
    this.fail = this.red.size;
    this.wrongOrder.toastShown = saved.record.wrongToastShown === true;
  }

  private persist() {
    saveProgress(this.storageKey(), {
      green: this.green,
      red: this.red,
      results: this.results,
      question: this.question,
    }, { lastGreen: this.lastGreen, activeProvince: this.activeProvince, wrongToastShown: this.wrongOrder.toastShown });
    this.ctx.updateProgress();
  }

  private clearSaved() {
    clearProgress(this.storageKey());
  }

  private resetProgressState() {
    this.green.clear();
    this.red.clear();
    this.question = null;
    this.lastGreen = null;
    this.activeProvince = this.scopeProvince;
    this.ok = 0;
    this.fail = 0;
    this.results = [];
    this.rollbackCounted.clear();
    this.wrongOrder = initWrongOrderState(this.activePool(), this.scoreOf);
  }

  private showStartHint() {
    const scope = this.scopeLabel();
    const actions = `<button id="self-start" class="start-action">${t('common.start')}</button>`;
    this.ctx.setHint(`<div class="start-panel"><div class="start-title">${t('self.startTitle')}</div><div class="start-subtitle">${t('common.scopePrefix', { scope })}</div>${actions}</div>`);
    window.setTimeout(() => {
      const start = document.getElementById('self-start') as HTMLButtonElement | null;
      if (start) start.onclick = () => this.start(false);
    }, 0);
  }

  private start(_continueSaved: boolean) {
    if (this.started || this.paused) return;
    this.ensureScopeProvince();
    this.syncScopeView();
    this.activeProvince = this.scopeProvince;
    this.order = this.activePool().map((u) => u.adcode);
    if (_continueSaved) {
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
    if (!this.activeProvince) this.activeProvince = first.provinceAdcode;
    this.stopwatch.start((elapsedMs) => this.ctx.showStopwatch(elapsedMs));
    this.ctx.updateProgress();
    this.ctx.setHint('');
    this.ask(first);
  }

  private ask(u: Unit) {
    this.question = u.adcode;
    this.refresh();
    // 省级全国：保持全国视野，不自动聚焦到某省（市级才跟随聚焦）
    if (this.autoFollow && !this.isProvinceNation()) this.ctx.renderer.focusUnit(u.adcode, SELF_FOLLOW_ZOOM);
    this.ctx.search.clear();
    this.ctx.search.focus();
    this.persist();
    this.ctx.showTimer(null);
  }

  private answer(correct: boolean, timedOut = false, scored = true) {
    this.ctx.showTimer(null);
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
        this.fail++;
        this.results.push('red');
      }
      this.question = null;
      this.ctx.toast(timedOut ? t('self.timeoutAnswer', { name }) : t('self.correctAnswer', { name }));
      this.persist();
      // 先显示红色标记，短暂停留后撤回，恢复当前题（蓝色）重新作答
      this.refresh();
      this.rollbacking = true;
      if (this.rollbackTimer !== null) window.clearTimeout(this.rollbackTimer);
      this.rollbackTimer = window.setTimeout(() => {
        this.rollbackTimer = null;
        this.rollbacking = false;
        this.red.delete(q);
        this.question = q;
        this.refresh();
        this.ctx.search.clear();
        this.ctx.search.focus();
      }, 700);
      return;
    }

    this.question = null;
    if (scored) this.recordPractice(q, correct);
    if (correct) {
      this.green.add(q);
      // 错误回滚后的最终答对：地图变绿，但不计入 ok/进度（进度保留第一次红格），也不重复记熟练度
      if (!this.rollbackCounted.has(q)) {
        this.ok++;
        this.results.push('green');
      }
      this.lastGreen = q;
      this.ctx.renderer.flash(q);
    } else {
      this.red.add(q);
      this.fail++;
      this.results.push('red');
      this.ctx.toast(timedOut ? t('self.timeoutAnswer', { name }) : t('self.correctAnswer', { name }));
    }
    this.persist();
    const remain = this.unvisited();
    if (!remain.length) {
      this.refresh();
      this.finish();
      return;
    }
    this.ask(this.nextUnit(remain));
  }

  /** 熟练度记录：省级全国 → 省级熟练度；市级 → 地级熟练度（完全隔离）。 */
  private recordPractice(adcode: string, correct: boolean) {
    if (this.isProvinceNation()) this.ctx.store.recordProvinceAnswer(adcode, correct);
    else this.ctx.store.recordAnswer(adcode, correct);
  }

  private unvisited(): Unit[] {
    const pool = this.activePool();
    return pool.filter((u) => !this.green.has(u.adcode) && !this.red.has(u.adcode));
  }

  /** 首题选择：错题模式按分数最低，其余随机。 */
  private chooseFirst(pool: Unit[]): Unit {
    if (this.orderMode === 'wrong') return pickWrongNext(pool, this.scoreOf, this.wrongOrder, this.ctx.toast);
    return this.ctx.randomUnit(pool);
  }

  /** 后续选题：按当前出题顺序分发。 */
  private nextUnit(pool: Unit[]): Unit {
    if (this.orderMode === 'random') return this.ctx.randomUnit(pool);
    if (this.orderMode === 'wrong') return pickWrongNext(pool, this.scoreOf, this.wrongOrder, this.ctx.toast);
    return this.pickNext(pool);
  }

  private scoreOf = (u: Unit) =>
    this.isProvinceNation() ? this.ctx.store.getProvincePractice(u.adcode).score : this.ctx.store.getPractice(u.adcode).score;

  /** 顺序 BFS：省级全国按省邻接扩张；市级按省内优先 BFS（现状）。 */
  private pickNext(pool: Unit[]): Unit {
    // 省级全国：从上一个绿省沿省邻接随机挑未测省；耗尽则回退最近未测省
    if (this.isProvinceNation()) {
      const last = this.lastGreen ? this.provincePool.find((u) => u.adcode === this.lastGreen) ?? null : null;
      if (last) {
        const neighborCandidates = last.neighbors
          .map((a) => this.provincePool.find((u) => u.adcode === a))
          .filter((u): u is Unit => !!u && !this.green.has(u.adcode) && !this.red.has(u.adcode));
        if (neighborCandidates.length) return this.ctx.randomUnit(neighborCandidates);
      }
      return this.closestUnvisited(pool, last?.center ?? [104.5, 35]);
    }
    const last = this.lastGreen ? this.ctx.byAdcode.get(this.lastGreen) ?? null : null;
    if (!this.activeProvince || (!this.scopeProvince && !this.hasUnvisitedInProvince(this.activeProvince))) {
      this.activeProvince = this.pickNextProvince(last);
    }
    const province = this.activeProvince;
    const inProvince = this.unvisited().filter((u) => u.provinceAdcode === province);
    if (!inProvince.length) return this.unvisited()[0];
    if (last) {
      const neighbors = last.neighbors
        .map((a) => this.ctx.byAdcode.get(a))
        .filter((u): u is Unit => !!u && u.provinceAdcode === province && !this.green.has(u.adcode) && !this.red.has(u.adcode));
      if (neighbors.length) return this.ctx.randomUnit(neighbors);
    }
    const ref = last?.provinceAdcode === province ? last.center : this.ctx.data.provinces.find((p) => p.adcode === province)?.center ?? [104.5, 35];
    inProvince.sort((a, b) => dist2(a.center, ref) - dist2(b.center, ref));
    return inProvince[0];
  }

  private closestUnvisited(pool: Unit[], ref: [number, number]): Unit {
    const sorted = [...pool].sort((a, b) => dist2(a.center, ref) - dist2(b.center, ref));
    return sorted[0];
  }

  private hasUnvisitedInProvince(provinceAdcode: string) {
    return this.ctx.data.units.some((u) => u.provinceAdcode === provinceAdcode && !this.green.has(u.adcode) && !this.red.has(u.adcode));
  }

  private pickNextProvince(last: Unit | null): string {
    const provinces = this.ctx.data.provinces
      .filter((p) => this.hasUnvisitedInProvince(p.adcode))
      .sort((a, b) => dist2(a.center, last?.center ?? [104.5, 35]) - dist2(b.center, last?.center ?? [104.5, 35]));
    return provinces[0]?.adcode ?? this.unvisited()[0]?.provinceAdcode ?? '';
  }

  private finish() {
    const elapsedMs = this.stopwatch.elapsedMs();
    this.stopwatch.stop();
    this.ctx.showTimer(null);
    this.ctx.showStopwatch(null);
    this.started = false;
    this.paused = false;
    this.ctx.updateProgress();
    const result: RoundResult = {
      mode: 'self',
      scopeProvince: this.scopeProvince === null && this.granularity === 'province' ? PROVINCE_NATION_SCOPE : this.scopeProvince,
      scopeLabel: this.scopeLabel(),
      totalUnits: this.order.length,
      correct: this.ok,
      wrong: this.fail,
      elapsedMs,
      finishedAt: Date.now(),
    };
    this.ctx.showSummary(
      `${t('self.complete')}<div class="sum-stats">${this.isProvinceNation() ? t('self.summaryProvince', { ok: this.ok, fail: this.fail, time: formatElapsedSeconds(elapsedMs), total: this.ok + this.fail }) : t('self.summary', { ok: this.ok, fail: this.fail, time: formatElapsedSeconds(elapsedMs), total: this.ok + this.fail })}</div>`,
      () => {
        this.clearSaved();
        this.enter();
      },
      result,
    );
  }

  getScopeProvince() {
    // 排行榜/结算的省级全国范围用哨兵；市级沿用 scopeProvince
    if (this.scopeProvince === null && this.granularity === 'province') return PROVINCE_NATION_SCOPE;
    return this.scopeProvince;
  }

  /** 快照当前会话结果（全国排行榜结算卡片用）。 */
  collectResult(): RoundResult | null {
    if (!this.started && !this.question && this.green.size === 0 && this.red.size === 0) return null;
    return {
      mode: 'self',
      scopeProvince: this.scopeProvince === null && this.granularity === 'province' ? PROVINCE_NATION_SCOPE : this.scopeProvince,
      scopeLabel: this.scopeLabel(),
      totalUnits: this.order.length,
      correct: this.ok,
      wrong: this.fail,
      elapsedMs: this.stopwatch.elapsedMs(),
      finishedAt: Date.now(),
    };
  }

  private scopeLabel() {
    if (this.scopeProvince === null && this.granularity === 'province') return t('common.provinceNation');
    if (this.scopeProvince) return this.ctx.data.provinces.find((p) => p.adcode === this.scopeProvince)?.name ?? t('common.currentProvince');
    return t('common.nation');
  }
}

function dist2(a: [number, number], b: [number, number]): number {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
}
