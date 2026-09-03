import type { Mode, RoundResult, Unit } from '../types';
import { Stopwatch } from '../ui/stopwatch';
import type { ClickOrderMode, ModeCtx, ModeController, ProgressSegment } from './types';
import { clearProgress, loadProgress, loadScopeProvince, progressOf, saveProgress, saveScopeProvince, scopedUnits, syncScopeView } from './progress';
import { formatElapsedSeconds } from '../ui/format';
import { initWrongOrderState, pickWrongNext, type WrongOrderState } from './wrongOrder';
import { t } from '../i18n';
import { loadClickErrorRollback, saveClickErrorRollback, type ModeSettingsPanel } from '../modeSettings';
import {
  buildProvinceAdjacency,
  provinceByAdcode,
  provinceShortName,
  provinceUnits,
  PROVINCE_NATION_SCOPE,
  type Granularity,
} from '../province';

/**
 * 点击模式：根据顶部题目提示，在地图上点击对应的地图单位。
 * - 市级粒度（默认不再默认）：全国地级市 / 单省地级市练习（原版）。
 * - 省级粒度：全国 34 个省级单元的练习（地图为省级视图，不含地级边界/标签），
 *   与每日竞速的地图渲染一致；省级答题只计入省级熟练度（与地级熟练度隔离）。
 * - 粒度选择：仅全国视图（scopeProvince=null）可切换；测试开始后锁定隐藏。
 */
export class ClickMode implements ModeController {
  id: Mode = 'click';
  title = t('mode.click.title');
  private green = new Set<string>();
  private red = new Set<string>();
  private question: string | null = null;
  /** 市级单省作用域：null=全国（可能是省级全国或市级全国），省 adcode=该省地级练习（下钻而来）。 */
  private scopeProvince: string | null = null;
  /** 全国层粒度：'province'（省级全国，默认）| 'city'（市级全国）。下钻单省不改变它（返回全国后回到原全国粒度）。 */
  private granularity: Granularity = this.loadGranularity();
  private started = false;
  private order: string[] = [];
  private results: ProgressSegment[] = [];
  private ok = 0;
  private fail = 0;
  private stopwatch = new Stopwatch();
  private paused = false;
  private scopeLoaded = false;
  private syncingScope = false;
  private orderMode: ClickOrderMode = this.loadOrderMode();
  private wrongOrder: WrongOrderState = initWrongOrderState([], () => 0);
  private errorRollback = loadClickErrorRollback(); // 错误回滚：答错撤回重答
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
      title: t('mode.click.title'),
      toggles: [{ key: 'error-rollback', label: t('settings.errorRollback'), value: this.errorRollback }],
      onChange: (key, value) => {
        if (key === 'error-rollback') {
          this.errorRollback = value;
          saveClickErrorRollback(value);
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
    return 'china-admin-mode-granularity:click';
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
      this.ctx.setHint('');
      this.refresh();
      this.ctx.showStopwatch(this.stopwatch.elapsedMs());
      this.ctx.updateProgress();
      return;
    }
    this.exit();
    this.ensureScopeProvince();
    this.order = this.activePool().map((u) => u.adcode);
    this.restore();
    this.syncScopeView();
    this.showStartHint();
    this.refresh();
    this.ctx.updateProgress();
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
    this.ctx.showStopwatch(this.stopwatch.elapsedMs());
  }

  resume() {
    if (!this.started || !this.paused) return;
    this.paused = false;
    const unit = this.currentUnitOf(this.question);
    if (unit) this.showQuestionHint(unit);
    this.stopwatch.resume();
    this.ctx.showStopwatch(this.stopwatch.elapsedMs());
  }

  isPaused() {
    return this.paused;
  }

