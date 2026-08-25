import type { Mode, Unit } from '../types';
import type { ModeCtx, ModeController } from './types';
import { Countdown } from '../ui/countdown';

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
  private ok = 0;
  private fail = 0;
  private started = false;
  private countdown = new Countdown();

  constructor(private ctx: ModeCtx) {}

  enter() {
    this.exit();
    this.green.clear();
    this.red.clear();
    this.question = null;
    this.lastGreen = null;
    this.ok = 0;
    this.fail = 0;
    this.started = true;
    this.ctx.search.setPlaceholder(this.ctx.settings.requireEnter ? '输入当前蓝色区域的名称，回车提交' : '输入当前蓝色区域的名称');
    this.ctx.setHint(
      this.ctx.settings.requireEnter
        ? '蓝色 = 当前题目 ｜ 答对变绿并从相邻区域继续扩张（BFS，优先同省）｜ 答错标红并跳过'
        : '蓝色 = 当前题目 ｜ 输入正确答案后自动变绿并继续扩张 ｜ 错误输入不会标红',
    );
    this.ask(this.ctx.randomUnit(this.unvisited()));
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
    return this.started && (this.green.size > 0 || this.red.size > 0);
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

  // ---------- 内部 ----------

  private unvisited(): Unit[] {
    return this.ctx.data.units.filter((u) => !this.green.has(u.adcode) && !this.red.has(u.adcode));
  }

  private ask(u: Unit) {
    this.question = u.adcode;
    this.refresh();
    if (this.ctx.settings.autoFollow) this.ctx.renderer.focusUnit(u.adcode);
    this.ctx.search.clear();
    this.ctx.search.focus();
    if (this.ctx.settings.selfTimerEnabled) {
      this.countdown.start(this.ctx.settings.selfTimerSeconds, (r) => this.ctx.showTimer(r), () => this.answer(false, true));
    } else {
      this.ctx.showTimer(null);
    }
  }

  private answer(correct: boolean, timedOut = false) {
    this.countdown.stop();
    this.ctx.showTimer(null);
    const q = this.question;
    if (!q) return;
    this.question = null;
    if (correct) {
      this.green.add(q);
      this.ok++;
      this.lastGreen = q;
      this.ctx.renderer.flash(q);
    } else {
      this.red.add(q);
      this.fail++;
      const name = this.ctx.byAdcode.get(q)?.name ?? q;
      this.ctx.toast(timedOut ? `超时，正确答案：${name}` : `正确答案：${name}`);
    }
    const remain = this.unvisited();
    if (!remain.length) {
      this.refresh();
      this.finish();
      return;
    }
    this.ask(this.pickNext());
  }

  /** BFS 扩张：优先取与上一个绿点相邻的未测单位，同省优先；否则回退最近未测 */
  private pickNext(): Unit {
    const last = this.lastGreen ? this.ctx.byAdcode.get(this.lastGreen) : null;
    if (last) {
      const cands = last.neighbors
        .map((a) => this.ctx.byAdcode.get(a))
        .filter((u): u is Unit => !!u && !this.green.has(u.adcode) && !this.red.has(u.adcode));
      if (cands.length) {
        const same = cands.filter((u) => u.provinceAdcode === last.provinceAdcode);
        return this.ctx.randomUnit(same.length ? same : cands);
      }
    }
    const unv = this.unvisited();
    if (!unv.length) return unv[0];
    const ref = last?.center ?? [104.5, 35];
    unv.sort((a, b) => dist2(a.center, ref) - dist2(b.center, ref));
    return unv[0];
  }

  private finish() {
    this.ctx.showSummary(
      `自测完成<div class="sum-stats">正确 <b>${this.ok}</b> ｜ 错误 <b>${this.fail}</b> ｜ 覆盖 ${this.ok + this.fail} 个地级单位</div>`,
      () => this.enter(),
    );
  }
}

function dist2(a: [number, number], b: [number, number]): number {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
}
