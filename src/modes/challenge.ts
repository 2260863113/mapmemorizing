import type { Mode, RoundResult, Unit } from '../types';
import type { ModeCtx, ModeController, ProgressSegment } from './types';
import { Countdown } from '../ui/countdown';
import { clearProgress, loadProgress, loadScopeProvince, progressOf, saveProgress, saveScopeProvince, scopedUnits, syncScopeView, unvisitedUnits } from './progress';
import { formatElapsedSeconds } from '../ui/format';

/**
 * 挑战模式：随机标蓝一个地图单位作为题目，输入正确变绿并立即随机出下一题；
 * 答错或超时变红（错误标记）并跳过。每题默认 10 秒（设置中可调）。
 */
export class ChallengeMode implements ModeController {
  id: Mode = 'challenge';
  title = '挑战模式';
  private green = new Set<string>();
  private red = new Set<string>();
  private question: string | null = null;
  private started = false;
  private scopeProvince: string | null = null;
  private ok = 0;
  private fail = 0;
  private order: string[] = [];
  private results: ProgressSegment[] = [];
  private startTime = 0;
  private nextTimer: number | null = null;
  private countdown = new Countdown();
  private paused = false;
  private scopeLoaded = false;
  private syncingScope = false;

  constructor(private ctx: ModeCtx) {}

  enter() {
    if (this.paused) {
      this.syncScopeView();
      this.ctx.search.setPlaceholder('地名');
      this.ctx.setHint('');
      this.refresh();
      if (this.question) this.showCountdown(this.countdown.remaining());
      else this.ctx.showTimer(null);
      this.ctx.updateProgress();
      this.ctx.search.clear();
      return;
    }
    this.exit();
    this.green.clear();
    this.red.clear();
    this.question = null;
    this.started = false;
    this.paused = false;
    this.ensureScopeProvince();
    this.ok = 0;
    this.fail = 0;
    this.startTime = 0;
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
    this.countdown.stop();
    if (this.nextTimer !== null) {
      window.clearTimeout(this.nextTimer);
      this.nextTimer = null;
    }
    this.ctx.showTimer(null);
    this.started = false;
    this.paused = false;
  }

  pause() {
    if (!this.started || this.paused) return;
    this.paused = true;
    this.countdown.pause();
    if (this.nextTimer !== null) {
      window.clearTimeout(this.nextTimer);
      this.nextTimer = null;
    }
    if (this.question) this.showCountdown(this.countdown.remaining());
    else this.ctx.showTimer(null);
  }

  resume() {
    if (!this.started || !this.paused) return;
    this.paused = false;
    if (this.question) {
      this.showCountdown(this.countdown.remaining());
      this.countdown.resume();
    } else {
      this.next();
    }
  }

