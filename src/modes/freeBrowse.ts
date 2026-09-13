import type { Mode } from '../types';
import type { ModeCtx } from './types';
import { BaseMode } from './baseMode';
import { t } from '../i18n';
import type { Granularity } from '../province';
import { loadMemoryHideLabels, saveMemoryHideLabels, type ModeSettingsPanel } from '../modeSettings';

/**
 * 自由模式：全图显示所有地图单位名称（白底标签），纯浏览、不交互；可隐藏标签。
 *
 * 沿用「世界/省级/市级」分段按钮（与点击/输入模式同一套 UI 与记忆），
 * 但**不支持下钻**：双击任何面都不再进入下一级，只在当前粒度内浏览与缩放。
 */
export class FreeBrowseMode extends BaseMode {
  id: Mode = 'memory';
  title = t('mode.memory.title');
  private hideLabels = loadMemoryHideLabels(); // 隐藏所有地名标签
  /** 浏览粒度：'world'（国家名）| 'province'（省名）| 'city'（地级市名，默认）。 */
  private granularity: Granularity = this.loadGranularity();

  constructor(private ctx: ModeCtx) { super(); }

  getModeSettings(): ModeSettingsPanel | null {
    return {
      title: t('mode.memory.title'),
      toggles: [{ key: 'hide-labels', label: t('settings.hideLabels'), value: this.hideLabels }],
      onChange: (key, value) => {
        if (key === 'hide-labels') {
          this.hideLabels = value;
          saveMemoryHideLabels(value);
          this.refresh();
        }
      },
    };
  }

  getGranularity(): Granularity {
    return this.granularity;
  }

  /** 切换浏览粒度（纯浏览，无「测试进行中」限制）。 */
  setGranularity(g: Granularity) {
    if (this.granularity === g) return;
    this.granularity = g;
    this.persistGranularity();
    this.enter();
  }

  private granularityStorageKey() {
    // 与 mapQuizMode 的键格式保持一致（按模式分开记忆粒度）
    return 'china-admin-mode-granularity:memory';
  }

  private loadGranularity(): Granularity {
    try {
      const raw = localStorage.getItem(this.granularityStorageKey());
      if (raw === 'province') return 'province';
      if (raw === 'world') return 'world';
      return 'city'; // 默认地级（现状）
    } catch {
      return 'city';
    }
  }

  private persistGranularity() {
    try {
      localStorage.setItem(this.granularityStorageKey(), this.granularity);
    } catch {
      /* 忽略存储失败 */
    }
  }

  enter() {
    this.ctx.setHint('');
    this.refresh();
  }

  exit() {}

  refresh() {
    if (this.granularity === 'world') {
      // 世界档：世界地图（无放大框、无下钻），全部国家灰底 + 国名标签（放大到阈值后显示）
      this.ctx.renderer.setWorldMode(true, null, null);
      this.ctx.renderer.render({
        colorOf: () => 'gray',
        hideLabels: this.hideLabels,
        worldShowAllLabels: !this.hideLabels,
        disableTooltip: true,
      });
      return;
    }
    if (this.granularity === 'province') {
      // 省级档：省级地图（无港澳放大框、不支持下钻），全部省面灰底 + 省名标签常显
      this.ctx.renderer.setProvinceMode(true, { inset: false, allowDrill: false });
      if (this.ctx.renderer.currentProvince()) this.ctx.renderer.backToNation();
      this.ctx.renderer.render({
        colorOf: () => 'gray',
        hideLabels: this.hideLabels,
        showAllProvinceLabels: !this.hideLabels,
        disableTooltip: true,
      });
      return;
    }
    // 市级档（默认）：地级地图，全部地级市灰底 + 地名标签
    this.ctx.renderer.setProvinceMode(false, { inset: false });
    this.ctx.renderer.render({
      colorOf: () => 'gray',
      hideLabels: this.hideLabels,
      showAllLabels: !this.hideLabels,
      labelZoomThreshold: 1,
      disableTooltip: true,
    });
  }

  hasProgress() { return false; }

  onUnitClick() { /* 纯浏览，不响应点击 */ }

  /** 不支持下钻：双击在自由模式里没有任何额外语义。 */
  onUnitDblClick(_adcode: string) { /* 自由模式不支持下钻 */ }
}
