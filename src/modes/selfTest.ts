import type { Mode, Unit } from '../types';
import type { ModeCtx, ModeController, ModeProgress, ProgressSegment } from './types';
import { Countdown } from '../ui/countdown';

type SavedSelfProgress = {
  green?: string[];
  red?: string[];
  results?: ProgressSegment[];
  question?: string | null;
  lastGreen?: string | null;
  activeProvince?: string | null;
};

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
  private ok = 0;
  private fail = 0;
  private started = false;
  private order: string[] = [];
  private results: ProgressSegment[] = [];
  private countdown = new Countdown();

  constructor(private ctx: ModeCtx) {}

  enter() {
    this.exit();
    this.green.clear();
    this.red.clear();
    this.question = null;
    this.lastGreen = null;
    this.scopeProvince = this.ctx.renderer.currentProvince();
    this.activeProvince = this.scopeProvince;
    this.ok = 0;
    this.fail = 0;
    this.started = false;
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
    this.ctx.showTimer(null);
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
    /* 测试模式以输入为准 */
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
    this.scopeProvince = this.ctx.renderer.currentProvince();
    this.activeProvince = this.scopeProvince;
    this.order = this.scopedUnits().map((u) => u.adcode);
    this.restore();
    this.showStartHint();
    this.ctx.updateProgress();
  }

  // ---------- 内部 ----------

  private storageKey() {
    return `china-admin-mode-progress:self:${this.scopeProvince ?? 'nation'}`;
  }

  private restore() {
    this.resetProgressState();
    try {
      const raw = localStorage.getItem(this.storageKey());
      if (!raw) return;
      const saved = JSON.parse(raw) as SavedSelfProgress;
      this.green = new Set((saved.green ?? []).filter((a) => this.order.includes(a)));
      this.red = new Set((saved.red ?? []).filter((a) => this.order.includes(a)));
      const legacyResults: ProgressSegment[] = [...Array(this.green.size).fill('green'), ...Array(this.red.size).fill('red')];
      this.results = (saved.results ?? legacyResults).filter((segment): segment is ProgressSegment => segment === 'green' || segment === 'red');
      this.results = this.results.slice(0, Math.min(this.order.length, this.green.size + this.red.size));
      this.question = saved.question && this.order.includes(saved.question) ? saved.question : null;
      this.lastGreen = saved.lastGreen && this.green.has(saved.lastGreen) ? saved.lastGreen : null;
      this.activeProvince = saved.activeProvince ?? this.scopeProvince;
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
      const saved = JSON.parse(raw) as SavedSelfProgress;
      return !!saved.question || !!saved.green?.length || !!saved.red?.length || !!saved.results?.length;
    } catch {
      return false;
    }
  }

  private persist() {
    try {
      localStorage.setItem(
        this.storageKey(),
        JSON.stringify({
          green: [...this.green],
          red: [...this.red],
          results: this.results,
          question: this.question,
          lastGreen: this.lastGreen,
          activeProvince: this.activeProvince,
        }),
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
    this.lastGreen = null;
    this.activeProvince = this.scopeProvince;
    this.ok = 0;
    this.fail = 0;
    this.results = [];
  }

  private showStartHint() {
    const scope = this.activeProvince ? this.ctx.data.provinces.find((p) => p.adcode === this.activeProvince)?.name ?? '当前省份' : '全国';
    const actions = this.hasSavedProgress()
      ? '<div class="start-actions"><button id="self-restart" class="start-action secondary">重新开始</button><button id="self-continue" class="start-action">继续</button></div>'
      : '<button id="self-start" class="start-action">开始</button>';
    this.ctx.setHint(`<div class="start-panel"><div class="start-title">输入模式</div><div class="start-subtitle">范围：${scope}</div>${actions}</div>`);
    window.setTimeout(() => {
      const start = document.getElementById('self-start') as HTMLButtonElement | null;
      const restart = document.getElementById('self-restart') as HTMLButtonElement | null;
      const resume = document.getElementById('self-continue') as HTMLButtonElement | null;
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
    this.scopeProvince = this.ctx.renderer.currentProvince();
    this.activeProvince = this.scopeProvince;
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
    if (!this.activeProvince) this.activeProvince = first.provinceAdcode;
    this.ctx.updateProgress();
    this.ctx.setHint('');
    this.ask(first);
  }

  private scopedUnits(): Unit[] {
    return this.ctx.data.units.filter((u) => !this.scopeProvince || u.provinceAdcode === this.scopeProvince);
  }

  private unvisited(): Unit[] {
    return this.scopedUnits().filter((u) => !this.green.has(u.adcode) && !this.red.has(u.adcode));
  }

  private ask(u: Unit) {
    this.question = u.adcode;
    this.refresh();
    if (this.ctx.settings.autoFollow) this.ctx.renderer.focusUnit(u.adcode, this.ctx.settings.followZoom);
    this.ctx.search.clear();
    this.ctx.search.focus();
    this.persist();
    if (this.ctx.settings.selfTimerEnabled) {
      this.countdown.start(this.ctx.settings.selfTimerSeconds, (r) => this.ctx.showTimer(r), () => this.answer(false, true));
    } else {
      this.ctx.showTimer(null);
    }
  }

  private answer(correct: boolean, timedOut = false, scored = true) {
    this.countdown.stop();
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
    const remain = this.unvisited();
    if (!remain.length) {
      this.refresh();
      this.finish();
      return;
    }
    this.ask(this.pickNext());
  }

  /** 省内优先 BFS：当前省未出完前不跨省；省内优先邻居，否则选同省最近未测点 */
  private pickNext(): Unit {
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
    this.countdown.stop();
    this.ctx.showTimer(null);
    this.started = false;
    this.ctx.updateProgress();
    this.ctx.showSummary(
      `自测完成<div class="sum-stats">正确 <b>${this.ok}</b> ｜ 错误 <b>${this.fail}</b> ｜ 覆盖 ${this.ok + this.fail} 个地级单位</div>`,
      () => {
        this.clearSaved();
        this.enter();
      },
    );
  }
}

function dist2(a: [number, number], b: [number, number]): number {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
}