  isPaused() {
    return this.paused;
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
    /* 以输入为准 */
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
    this.countdown.stop();
    if (this.nextTimer !== null) {
      window.clearTimeout(this.nextTimer);
      this.nextTimer = null;
    }
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

  // ---------- 内部 ----------

  private scopeStorageKey() {
    return 'china-admin-mode-scope:challenge';
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
    return `china-admin-mode-progress:challenge:${this.scopeProvince ?? 'nation'}`;
  }

  private restore() {
    this.resetProgressState();
    const saved = loadProgress(this.storageKey(), this.order, true);
    this.green = saved.green;
    this.red = saved.red;
    this.results = saved.results;
    this.question = saved.question;
    this.startTime = typeof saved.record.startTime === 'number' ? saved.record.startTime : 0;
    this.ok = this.green.size;
    this.fail = this.red.size;
  }

  private persist() {
    saveProgress(this.storageKey(), {
      green: this.green,
      red: this.red,
      results: this.results,
      question: this.question,
    }, { startTime: this.startTime });
    this.ctx.updateProgress();
  }

  private clearSaved() {
    clearProgress(this.storageKey());
  }

  private resetProgressState() {
    this.green.clear();
    this.red.clear();
    this.question = null;
    this.ok = 0;
    this.fail = 0;
    this.results = [];
    this.startTime = 0;
  }

  private showStartHint() {
    const scope = this.scopeProvince ? this.ctx.data.provinces.find((p) => p.adcode === this.scopeProvince)?.name ?? '当前省份' : '全国';
    const actions = '<button id="challenge-start" class="start-action">开始</button>';
    this.ctx.setHint(`<div class="start-panel"><div class="start-title">挑战模式</div><div class="start-subtitle">范围：${scope}</div>${actions}</div>`);
    window.setTimeout(() => {
      const start = document.getElementById('challenge-start') as HTMLButtonElement | null;
      if (start) start.onclick = () => this.start(false);
    }, 0);
  }

  private start(continueSaved: boolean) {
    if (this.started || this.paused) return;
    this.ensureScopeProvince();
    this.syncScopeView();
    this.order = scopedUnits(this.ctx.data, this.scopeProvince).map((u) => u.adcode);
    if (continueSaved) {
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
    this.startTime = continueSaved && this.startTime ? this.startTime : Date.now();
    this.ctx.updateProgress();
    this.ctx.setHint('蓝色 = 当前题目（随机）｜ 答对变绿并自动出下一题 ｜ 答错或超时变红并跳过');
    this.ask(first);
  }

  private next() {
    if (!this.started) return;
    this.countdown.stop();
    const pool = unvisitedUnits(this.ctx.data, this.scopeProvince, this.green, this.red);
    if (!pool.length) {
      this.refresh();
      this.finish();
      return;
    }
    this.ask(this.ctx.randomUnit(pool));
  }

  private ask(u: Unit) {
    this.question = u.adcode;
    this.refresh();
    if (this.ctx.settings.autoFollow) this.ctx.renderer.focusUnit(u.adcode, this.ctx.settings.followZoom);
    this.ctx.search.clear();
    this.ctx.search.focus();
    this.persist();
    this.countdown.start(this.ctx.settings.challengeSeconds, (r) => this.showCountdown(r), () => this.answer(false, true));
  }

  private showCountdown(remainingMs: number) {
    const urgentMs = this.ctx.settings.challengeSeconds * 1000 * 0.3;
    this.ctx.showTimer(remainingMs, remainingMs < urgentMs);
  }

  private answer(correct: boolean, timedOut = false, scored = true) {
    this.countdown.stop();
    this.ctx.showTimer(null);
    if (this.nextTimer !== null) {
      window.clearTimeout(this.nextTimer);
      this.nextTimer = null;
    }
    const q = this.question;
    if (!q) return;
    this.question = null;
    if (scored) this.ctx.store.recordAnswer(q, correct);
    if (correct) {
      this.green.add(q);
      this.ok++;
      this.results.push('green');
      this.ctx.renderer.flash(q);
      this.persist();
      this.next();
      return;
    }
    this.red.add(q);
    this.fail++;
    this.results.push('red');
    const name = this.ctx.byAdcode.get(q)?.name ?? q;
    this.ctx.toast(timedOut ? `超时，正确答案：${name}` : `正确答案：${name}`);
    this.persist();
    this.refresh();
    this.nextTimer = window.setTimeout(() => {
      this.nextTimer = null;
      if (!this.started || this.paused) return;
      this.next();
    }, 1500);
  }

  private finish() {
    this.countdown.stop();
    if (this.nextTimer !== null) {
      window.clearTimeout(this.nextTimer);
      this.nextTimer = null;
    }
    this.ctx.showTimer(null);
    this.started = false;
    this.paused = false;
    this.ctx.updateProgress();
    const elapsedMs = this.startTime ? Date.now() - this.startTime : 0;
    const result: RoundResult = {
      mode: 'challenge',
      scopeProvince: this.scopeProvince,
      scopeLabel: this.scopeLabel(),
      totalUnits: this.order.length,
      correct: this.ok,
      wrong: this.fail,
      elapsedMs,
      finishedAt: Date.now(),
    };
    this.ctx.showSummary(
      `挑战完成<div class="sum-stats">正确 <b>${this.ok}</b> ｜ 错误 <b>${this.fail}</b> ｜ 用时 ${formatElapsedSeconds(elapsedMs)}</div>`,
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
