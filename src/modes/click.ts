import type { Mode, Unit } from '../types';
import type { ModeCtx, ModeController, ModeProgress, ProgressSegment } from './types';

type SavedClickProgress = {
  green?: string[];
  red?: string[];
  results?: ProgressSegment[];
  question?: string | null;
  scopeProvince?: string | null;
};

/** 点击模式：根据顶部题目提示，在地图上点击对应的地级单位。 */
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

  constructor(private ctx: ModeCtx) {}

  enter() {
    this.exit();
    this.scopeProvince = this.ctx.renderer.currentProvince();
    this.order = this.scopedUnits().map((u) => u.adcode);
    this.restore();
    this.showStartHint();
    this.refresh();
    this.ctx.updateProgress();
  }

  exit() {
    this.started = false;
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
      disableTooltip: true,
    });
  }

  getProgress(): ModeProgress {
    return {
      total: this.order.length,
      segments: [...this.results, ...Array<ProgressSegment>(Math.max(0, this.order.length - this.results.length)).fill('pending')],
    };
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
    if (!this.started || !this.question) return false;
    const clicked = this.ctx.byAdcode.get(adcode);
    if (!clicked || (this.scopeProvince !== null && clicked.provinceAdcode !== this.scopeProvince)) return true;
    this.answer(adcode === this.question);
    return true;
  }

  onUnitDblClick(adcode: string) {
    if (this.started) return;
    const u = this.ctx.byAdcode.get(adcode);
    if (u) this.ctx.renderer.drillToProvince(u.provinceAdcode);
  }

  onSkip() {
    if (!this.started || !this.question) return;
    this.answer(false, false);
  }

  onEnd() {
    if (this.started) this.finish();
  }

  onReset() {
    this.clearSaved();
    this.enter();
  }

  onViewChange() {
    if (this.started) return;
    this.scopeProvince = this.ctx.renderer.currentProvince();
    this.order = this.scopedUnits().map((u) => u.adcode);
    this.restore();
    this.showStartHint();
    this.ctx.updateProgress();
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
    try {
      const raw = localStorage.getItem(this.storageKey());
      if (!raw) return;
      const saved = JSON.parse(raw) as SavedClickProgress;
      this.green = new Set((saved.green ?? []).filter((a) => this.order.includes(a)));
      this.red = new Set((saved.red ?? []).filter((a) => this.order.includes(a)));
      this.results = (saved.results ?? [])
        .filter((segment): segment is ProgressSegment => segment === 'green' || segment === 'red')
        .slice(0, Math.min(this.order.length, this.green.size + this.red.size));
      this.question = saved.question && this.order.includes(saved.question) ? saved.question : null;
      this.ok = this.green.size;
      this.fail = this.red.size;
    } catch {
      /* 忽略损坏的本地进度 */
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
          scopeProvince: this.scopeProvince,
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

  private showStartHint() {
    const scope = this.scopeProvince ? this.ctx.data.provinces.find((p) => p.adcode === this.scopeProvince)?.name ?? '当前省份' : '全国';
    const actions = this.hasProgress()
      ? '<div class="start-actions"><button id="click-restart" class="start-action secondary">重新开始</button><button id="click-continue" class="start-action">继续</button></div>'
      : '<button id="click-start" class="start-action">开始</button>';
    this.ctx.setHint(`<div class="start-panel"><div class="start-title">点击模式</div><div class="start-subtitle">范围：${scope}，请按提示点击地图</div>${actions}</div>`);
    window.setTimeout(() => {
      const start = document.getElementById('click-start') as HTMLButtonElement | null;
      const restart = document.getElementById('click-restart') as HTMLButtonElement | null;
      const resume = document.getElementById('click-continue') as HTMLButtonElement | null;
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
    this.order = this.scopedUnits().map((u) => u.adcode);
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
    const pool = this.unvisited();
    const first = resumed ?? (pool.length ? this.ctx.randomUnit(pool) : null);
    if (!first) {
      this.finish();
      return;
    }
    this.started = true;
    this.ctx.setHint('点击蓝色题目对应的地图区域；答对变绿，答错时正确答案变红');
    this.ask(first);
  }

  private ask(unit: Unit) {
    this.question = unit.adcode;
    this.ctx.setHint(`<div class="start-panel"><div class="start-title">请点击：${unit.name}</div><div class="start-subtitle">范围：${this.scopeLabel()}</div></div>`);
    this.refresh();
    this.persist();
  }

  private answer(correct: boolean, scored = true) {
    const q = this.question;
    if (!q) return;
    this.question = null;
    if (scored) this.ctx.store.recordAnswer(q, correct);
    if (correct) {
      this.green.add(q);
      this.ok += 1;
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
    const pool = this.unvisited();
    if (!pool.length) {
      this.refresh();
      this.finish();
      return;
    }
    this.ask(this.ctx.randomUnit(pool));
  }

  private finish() {
    this.started = false;
    this.ctx.showTimer(null);
    this.ctx.updateProgress();
    this.ctx.showSummary(
      `点击模式完成<div class="sum-stats">正确 <b>${this.ok}</b> ｜ 错误 <b>${this.fail}</b> ｜ 覆盖 ${this.ok + this.fail} 个地级单位</div>`,
      () => {
        this.clearSaved();
        this.enter();
      },
    );
  }

  private scopeLabel() {
    return this.scopeProvince ? this.ctx.data.provinces.find((p) => p.adcode === this.scopeProvince)?.name ?? '当前省份' : '全国';
  }

  private scopedUnits() {
    return this.ctx.data.units.filter((u) => !this.scopeProvince || u.provinceAdcode === this.scopeProvince);
  }

  private unvisited() {
    return this.scopedUnits().filter((u) => !this.green.has(u.adcode) && !this.red.has(u.adcode));
  }
}
