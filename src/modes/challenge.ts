import type { Mode, Unit } from '../types';
import type { ModeCtx, ModeController, ModeProgress, ProgressSegment } from './types';
import { Countdown } from '../ui/countdown';

type SavedChallengeProgress = {
  green?: string[];
  red?: string[];
  results?: ProgressSegment[];
  question?: string | null;
  startTime?: number;
};

/**
 * 挑战模式：随机标蓝一个地级单位作为题目，输入正确变绿并立即随机出下一题；
 * 答错或超时变红（错误标记）并跳过。每题默认 10 秒（设置中可调）。
 */
export class ChallengeMode implements ModeController {
  id: Mode = 'challenge';
  title = '挑战模式';
  private green = new Set<string>();
  private red = new Set<string>();
  private question: string | null = null;
  private started = false;
  private activeProvince: string | null = null;
  private ok = 0;
  private fail = 0;
  private order: string[] = [];
  private results: ProgressSegment[] = [];
  private startTime = 0;
  private nextTimer: number | null = null;
  private countdown = new Countdown();

  constructor(private ctx: ModeCtx) {}

  enter() {
    this.exit();
    this.green.clear();
    this.red.clear();
    this.question = null;
    this.started = false;
    this.activeProvince = this.ctx.renderer.currentProvince();
    this.ok = 0;
    this.fail = 0;
    this.startTime = 0;
    this.order = this.scopedUnits().map((u) => u.adcode);
    this.restore();
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

  getProgress(): ModeProgress {
    return {
      total: this.order.length,
      segments: [...this.results, ...Array<ProgressSegment>(Math.max(0, this.order.length - this.results.length)).fill('pending')],
    };
  }

  isStarted() {
    return this.started;
  }

  onSubmit(v: string) {
    if (!this.question || !v.trim()) return;
    const best = this.ctx.matcher.bestUnit(v);
    this.answer(!!best && best.adcode === this.question);
  }

  onInput(v: string) {
    if (!this.question || !v.trim()) return;
    const best = this.ctx.matcher.bestUnit(v);
    if (best?.adcode === this.question) this.answer(true);
  }

  onUnitClick() {
    /* 以输入为准 */
  }

  onUnitDblClick(adcode: string) {
    const u = this.ctx.byAdcode.get(adcode);
    if (u) this.ctx.renderer.drillToProvince(u.provinceAdcode);
  }

  onSkip() {
    if (!this.started || !this.question) return;
    this.answer(false, false, false);
  }

  onEnd() {
    this.finish();
  }

  onReset() {
    this.clearSaved();
    this.enter();
  }

  onViewChange() {
    if (this.started) return;
    this.activeProvince = this.ctx.renderer.currentProvince();
    this.order = this.scopedUnits().map((u) => u.adcode);
    this.restore();
    this.showStartHint();
    this.ctx.updateProgress();
  }

  // ---------- 内部 ----------

  private storageKey() {
    return `china-admin-mode-progress:challenge:${this.activeProvince ?? 'nation'}`;
  }

  private restore() {
    this.resetProgressState();
    try {
      const raw = localStorage.getItem(this.storageKey());
      if (!raw) return;
      const saved = JSON.parse(raw) as SavedChallengeProgress;
      this.green = new Set((saved.green ?? []).filter((a) => this.order.includes(a)));
      this.red = new Set((saved.red ?? []).filter((a) => this.order.includes(a)));
      const legacyResults: ProgressSegment[] = [...Array(this.green.size).fill('green'), ...Array(this.red.size).fill('red')];
      this.results = (saved.results ?? legacyResults).filter((segment): segment is ProgressSegment => segment === 'green' || segment === 'red');
      this.results = this.results.slice(0, Math.min(this.order.length, this.green.size + this.red.size));
      this.question = saved.question && this.order.includes(saved.question) ? saved.question : null;
      this.startTime = typeof saved.startTime === 'number' ? saved.startTime : 0;
      this.ok = this.green.size;
      this.fail = this.red.size;
    } catch {
      /* 忽略损坏的本地进度 */
    }
  }

  private hasSavedProgress() {
    try {
      const raw = localStorage.getItem(this.storageKey());
      if (!raw) return false;
      const saved = JSON.parse(raw) as SavedChallengeProgress;
      return !!saved.question || !!saved.green?.length || !!saved.red?.length || !!saved.results?.length;
    } catch {
      return false;
    }
  }

  private persist() {
    try {
      localStorage.setItem(
        this.storageKey(),
        JSON.stringify({ green: [...this.green], red: [...this.red], results: this.results, question: this.question, startTime: this.startTime }),
      );
    } catch {
      /* 忽略存储失败 */
    }
    this.ctx.updateProgress();
  }

  private clearSaved() {
    try {
      localStorage.removeItem(this.storageKey());
    } catch {
      /* 忽略存储失败 */
    }
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
    const scope = this.activeProvince ? this.ctx.data.provinces.find((p) => p.adcode === this.activeProvince)?.name ?? '当前省份' : '全国';
    const actions = this.hasSavedProgress()
      ? '<div class="start-actions"><button id="challenge-restart" class="start-action secondary">重新开始</button><button id="challenge-continue" class="start-action">继续</button></div>'
      : '<button id="challenge-start" class="start-action">开始</button>';
    this.ctx.setHint(`<div class="start-panel"><div class="start-title">挑战模式</div><div class="start-subtitle">范围：${scope}</div>${actions}</div>`);
    window.setTimeout(() => {
      const start = document.getElementById('challenge-start') as HTMLButtonElement | null;
      const restart = document.getElementById('challenge-restart') as HTMLButtonElement | null;
      const resume = document.getElementById('challenge-continue') as HTMLButtonElement | null;
      if (start) start.onclick = () => this.start(false);
      if (restart) restart.onclick = () => {
        this.clearSaved();
        this.start(false);
      };
      if (resume) resume.onclick = () => this.start(true);
    }, 0);
  }

  private start(continueSaved: boolean) {
    if (this.started) return;
    this.activeProvince = this.ctx.renderer.currentProvince();
    this.order = this.scopedUnits().map((u) => u.adcode);
    if (continueSaved) {
      this.restore();
    } else {
      this.clearSaved();
      this.resetProgressState();
    }

    const resumed = this.question ? this.ctx.byAdcode.get(this.question) ?? null : null;
    const pool = this.unvisited();
    const first = resumed ?? (pool.length ? this.ctx.randomUnit(pool) : null);
    if (!first) {
      this.finish();
      return;
    }
    this.started = true;
    this.startTime = continueSaved && this.startTime ? this.startTime : Date.now();
    this.ctx.updateProgress();
    this.ctx.setHint('蓝色 = 当前题目（随机）｜ 答对变绿并自动出下一题 ｜ 答错或超时变红并跳过');
    this.ask(first);
  }

  private scopedUnits(): Unit[] {
    return this.ctx.data.units.filter((u) => !this.activeProvince || u.provinceAdcode === this.activeProvince);
  }

  private unvisited(): Unit[] {
    return this.scopedUnits().filter((u) => !this.green.has(u.adcode) && !this.red.has(u.adcode));
  }

  private next() {
    if (!this.started) return;
    this.countdown.stop();
    const pool = this.unvisited();
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
    this.countdown.start(this.ctx.settings.challengeSeconds, (r) => this.ctx.showTimer(r), () => this.answer(false, true));
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
    this.ctx.updateProgress();
    const secs = this.startTime ? Math.round((Date.now() - this.startTime) / 1000) : 0;
    const mm = String(Math.floor(secs / 60)).padStart(2, '0');
    const ss = String(secs % 60).padStart(2, '0');
    this.ctx.showSummary(
      `挑战完成<div class="sum-stats">正确 <b>${this.ok}</b> ｜ 错误 <b>${this.fail}</b> ｜ 用时 ${mm}:${ss}</div>`,
      () => {
        this.clearSaved();
        this.enter();
      },
    );
  }
}