  refresh() {
    const provinceNation = this.isProvinceNation();
    this.ctx.renderer.render({
      colorOf: (adcode) => {
        if (this.green.has(adcode)) return 'green';
        if (this.red.has(adcode)) return 'red';
        return 'gray';
      },
      disableTooltip: true,
      // 省级全国：已作答省显示绿/红省名简称标签（与每日竞速一致）
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

  getProgress() {
    return progressOf(this.order.length, this.results);
  }

  hasProgress() {
    return this.green.size > 0 || this.red.size > 0 || !!this.question;
  }

  isStarted() {
    return this.started;
  }

  onSubmit() {}

  onInput() {}

  onUnitClick(adcode: string) {
    if (this.paused || this.rollbacking) return true;
    // 省级全国：未开始时单击某省 → 下钻该省（变成该省地级市级练习；返回全国后回省级全国）
    if (this.isProvinceNation() && !this.started) {
      this.drillFromProvinceNation(adcode);
      return true;
    }
    if (!this.started || !this.question) return false;
    // 省级单省视图点击（scope 省，地级单位）与市级全国：按地图单位命中判断
    const clicked = this.ctx.byAdcode.get(adcode);
    if (clicked && this.scopeProvince !== null && clicked.provinceAdcode !== this.scopeProvince) return true;
    this.answer(adcode === this.question);
    return true;
  }

  onUnitDblClick(adcode: string) {
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

  onEnd() {
    this.pause();
  }

  onReset() {
    this.stopwatch.stop();
    this.ctx.showStopwatch(null);
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
    // 市级全国点某市（renderer 自动下钻）→ scope 变为该省；省级全国点省由 onUnitClick 处理
    this.setScopeProvince(this.ctx.renderer.currentProvince());
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
    this.order = this.activePool().map((u) => u.adcode);
    this.restore();
    this.syncScopeView();
    this.showStartHint();
    this.refresh();
    this.ctx.updateProgress();
  }

  // ---------- 内部 ----------

  private scopeStorageKey() {
    return 'china-admin-mode-scope:click';
  }

  setOrderMode(mode: ClickOrderMode) {
    this.orderMode = mode;
    this.persistOrderMode();
  }

  getOrderMode(): ClickOrderMode {
    return this.orderMode;
  }

  private orderModeStorageKey() {
    return 'china-admin-mode-order:click';
  }

  private loadOrderMode(): ClickOrderMode {
    try {
      const raw = localStorage.getItem(this.orderModeStorageKey());
      return raw === 'wrong' ? 'wrong' : 'random';
    } catch {
      return 'random';
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

  /** 省级全国未开始点省：下钻该省并进入其地级市级练习（粒度保持省级，返回全国后恢复省级全国）。 */
  private drillFromProvinceNation(provinceAdcode: string) {
    const p = provinceByAdcode(this.ctx.data, provinceAdcode);
    if (!p) return;
    this.scopeProvince = provinceAdcode;
    this.scopeLoaded = true;
    // 省级全国下钻是临时浏览，不覆盖市级全国记忆的 scope；但允许刷新后恢复本省市级会话
    this.order = scopedUnits(this.ctx.data, this.scopeProvince).map((u) => u.adcode);
    this.restore();
    this.syncScopeView(); // setProvinceMode(false) + drill
    this.showStartHint();
    this.refresh();
    this.ctx.updateProgress();
  }

  private storageKey() {
    if (this.scopeProvince !== null) return `china-admin-mode-progress:click:${this.scopeProvince}`;
    return this.granularity === 'province'
      ? 'china-admin-mode-progress:click:province-nation'
      : 'china-admin-mode-progress:click:nation';
  }

  private restore() {
    this.green.clear();
    this.red.clear();
    this.question = null;
    this.results = [];
    this.ok = 0;
    this.fail = 0;
    this.rollbackCounted.clear();
    this.wrongOrder = initWrongOrderState(this.activePool(), this.scoreOf);
    const saved = loadProgress(this.storageKey(), this.order);
    this.green = saved.green;
    this.red = saved.red;
    this.results = saved.results;
    this.question = saved.question;
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
    }, { wrongToastShown: this.wrongOrder.toastShown });
    this.ctx.updateProgress();
  }

  private clearSaved() {
    clearProgress(this.storageKey());
  }

  private showStartHint() {
    const scope = this.scopeLabel();
    const actions = `<button id="click-start" class="start-action">${t('common.start')}</button>`;
    this.ctx.setHint(`<div class="start-panel"><div class="start-title">${t('click.startTitle')}</div><div class="start-subtitle">${t('click.startSubtitle', { scope })}</div>${actions}</div>`);
    window.setTimeout(() => {
      const start = document.getElementById('click-start') as HTMLButtonElement | null;
      if (start) start.onclick = () => this.start(false);
    }, 0);
  }

  private start(continueSaved: boolean) {
    if (this.started) return;
    this.ensureScopeProvince();
    this.syncScopeView();
    this.order = this.activePool().map((u) => u.adcode);
    if (continueSaved) this.restore();
    else {
      this.clearSaved();
      this.green.clear();
      this.red.clear();
      this.question = null;
      this.results = [];
      this.ok = 0;
      this.fail = 0;
      this.wrongOrder = initWrongOrderState(this.activePool(), this.scoreOf);
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
    this.stopwatch.start((elapsedMs) => this.ctx.showStopwatch(elapsedMs));
    this.ask(first);
  }

  private unvisited(): Unit[] {
    const pool = this.activePool();
    return pool.filter((u) => !this.green.has(u.adcode) && !this.red.has(u.adcode));
  }

  private ask(unit: Unit) {
    this.question = unit.adcode;
    this.showQuestionHint(unit);
    this.refresh();
    this.persist();
  }

  private showQuestionHint(unit: Unit) {
    // 省级全国测验：顶部显示省全名（点击模式不在地图上高亮目标）
    this.ctx.setHint(`<div class="start-panel click-question"><div class="start-title">${unit.name}</div></div>`);
  }

  private answer(correct: boolean, scored = true) {
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
      this.ctx.toast(t('click.correctAnswer', { name }));
      this.persist();
      // 先显示红色标记，短暂停留后撤回，恢复当前题（灰色）重新作答
      this.refresh();
      this.rollbacking = true;
      if (this.rollbackTimer !== null) window.clearTimeout(this.rollbackTimer);
      this.rollbackTimer = window.setTimeout(() => {
        this.rollbackTimer = null;
        this.rollbacking = false;
        this.red.delete(q);
        this.question = q;
        this.refresh();
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
      this.ctx.toast(t('click.correctToast'));
      this.ctx.renderer.flash(q);
    } else {
      this.red.add(q);
      this.fail += 1;
      this.results.push('red');
      this.ctx.toast(t('click.correctAnswer', { name }));
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

  /** 熟练度记录：省级全国 → 省级熟练度；市级 → 地级熟练度（完全隔离）。 */
  private recordPractice(adcode: string, correct: boolean) {
    if (this.isProvinceNation()) this.ctx.store.recordProvinceAnswer(adcode, correct);
    else this.ctx.store.recordAnswer(adcode, correct);
  }

  private finish() {
    const elapsedMs = this.stopwatch.elapsedMs();
    this.stopwatch.stop();
    this.started = false;
    this.paused = false;
    this.ctx.showTimer(null);
    this.ctx.showStopwatch(null);
    this.ctx.updateProgress();
    const result: RoundResult = {
      mode: 'click',
      scopeProvince: this.scopeProvince === null && this.granularity === 'province' ? PROVINCE_NATION_SCOPE : this.scopeProvince,
      scopeLabel: this.scopeLabel(),
      totalUnits: this.order.length,
      correct: this.ok,
      wrong: this.fail,
      elapsedMs,
      finishedAt: Date.now(),
    };
    this.ctx.showSummary(
      `${t('click.complete')}<div class="sum-stats">${this.isProvinceNation() ? t('click.summaryProvince', { ok: this.ok, fail: this.fail, time: formatElapsedSeconds(elapsedMs), total: this.ok + this.fail }) : t('click.summary', { ok: this.ok, fail: this.fail, time: formatElapsedSeconds(elapsedMs), total: this.ok + this.fail })}</div>`,
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

  /** 首题选择：错题模式按分数最低，其余随机。 */
  private chooseFirst(pool: Unit[]): Unit {
    if (this.orderMode === 'wrong') return pickWrongNext(pool, this.scoreOf, this.wrongOrder, this.ctx.toast);
    return this.ctx.randomUnit(pool);
  }

  /** 后续选题：按当前出题顺序分发。 */
  private nextUnit(pool: Unit[]): Unit {
    if (this.orderMode === 'wrong') return pickWrongNext(pool, this.scoreOf, this.wrongOrder, this.ctx.toast);
    return this.ctx.randomUnit(pool);
  }

  private scoreOf = (u: Unit) =>
    this.isProvinceNation() ? this.ctx.store.getProvincePractice(u.adcode).score : this.ctx.store.getPractice(u.adcode).score;

  /** 快照当前会话结果（全国排行榜结算卡片用）。 */
  collectResult(): RoundResult | null {
    if (!this.started && !this.question && this.green.size === 0 && this.red.size === 0) return null;
    return {
      mode: 'click',
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
