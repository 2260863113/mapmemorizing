import type { Mode, Unit } from '../types';
import type { ModeCtx, ModeController } from './types';
import { Countdown } from '../ui/countdown';

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
  private ok = 0;
  private fail = 0;
  private startTime = 0;
  private countdown = new Countdown();

  constructor(private ctx: ModeCtx) {}

  enter() {
    this.exit();
    this.green.clear();
    this.red.clear();
    this.question = null;
    this.ok = 0;
    this.fail = 0;
    this.startTime = Date.now();
    this.ctx.search.setPlaceholder(`输入蓝色区域的名称（每题 ${this.ctx.settings.challengeSeconds} 秒）`);
    this.ctx.setHint('蓝色 = 当前题目（随机）｜ 答对变绿并自动出下一题 ｜ 答错或超时变红并跳过');
    this.next();
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
    return this.ok > 0 || this.fail > 0;
  }

  onSubmit(v: string) {
    if (!this.question || !v.trim()) return;
    const best = this.ctx.matcher.bestUnit(v);
    this.answer(!!best && best.adcode === this.question);
  }

  onUnitClick() {
    /* 以输入为准 */
  }

  onUnitDblClick(adcode: string) {
    const u = this.ctx.byAdcode.get(adcode);
    if (u) this.ctx.renderer.drillToProvince(u.provinceAdcode);
  }

  // ---------- 内部 ----------

  private next() {
    this.countdown.stop();
    const pool = this.ctx.data.units.filter((u) => !this.green.has(u.adcode) && !this.red.has(u.adcode));
    if (!pool.length) {
      this.refresh();
      this.finish();
      return;
    }
    const u = this.ctx.randomUnit(pool);
    this.question = u.adcode;
    this.refresh();
    this.ctx.search.clear();
    this.ctx.search.focus();
    this.countdown.start(this.ctx.settings.challengeSeconds, (r) => this.ctx.showTimer(r), () => this.answer(false, true));
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
      this.ctx.renderer.flash(q);
    } else {
      this.red.add(q);
      this.fail++;
      const name = this.ctx.byAdcode.get(q)?.name ?? q;
      this.ctx.toast(timedOut ? `超时，正确答案：${name}` : `正确答案：${name}`);
    }
    this.next();
  }

  private finish() {
    const secs = Math.round((Date.now() - this.startTime) / 1000);
    const mm = String(Math.floor(secs / 60)).padStart(2, '0');
    const ss = String(secs % 60).padStart(2, '0');
    this.ctx.showSummary(
      `挑战完成<div class="sum-stats">正确 <b>${this.ok}</b> ｜ 错误 <b>${this.fail}</b> ｜ 用时 ${mm}:${ss}</div>`,
      () => this.enter(),
    );
  }
}
