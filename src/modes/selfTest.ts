import type { Mode, RoundResult, Unit } from '../types';
import type { ModeCtx, ModeController, ProgressSegment } from './types';
import { Stopwatch } from '../ui/stopwatch';
import { clearProgress, loadProgress, loadScopeProvince, progressOf, saveProgress, saveScopeProvince, scopedUnits, syncScopeView, unvisitedUnits } from './progress';
import { formatElapsedSeconds } from '../ui/format';

type SelfOrderMode = 'sequential' | 'random';

/**
 * 自测模式（BFS 扩张）：
 * 随机起点作为当前题目（蓝色）→ 输入名称；答对变绿，下一个题目 = 与上一个绿点相邻的单位（优先同省）；
 * 无相邻候选时回退最近的未测单位（岛屿等）；答错保持红色（错误标记）并继续扩张。
 */
export class SelfTestMode implements ModeController {
  id: Mode = 'self';
  title = '自测模式';
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

  constructor(private ctx: ModeCtx) {}

  enter() {
    if (this.paused) {
      this.syncScopeView();
      this.ctx.search.setPlaceholder('输入地名');
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
    this.ctx.search.setPlaceholder('地名');
    this.showStartHint();
    this.refresh();
    this.ctx.updateProgress();
    this.ctx.search.clear();
  }

  exit() {
    this.stopwatch.stop();
    this.started = false;
    this.paused = false;
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
    if (!this.ctx.settings.selfTimerEnabled) this.ctx.showTimer(null);
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
    if (this.paused || !this.question || !v.trim()) return;
    const best = this.ctx.matcher.bestUnit(v);
    this.answer(!!best && best.adcode === this.question);
  }

  onInput(v: string) {
    if (this.paused || !this.question || !v.trim()) return;
    const best = this.ctx.matcher.bestUnit(v);
    if (best?.adcode === this.question) this.answer(true);
  }

  onUnitClick() {
    if (this.started) {
      this.ctx.toast('测试期间无法下钻省份');
      return true;
    }
    /* 测试模式以输入为准 */
  }

  onUnitDblClick(adcode: string) {
    if (this.started) {
      this.ctx.toast('测试期间无法下钻省份');
      return;
    }
    const u = this.ctx.byAdcode.get(adcode);
    if (u) this.ctx.renderer.drillToProvince(u.provinceAdcode);
  }

  onSkip() {
    if (!this.started || !this.question) return;
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
      return raw === 'random' ? 'random' : 'sequential';
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
  }

  private persist() {
    saveProgress(this.storageKey(), {
      green: this.green,
      red: this.red,
      results: this.results,
      question: this.question,
    }, { lastGreen: this.lastGreen, activeProvince: this.activeProvince });
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
  }

  private showStartHint() {
    const scope = this.scopeProvince ? this.ctx.data.provinces.find((p) => p.adcode === this.scopeProvince)?.name ?? '当前省份' : '全国';
    const actions = '<button id="self-start" class="start-action">开始</button>';
    this.ctx.setHint(`<div class="start-panel"><div class="start-title">输入模式</div><div class="start-subtitle">范围：${scope}</div>${actions}</div>`);
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
    const first = resumed ?? (pool.length ? this.ctx.randomUnit(pool) : null);
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
    if (this.ctx.settings.autoFollow) this.ctx.renderer.focusUnit(u.adcode, this.ctx.settings.followZoom);
    this.ctx.search.clear();
    this.ctx.search.focus();
    this.persist();
    this.ctx.showTimer(null);
  }

  private answer(correct: boolean, timedOut = false, scored = true) {
    this.ctx.showTimer(null);
    const q = this.question;
    if (!q) return;
    this.question = null;
    if (scored) this.ctx.store.recordAnswer(q, correct);
    if (correct) {
      this.green.add(q);
      this.ok++;
      this.lastGreen = q;
      this.results.push('green');
      this.ctx.renderer.flash(q);
    } else {
      this.red.add(q);
      this.fail++;
      this.results.push('red');
      const name = this.ctx.byAdcode.get(q)?.name ?? q;
      this.ctx.toast(timedOut ? `超时，正确答案：${name}` : `正确答案：${name}`);
    }
    this.persist();
    const remain = unvisitedUnits(this.ctx.data, this.scopeProvince, this.green, this.red);
    if (!remain.length) {
      this.refresh();
      this.finish();
      return;
    }
    this.ask(this.orderMode === 'random' ? this.ctx.randomUnit(remain) : this.pickNext());
  }

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
      `自测完成<div class="sum-stats">正确 <b>${this.ok}</b> ｜ 错误 <b>${this.fail}</b> ｜ 用时 ${formatElapsedSeconds(elapsedMs)} ｜ 覆盖 ${this.ok + this.fail} 个地图单位</div>`,
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

  private scopeLabel() {
    return this.scopeProvince ? this.ctx.data.provinces.find((p) => p.adcode === this.scopeProvince)?.name ?? '当前省份' : '全国';
  }
}

function dist2(a: [number, number], b: [number, number]): number {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
}
