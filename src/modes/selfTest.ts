import type { Mode, RoundResult, Unit } from '../types';
import type { ModeCtx, ModeController, OrderMode, ProgressSegment } from './types';
import { Stopwatch } from '../ui/stopwatch';
import { clearProgress, loadProgress, loadScopeProvince, progressOf, saveProgress, saveScopeProvince, scopedUnits, syncScopeView, unvisitedUnits } from './progress';
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

type SelfOrderMode = OrderMode;

/**
 * 自测模式（BFS 扩张）：
 * 随机起点作为当前题目（蓝色）→ 输入名称；答对变绿，下一个题目 = 与上一个绿点相邻的单位（优先同省）；
 * 无相邻候选时回退最近的未测单位（岛屿等）；答错保持红色（错误标记）并继续扩张。
 */
export class SelfTestMode implements ModeController {
  id: Mode = 'self';
  title = t('mode.self.title');
  private green = new Set<string>();
  private red = new Set<string>();
  private question: string | null = null;
  private lastGreen: string | null = null;
  private activeProvince: string | null = null;
  private scopeProvince: string | null = null;
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

  constructor(private ctx: ModeCtx) {}

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

  enter() {
    if (this.paused) {
      this.syncScopeView();
      this.ctx.search.setPlaceholder(t('self.placeholderFull'));
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
    this.order = scopedUnits(this.ctx.data, this.scopeProvince).map((u) => u.adcode);
    this.restore();
    this.syncScopeView();
    this.ctx.search.setPlaceholder(t('self.placeholder'));
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
    this.ctx.renderer.render({
      colorOf: (adcode) => {
        if (this.green.has(adcode)) return 'green';
        if (this.question === adcode) return 'blue';
        if (this.red.has(adcode)) return 'red';
        return 'gray';
      },
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
    const best = this.ctx.matcher.bestUnit(v);
    this.answer(!!best && best.adcode === this.question);
  }

  onInput(v: string) {
    if (this.paused || this.rollbacking || !this.question || !v.trim()) return;
    const best = this.ctx.matcher.bestUnit(v);
    if (best?.adcode === this.question) this.answer(true);
  }

  onUnitClick() {
    if (this.started) {
      this.ctx.toast(t('common.underTestNoDrill'));
      return true;
    }
    /* 测试模式以输入为准 */
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
    this.answer(false, false, false);
  }

  onEnd() {
    this.pause();
  }

  onReset() {
    this.stopwatch.stop();
    this.started = false;
    this.paused = false;
    this.clearSaved();
    this.enter();
  }

  onViewChange() {
    if (this.started || this.syncingScope) return;
    this.setScopeProvince(this.ctx.renderer.currentProvince());
    this.activeProvince = this.scopeProvince;
    this.order = scopedUnits(this.ctx.data, this.scopeProvince).map((u) => u.adcode);
    this.restore();
    this.showStartHint();
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
    const saved = loadScopeProvince(this.ctx.data, this.scopeStorageKey());
    this.scopeProvince = saved === undefined ? this.ctx.renderer.currentProvince() : saved;
    this.scopeLoaded = true;
    saveScopeProvince(this.scopeStorageKey(), this.scopeProvince);
  }

  private setScopeProvince(scopeProvince: string | null) {
    this.scopeProvince = scopeProvince;
    this.scopeLoaded = true;
    saveScopeProvince(this.scopeStorageKey(), scopeProvince);
  }

  private syncScopeView() {
    this.ensureScopeProvince();
    this.syncingScope = true;
    try {
      syncScopeView(this.scopeProvince, this.ctx.renderer.currentProvince(), this.ctx.renderer);
    } finally {
      this.syncingScope = false;
    }
  }

  private storageKey() {
    return `china-admin-mode-progress:self:${this.scopeProvince ?? 'nation'}`;
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
    this.wrongOrder = initWrongOrderState(scopedUnits(this.ctx.data, this.scopeProvince), this.scoreOf);
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
    this.order = scopedUnits(this.ctx.data, this.scopeProvince).map((u) => u.adcode);
    if (_continueSaved) {
      this.restore();
    } else {
      this.clearSaved();
      this.resetProgressState();
    }

    const resumed = this.question ? this.ctx.byAdcode.get(this.question) ?? null : null;
    const pool = unvisitedUnits(this.ctx.data, this.scopeProvince, this.green, this.red);
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
    if (this.autoFollow) this.ctx.renderer.focusUnit(u.adcode, SELF_FOLLOW_ZOOM);
    this.ctx.search.clear();
    this.ctx.search.focus();
    this.persist();
    this.ctx.showTimer(null);
  }

  private answer(correct: boolean, timedOut = false, scored = true) {
    this.ctx.showTimer(null);
    const q = this.question;
    if (!q) return;

    // 错误回滚：第一次答错计入 fail/熟练度/进度红格，随后短暂显示红色并撤回，重答同一题直到答对
    if (this.errorRollback && !correct) {
      const name = this.ctx.byAdcode.get(q)?.name ?? q;
      const firstWrong = !this.rollbackCounted.has(q);
      if (firstWrong) {
        this.rollbackCounted.add(q);
        this.ctx.store.recordAnswer(q, false);
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
    if (scored) this.ctx.store.recordAnswer(q, correct);
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
      const name = this.ctx.byAdcode.get(q)?.name ?? q;
      this.ctx.toast(timedOut ? t('self.timeoutAnswer', { name }) : t('self.correctAnswer', { name }));
    }
    this.persist();
    const remain = unvisitedUnits(this.ctx.data, this.scopeProvince, this.green, this.red);
    if (!remain.length) {
      this.refresh();
      this.finish();
      return;
    }
    this.ask(this.nextUnit(remain));
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
    return this.pickNext();
  }

  private scoreOf = (u: Unit) => this.ctx.store.getPractice(u.adcode).score;

  /** 省内优先 BFS：当前省未出完前不跨省；省内优先邻居，否则选同省最近未测点 */
  private pickNext(): Unit {
    const last = this.lastGreen ? this.ctx.byAdcode.get(this.lastGreen) ?? null : null;
    if (!this.activeProvince || (!this.scopeProvince && !this.hasUnvisitedInProvince(this.activeProvince))) {
      this.activeProvince = this.pickNextProvince(last);
    }
    const province = this.activeProvince;
    const inProvince = unvisitedUnits(this.ctx.data, this.scopeProvince, this.green, this.red).filter((u) => u.provinceAdcode === province);
    if (!inProvince.length) return unvisitedUnits(this.ctx.data, this.scopeProvince, this.green, this.red)[0];
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

  private hasUnvisitedInProvince(provinceAdcode: string) {
    return this.ctx.data.units.some((u) => u.provinceAdcode === provinceAdcode && !this.green.has(u.adcode) && !this.red.has(u.adcode));
  }

  private pickNextProvince(last: Unit | null): string {
    const provinces = this.ctx.data.provinces
      .filter((p) => this.hasUnvisitedInProvince(p.adcode))
      .sort((a, b) => dist2(a.center, last?.center ?? [104.5, 35]) - dist2(b.center, last?.center ?? [104.5, 35]));
    return provinces[0]?.adcode ?? unvisitedUnits(this.ctx.data, this.scopeProvince, this.green, this.red)[0]?.provinceAdcode ?? '';
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
      scopeProvince: this.scopeProvince,
      scopeLabel: this.scopeLabel(),
      totalUnits: this.order.length,
      correct: this.ok,
      wrong: this.fail,
      elapsedMs,
      finishedAt: Date.now(),
    };
    this.ctx.showSummary(
      `${t('self.complete')}<div class="sum-stats">${t('self.summary', { ok: this.ok, fail: this.fail, time: formatElapsedSeconds(elapsedMs), total: this.ok + this.fail })}</div>`,
      () => {
        this.clearSaved();
        this.enter();
      },
      result,
    );
  }

  getScopeProvince() {
    return this.scopeProvince;
  }

  /** 快照当前会话结果（全国排行榜结算卡片用）。 */
  collectResult(): RoundResult | null {
    if (!this.started && !this.question && this.green.size === 0 && this.red.size === 0) return null;
    return {
      mode: 'self',
      scopeProvince: this.scopeProvince,
      scopeLabel: this.scopeLabel(),
      totalUnits: this.order.length,
      correct: this.ok,
      wrong: this.fail,
      elapsedMs: this.stopwatch.elapsedMs(),
      finishedAt: Date.now(),
    };
  }

  private scopeLabel() {
    return this.scopeProvince ? this.ctx.data.provinces.find((p) => p.adcode === this.scopeProvince)?.name ?? t('common.currentProvince') : t('common.nation');
  }
}

function dist2(a: [number, number], b: [number, number]): number {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
}
