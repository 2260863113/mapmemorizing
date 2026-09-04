import type { Mode, Unit } from '../types';
import type { ClickOrderMode, ModeCtx, OrderMode } from './types';
import { t } from '../i18n';
import { formatElapsedSeconds } from '../ui/format';
import { pickWrongNext } from './wrongOrder';
import { loadClickErrorRollback, saveClickErrorRollback, type ModeSettingsPanel } from '../modeSettings';
import { provinceShortName } from '../province';
import { MapQuizMode } from './mapQuizMode';

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
    // 世界全国：未开始点击国家不下钻（国家为最小单元）；开始后直接判题
    if (this.isWorldNation()) {
      if (!this.started || !this.question) return true;
      this.answer(adcode === this.question, true);
      return true;
    }
    // 省级全国：未开始时单击某省 → 下钻该省（变成该省地级市级练习；返回全国后回省级全国）
    if (this.isProvinceNation() && !this.started) {
      this.drillFromProvinceNation(adcode);
      return true;
    }
    if (!this.started || !this.question) return false;
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
    const scope = this.scopeLabel();
    const actions = '<button id="click-start" class="start-action">' + t('common.start') + '</button>';
    this.ctx.setHint('<div class="start-panel"><div class="start-title">' + t('click.startTitle') + '</div><div class="start-subtitle">' + t('click.startSubtitle', { scope }) + '</div>' + actions + '</div>');
    window.setTimeout(() => {
      const start = document.getElementById('click-start') as HTMLButtonElement | null;
      if (start) start.onclick = () => this.start(false);
    }, 0);
  }

  refresh() {
    const provinceNation = this.isProvinceNation();
    const worldNation = this.isWorldNation();
    this.ctx.renderer.render({
      colorOf: (adcode) => {
        if (this.green.has(adcode)) return 'green';
        if (this.red.has(adcode)) return 'red';
        return 'gray';
      },
      disableTooltip: true,
      // 省级全国：已作答省显示绿/红省名简称标签
      provinceLabel: provinceNation
        ? (provinceAdcode) => {
            if (this.green.has(provinceAdcode)) {
              return { text: provinceShortName(this.ctx.data, provinceAdcode), color: 'green' as const };
            }
            if (this.red.has(provinceAdcode)) {
              return { text: provinceShortName(this.ctx.data, provinceAdcode), color: 'red' as const };
            }
            return null;
          }
        : undefined,
      // 世界全国：已作答国显示绿/红国名标签
      worldLabel: worldNation
        ? (iso) => {
            if (this.green.has(iso)) {
              return { text: this.countryName(iso), color: 'green' as const };
            }
            if (this.red.has(iso)) {
              return { text: this.countryName(iso), color: 'red' as const };
            }
            return null;
          }
        : undefined,
    });
  }

  private countryName(iso: string): string {
    return this.ctx.data.countries.find((c) => c.iso === iso)?.name ?? iso;
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
    // 省级全国测验：顶部显示省全名；世界全国测验：显示国家中文名（点击模式不在地图上高亮目标）
    this.ctx.setHint('<div class="start-panel click-question"><div class="start-title">' + unit.name + '</div></div>');
  }
}