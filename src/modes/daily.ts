import type { Mode, RoundResult, Unit } from '../types';
import { Stopwatch } from '../ui/stopwatch';
import { formatElapsedSeconds } from '../ui/format';
import { normalizeProvince } from '../matcher';
import type { ModeCtx, ModeController, ProgressSegment } from './types';
import { progressOf } from './progress';
import { t } from '../i18n';

/** 每日竞速的作答方式。 */
export type DailyAnswerMode = 'click' | 'input';

/**
 * 每日竞速：省级粒度竞速。
 * - 出题范围：全国 34 个省级单元，随机顺序，每题只答一次（答错标红不重出）
 * - 点击/输入两种作答方式，开始后不可切换
 * - 答题不计入熟练度
 * - 全部答对才可提交成绩，排行榜按用时升序
 */
export class DailyMode implements ModeController {
  id: Mode = 'daily';
  title = t('mode.daily.title');
  private green = new Set<string>(); // 答对的省级 adcode
  private red = new Set<string>(); // 答错的省级 adcode
  private question: string | null = null; // 当前省级 adcode
  private order: string[] = []; // 省级 adcode 出题顺序
  private results: ProgressSegment[] = [];
  private started = false;
  private paused = false;
  private answerMode: DailyAnswerMode = this.loadAnswerMode();
  private stopwatch = new Stopwatch();

  constructor(private ctx: ModeCtx) {}

  enter() {
    if (this.paused) {
      this.syncRenderMode(); // 切走再切回时省级视图可能已被关闭，需恢复
      this.setSearchPlaceholder();
      this.ctx.setHint('');
      this.refresh();
      this.ctx.showStopwatch(this.stopwatch.elapsedMs());
      this.ctx.updateProgress();
      return;
    }
    this.exit();
    this.resetState();
    this.syncRenderMode();
    this.setSearchPlaceholder();
    this.showStartHint();
    this.refresh();
    this.ctx.updateProgress();
  }

  exit() {
    this.stopwatch.stop();
    this.started = false;
    this.paused = false;
    this.ctx.renderer.setProvinceMode(false); // 退出每日竞速恢复地级边界
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
    this.stopwatch.resume();
    this.ctx.showStopwatch(this.stopwatch.elapsedMs());
  }

  isPaused() {
    return this.paused;
  }

  isStarted() {
    return this.started;
  }

  hasProgress() {
    return this.green.size > 0 || this.red.size > 0 || !!this.question;
  }

  getProgress() {
    return progressOf(this.order.length, this.results);
  }

  refresh() {
    this.ctx.renderer.render({
      colorOf: (adcode) => {
        const province = this.provinceOf(adcode);
        if (this.green.has(province)) return 'green';
        if (this.red.has(province)) return 'red';
        if (this.question === province) return 'blue';
        return 'gray';
      },
      disableTooltip: true,
    });
  }

  onSubmit(v: string) {
    if (this.paused || !this.started || !this.question) return;
    if (this.answerMode !== 'input') return;
    if (!v.trim()) return;
    const matched = this.matchProvince(v);
    this.answer(!!matched && matched === this.question);
  }

  onInput(v: string) {
    if (this.paused || !this.started || !this.question) return;
    if (this.answerMode !== 'input') return;
    const matched = this.matchProvince(v);
    if (matched === this.question) this.answer(true);
  }

  onUnitClick(adcode: string) {
    if (this.paused) return true;
    if (!this.started || !this.question) return false;
    if (this.answerMode !== 'click') return true;
    const clicked = this.provinceOf(adcode);
    if (!clicked) return true;
    this.answer(clicked === this.question);
    return true;
  }

  onUnitDblClick() {
    /* 省级模式不支持下钻 */
  }

  onUnitHover() {
    /* 无悬停统计 */
  }

  onUnitHoverEnd() {
    /* 无悬停统计 */
  }

  onSkip() {
    /* 每日竞速无跳过 */
  }

  onEnd() {
    this.pause();
  }

  onReset() {
    this.stopwatch.stop();
    this.started = false;
    this.paused = false;
    this.enter();
  }

  onViewChange() {
    /* 省级模式固定全国视图 */
  }

  setAnswerMode(mode: DailyAnswerMode) {
    if (this.answerMode === mode) return;
    this.answerMode = mode;
    this.persistAnswerMode();
    if (!this.started) {
      this.setSearchPlaceholder();
      this.showStartHint(); // 未开始时刷新开始卡片副标题（点击/输入文案不同）
    }
  }

  getAnswerMode(): DailyAnswerMode {
    return this.answerMode;
  }

  getScopeProvince() {
    return null; // 每日竞速仅全国
  }

  collectResult(): RoundResult | null {
    return null; // 每日竞速不走结算卡片，完成时自行结算
  }

  // ---------- 内部 ----------

  private answerModeStorageKey() {
    return 'china-admin-mode-answer:daily';
  }

