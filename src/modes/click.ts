import type { Mode, RoundResult, Unit } from '../types';
import { Stopwatch } from '../ui/stopwatch';
import type { ModeCtx, ModeController, ProgressSegment } from './types';
import { clearProgress, loadProgress, loadScopeProvince, progressOf, saveProgress, saveScopeProvince, scopedUnits, syncScopeView, unvisitedUnits } from './progress';
import { formatElapsedSeconds } from '../ui/format';

/** 点击模式：根据顶部题目提示，在地图上点击对应的地图单位。 */
export class ClickMode implements ModeController {
  id: Mode = 'click';
  title = '点击模式';
  private green = new Set<string>();
  private red = new Set<string>();
  private question: string | null = null;
  private scopeProvince: string | null = null;
  private started = false;
  private order: string[] = [];
  private results: ProgressSegment[] = [];
  private ok = 0;
  private fail = 0;
  private stopwatch = new Stopwatch();
  private paused = false;
  private scopeLoaded = false;
  private syncingScope = false;

  constructor(private ctx: ModeCtx) {}

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
    this.order = scopedUnits(this.ctx.data, this.scopeProvince).map((u) => u.adcode);
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
    const unit = this.question ? this.ctx.byAdcode.get(this.question) ?? null : null;
    if (unit) this.showQuestionHint(unit);
    this.stopwatch.resume();
    this.ctx.showStopwatch(this.stopwatch.elapsedMs());
  }

  isPaused() {
    return this.paused;
  }

  refresh() {
    this.ctx.renderer.render({
      colorOf: (adcode) => {
        if (this.green.has(adcode)) return 'green';
        if (this.red.has(adcode)) return 'red';
        return 'gray';
      },
      disableTooltip: true,
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
    if (this.paused) return true;
    if (!this.started || !this.question) return false;
    const clicked = this.ctx.byAdcode.get(adcode);
    if (!clicked || (this.scopeProvince !== null && clicked.provinceAdcode !== this.scopeProvince)) return true;
    this.answer(adcode === this.question);
    return true;
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
    this.clearSaved();
    this.enter();
  }

  onViewChange() {
    if (this.started || this.syncingScope) return;
    this.setScopeProvince(this.ctx.renderer.currentProvince());
    this.order = scopedUnits(this.ctx.data, this.scopeProvince).map((u) => u.adcode);
    this.restore();
    this.showStartHint();
    this.ctx.updateProgress();
  }

  private scopeStorageKey() {
    return 'china-admin-mode-scope:click';
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
    return `china-admin-mode-progress:click:${this.scopeProvince ?? 'nation'}`;
  }

  private restore() {
    this.green.clear();
    this.red.clear();
    this.question = null;
    this.results = [];
    this.ok = 0;
    this.fail = 0;
    const saved = loadProgress(this.storageKey(), this.order);
    this.green = saved.green;
    this.red = saved.red;
    this.results = saved.results;
    this.question = saved.question;
    this.ok = this.green.size;
    this.fail = this.red.size;
  }

  private persist() {
    saveProgress(this.storageKey(), {
      green: this.green,
      red: this.red,
      results: this.results,
      question: this.question,
    }, { scopeProvince: this.scopeProvince });
    this.ctx.updateProgress();
  }

  private clearSaved() {
    clearProgress(this.storageKey());
  }

  private showStartHint() {
    const scope = this.scopeProvince ? this.ctx.data.provinces.find((p) => p.adcode === this.scopeProvince)?.name ?? '当前省份' : '全国';
    const actions = '<button id="click-start" class="start-action">开始</button>';
    this.ctx.setHint(`<div class="start-panel"><div class="start-title">点击模式</div><div class="start-subtitle">范围：${scope}，请按提示点击地图</div>${actions}</div>`);
    window.setTimeout(() => {
      const start = document.getElementById('click-start') as HTMLButtonElement | null;
      if (start) start.onclick = () => this.start(false);
    }, 0);
  }

  private start(continueSaved: boolean) {
    if (this.started) return;
    this.ensureScopeProvince();
    this.syncScopeView();
    this.order = scopedUnits(this.ctx.data, this.scopeProvince).map((u) => u.adcode);
    if (continueSaved) this.restore();
    else {
      this.clearSaved();
      this.green.clear();
      this.red.clear();
      this.question = null;
      this.results = [];
      this.ok = 0;
      this.fail = 0;
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
    this.stopwatch.start((elapsedMs) => this.ctx.showStopwatch(elapsedMs));
    this.ask(first);
  }

  private ask(unit: Unit) {
    this.question = unit.adcode;
    this.showQuestionHint(unit);
    this.refresh();
    this.persist();
  }

  private showQuestionHint(unit: Unit) {
    this.ctx.setHint(`<div class="start-panel click-question"><div class="start-title">${unit.name}</div></div>`);
  }

  private answer(correct: boolean, scored = true) {
    const q = this.question;
    if (!q) return;
    this.question = null;
    if (scored) this.ctx.store.recordAnswer(q, correct);
    if (correct) {
      this.green.add(q);
      this.ok += 1;
      this.ctx.toast('回答正确');
      this.results.push('green');
      this.ctx.renderer.flash(q);
    } else {
      this.red.add(q);
      this.fail += 1;
      this.results.push('red');
      const name = this.ctx.byAdcode.get(q)?.name ?? q;
      this.ctx.toast(`正确答案：${name}`);
    }
    this.persist();
    const pool = unvisitedUnits(this.ctx.data, this.scopeProvince, this.green, this.red);
    if (!pool.length) {
      this.refresh();
      this.finish();
      return;
    }
    this.ask(this.ctx.randomUnit(pool));
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
      scopeProvince: this.scopeProvince,
      scopeLabel: this.scopeLabel(),
      totalUnits: this.order.length,
      correct: this.ok,
      wrong: this.fail,
      elapsedMs,
      finishedAt: Date.now(),
    };
    this.ctx.showSummary(
      `点击模式完成<div class="sum-stats">正确 <b>${this.ok}</b> ｜ 错误 <b>${this.fail}</b> ｜ 用时 ${formatElapsedSeconds(elapsedMs)} ｜ 覆盖 ${this.ok + this.fail} 个地图单位</div>`,
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
