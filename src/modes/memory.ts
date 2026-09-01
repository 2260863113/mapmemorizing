import type { Mode } from '../types';
import type { ModeCtx, ModeController } from './types';
import { t } from '../i18n';
import { loadMemoryHideLabels, saveMemoryHideLabels, type ModeSettingsPanel } from '../modeSettings';

/** 自由模式：全图显示所有地图单位名称（白底标签），纯浏览、不交互；可隐藏标签。 */
export class MemoryMode implements ModeController {
  id: Mode = 'memory';
  title = t('mode.memory.title');
  private hideLabels = loadMemoryHideLabels(); // 隐藏所有地级市标签

  constructor(private ctx: ModeCtx) {}

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

  enter() {
    this.ctx.setHint('');
    this.refresh();
  }

  exit() {}

  refresh() {
    this.ctx.renderer.render({
      colorOf: () => 'gray',
      showAllLabels: !this.hideLabels,
      labelZoomThreshold: 1,
      disableTooltip: true,
    });
  }

  hasProgress() {
    return false;
  }

  onSubmit() {}

  onUnitClick() {
    /* 纯浏览，不响应点击 */
  }

  onUnitDblClick(adcode: string) {
    const u = this.ctx.byAdcode.get(adcode);
    if (u) this.ctx.renderer.drillToProvince(u.provinceAdcode);
  }
}