  private loadAnswerMode(): DailyAnswerMode {
    try {
      const raw = localStorage.getItem(this.answerModeStorageKey());
      return raw === 'input' ? 'input' : 'click';
    } catch {
      return 'click';
    }
  }

  private persistAnswerMode() {
    try {
      localStorage.setItem(this.answerModeStorageKey(), this.answerMode);
    } catch {
      /* 忽略存储失败 */
    }
  }

  private resetState() {
    this.green.clear();
    this.red.clear();
    this.question = null;
    this.results = [];
    this.order = this.shuffledProvinces();
  }

  private shuffledProvinces(): string[] {
    const list = this.ctx.data.provinces.map((p) => p.adcode);
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
    return list;
  }

  private showStartHint() {
    const actions = `<button id="daily-start" class="start-action">${t('common.start')}</button>`;
    const subtitle =
      this.answerMode === 'input'
        ? t('daily.startSubtitleInput', { total: this.order.length })
        : t('daily.startSubtitleClick', { total: this.order.length });
    this.ctx.setHint(`<div class="start-panel"><div class="start-title">${t('daily.startTitle')}</div><div class="start-subtitle">${subtitle}</div>${actions}</div>`);
    window.setTimeout(() => {
      const start = document.getElementById('daily-start') as HTMLButtonElement | null;
      if (start) start.onclick = () => this.start();
    }, 0);
  }

  private start() {
    if (this.started) return;
    this.started = true;
    this.paused = false;
    this.stopwatch.start((elapsedMs) => this.ctx.showStopwatch(elapsedMs));
    this.ctx.setHint('');
    this.askNext();
  }

  private askNext() {
    const remaining = this.order.filter((adcode) => !this.green.has(adcode) && !this.red.has(adcode));
    if (!remaining.length) {
      this.finish();
      return;
    }
    this.question = remaining[0];
    const province = this.provinceByAdcode(this.question);
    if (province) {
      this.ctx.setHint(`<div class="start-panel click-question"><div class="start-title">${province.name}</div></div>`);
    }
    this.refresh();
    this.ctx.updateProgress();
    if (this.answerMode === 'input') {
      this.ctx.search.clear();
      this.ctx.search.focus();
    }
  }

  private answer(correct: boolean) {
    const q = this.question;
    if (!q) return;
    this.question = null;
    // 每日竞速不计入熟练度
    if (correct) {
      this.green.add(q);
      this.results.push('green');
      this.ctx.toast(t('click.correctToast'));
      this.ctx.renderer.flash(q);
    } else {
      this.red.add(q);
      this.results.push('red');
      const name = this.provinceByAdcode(q)?.name ?? q;
      this.ctx.toast(t('click.correctAnswer', { name }));
    }
    this.refresh();
    this.ctx.updateProgress();
    this.askNext();
  }

  private finish() {
    const elapsedMs = this.stopwatch.elapsedMs();
    this.stopwatch.stop();
    this.started = false;
    this.paused = false;
    this.ctx.showTimer(null);
    this.ctx.showStopwatch(null);
    this.ctx.setHint('');
    this.ctx.updateProgress();

    const allCorrect = this.red.size === 0;
    if (allCorrect) {
      const result: RoundResult = {
        mode: 'daily',
        scopeProvince: null,
        scopeLabel: t('common.nation'),
        totalUnits: this.order.length,
        correct: this.green.size,
        wrong: this.red.size,
        elapsedMs,
        finishedAt: Date.now(),
      };
      this.ctx.showSummary(
        `${t('daily.complete')}<div class="sum-stats">${t('daily.summary', { time: formatElapsedSeconds(elapsedMs), total: this.order.length })}</div>`,
        () => this.enter(),
        result,
      );
    } else {
      this.ctx.showSummary(
        `${t('daily.complete')}<div class="sum-stats">${t('daily.notAllCorrect', { wrong: this.red.size })}</div>`,
        () => this.enter(),
        undefined,
      );
    }
  }

  /** 把地级 adcode 映射到省级 adcode。 */
  private provinceOf(adcode: string): string {
    const unit: Unit | undefined = this.ctx.byAdcode.get(adcode);
    if (unit && !unit.decorative) return unit.provinceAdcode;
    return adcode;
  }

  private provinceByAdcode(adcode: string) {
    return this.ctx.data.provinces.find((p) => p.adcode === adcode) ?? null;
  }

  /** 省级匹配：输入简名或全名（normalizeProvince 精确匹配）。 */
  private matchProvince(input: string): string | null {
    const ni = normalizeProvince(input);
    if (!ni) return null;
    for (const p of this.ctx.data.provinces) {
      if (normalizeProvince(p.name) === ni) return p.adcode;
    }
    return null;
  }

  private setSearchPlaceholder() {
    this.ctx.search.setPlaceholder(this.answerMode === 'input' ? t('daily.inputPlaceholder') : t('self.placeholder'));
  }

  private syncRenderMode() {
    this.ctx.renderer.setProvinceMode(true);
  }
}
