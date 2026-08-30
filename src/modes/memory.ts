import type { Mode } from '../types';
import type { ModeCtx, ModeController } from './types';
import { t } from '../i18n';

/** 自由模式：全图显示所有地图单位名称（白底标签），纯浏览、不交互 */
export class MemoryMode implements ModeController {
  id: Mode = 'memory';
  title = t('mode.memory.title');

  constructor(private ctx: ModeCtx) {}

  enter() {
    this.ctx.setHint('');
    this.refresh();
  }

  exit() {}

  refresh() {
    this.ctx.renderer.render({
      colorOf: () => 'gray',
      showAllLabels: true,
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
