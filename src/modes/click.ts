import type { Mode, Unit } from '../types';
import type { ModeCtx, OrderMode } from './types';
import { t } from '../i18n';
import { formatElapsedSeconds } from '../ui/format';
import { pickWrongNext } from './wrongOrder';
import { loadClickErrorRollback, saveClickErrorRollback, type ModeSettingsPanel } from '../modeSettings';
import { canDrillProvince, drillTargetOfUnit } from '../province';
import { MapQuizMode } from './mapQuizMode';
import { showStartCard } from '../ui/dom';
import { escapeAttr } from '../ui/html';

/**
 * 点击模式：根据顶部题目提示，在地图上点击对应的地图单位。
 * - 市级粒度（默认不再默认）：全国地级市 / 单省地级市练习（原版）。
 * - 省级粒度：全国 34 个省级单元的练习（地图为省级视图，不含地级边界/标签），
 *   省级答题只计入省级熟练度（与地级熟练度隔离）。
 * - 粒度选择：仅全国视图（scopeProvince=null）可切换；测试开始后锁定隐藏。
 */
export class ClickMode extends MapQuizMode {
  readonly id: Mode = 'click';
  readonly title = t('mode.click.title');

  constructor(ctx: ModeCtx) {
    super(ctx);
  }

  // ==================== 差异点实现 ====================

  protected storagePrefix() { return 'click'; }
  protected defaultOrderMode(): OrderMode { return 'random'; }
  protected parseOrderMode(raw: string | null): OrderMode {
    return raw === 'wrong' ? 'wrong' : 'random';
  }
  protected loadErrorRollback() { return loadClickErrorRollback(); }
  protected saveErrorRollback(v: boolean) { saveClickErrorRollback(v); }
  protected wrongToast(name: string, _timedOut: boolean) {
    return t('click.correctAnswer', { name });
  }
  protected summaryHtml(elapsedMs: number) {
    let stat: string;
    if (this.isProvinceNation()) {
      stat = t('click.summaryProvince', { ok: this.ok, fail: this.fail, time: formatElapsedSeconds(elapsedMs), total: this.ok + this.fail });
    } else if (this.isWorldNation()) {
      stat = t('click.summaryWorld', { ok: this.ok, fail: this.fail, time: formatElapsedSeconds(elapsedMs), total: this.ok + this.fail });
    } else {
      stat = t('click.summary', { ok: this.ok, fail: this.fail, time: formatElapsedSeconds(elapsedMs), total: this.ok + this.fail });
    }
    return t('click.complete') + '<div class="sum-stats">' + stat + '</div>';
  }

  // ==================== 点击特有：设置 / 判题 ====================

  getModeSettings(): ModeSettingsPanel | null {
    return {
      title: t('mode.click.title'),
      toggles: [{ key: 'error-rollback', label: t('settings.errorRollback'), value: this.errorRollback }],
      onChange: (key, value) => {
        if (key === 'error-rollback') {
          this.errorRollback = value;
          saveClickErrorRollback(value);
        }
      },
    };
  }

  onSubmit() {}
  onInput() {}

  onUnitClick(adcode: string) {
    if (this.paused || this.rollbacking) return true;
    // 世界粒度：未开始点击国家 → 逐层下钻（世界→大洲→次区域）；已开始 → 直接判题（国家为最小单元）
    if (this.isWorldNation()) {
      if (!this.started || !this.question) {
        const c = this.ctx.data.countries.find((x) => x.iso === adcode);
        if (c) this.drillFromWorldNation(c.continent, c.iso);
        return true;
      }
      this.answer(adcode === this.question, true);
      return true;
    }
    // 省级全国：未开始时单击某省 → 下钻该省（变成该省地级市级练习；返回全国后回省级全国）
    if (this.isProvinceNation() && !this.started) {
      this.drillFromProvinceNation(adcode);
      return true;
    }
    if (!this.started || !this.question) {
      // 市级全国未开始时点地级市：renderer 会自动下钻到它的省 —— 但唯一层级的
      // 京津沪渝/港澳台没有下级单位，必须拦在这里（用户口径：一律不下钻）
      if (!canDrillProvince(drillTargetOfUnit(this.ctx.data, adcode))) {
        this.ctx.toast(t('common.noDrillSingleUnit'));
        return true;
      }
      return false;
    }
    // 省级单省视图点击（scope 省，地级单位）与市级全国：按地图单位命中判断
    const clicked = this.ctx.byAdcode.get(adcode);
    if (clicked && this.scopeProvince !== null && clicked.provinceAdcode !== this.scopeProvince) return true;
    this.answer(adcode === this.question, true);
    return true;
  }

  // ==================== 出题 ====================

  ask(unit: Unit) {
    this.question = unit.adcode;
    this.showQuestionHint(unit);
    this.refresh();
    this.persist();
  }

  nextUnit(pool: Unit[]): Unit {
    if (this.orderMode === 'wrong') return pickWrongNext(pool, this.scoreOf, this.wrongOrder, this.ctx.toast);
    return this.ctx.randomUnit(pool);
  }

  showStartHint() {
    showStartCard({
      id: 'click-start',
      title: t('click.startTitle'),
      subtitle: t('click.startSubtitle', { scope: this.scopeLabel() }),
      onStart: () => this.start(false),
    });
  }

  refresh() {
    this.ctx.renderer.render({
      colorOf: (adcode) => {
        if (this.green.has(adcode)) return 'green';
        if (this.red.has(adcode)) return 'red';
        return 'gray';
      },
      disableTooltip: true,
      // 未开始（浏览态）：显示全量地名；开始后清空，只留已作答的绿/红（见 browseLabels.ts）
      ...this.browseLabelState(),
      // 省名标签 / 国名标签：与输入模式共用基类实现（原先两个子类各抄了一份）
      provinceLabel: this.provinceLabelOf(),
      worldLabel: this.worldLabelOf(),
    });
  }

  // ==================== 点击特有：钩子覆写 ====================

  protected onResume() {
    const unit = this.currentUnitOf(this.question);
    if (unit) this.showQuestionHint(unit);
    this.ctx.showStopwatch(this.stopwatch.elapsedMs());
  }
  protected onResetHook() { this.ctx.showStopwatch(null); }
  protected onCorrect(_q: string) { this.ctx.toast(t('click.correctToast')); }

  private showQuestionHint(unit: Unit) {
    // 「国旗」档（仅点击模式提供这一栏）：题面给一张国旗图，用户点地图上对应的国家。
    // alt 必须为空 —— 写国名就等于把答案写在题面上；没有国旗资源时回落到国名题面。
    if (this.isWorldNation() && this.naming.world === 'flag') {
      const src = this.worldFlagSrc(unit.adcode);
      if (src) {
        this.ctx.setHint(
          '<div class="start-panel click-question flag-question"><img src="' + escapeAttr(src) + '" alt="" draggable="false" /></div>',
        );
        return;
      }
    }
    // 省级全国测验：顶部显示省全名 或 单字简称；世界全国测验：显示 国名/首都名 的 中/英文
    // （点击模式不在地图上高亮目标）。文本一律由基类的 displayNameOf 统一给出，避免与标签口径分叉。
    this.ctx.setHint('<div class="start-panel click-question"><div class="start-title">' + this.displayNameOf(unit) + '</div></div>');
  }
}