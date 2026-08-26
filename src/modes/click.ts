import type { Mode } from '../types';
import type { ModeCtx, ModeController } from './types';

/** 点击模式占位控制器，完整答题流程在模式功能批次中接入。 */
export class ClickMode implements ModeController {
  id: Mode = 'click';
  title = '点击模式';

  constructor(private ctx: ModeCtx) {}

  enter() {
    this.ctx.setHint('');
    this.refresh();
  }

  exit() {
    this.ctx.showTimer(null);
  }

  refresh() {
    this.ctx.renderer.render({
      colorOf: () => 'gray',
      disableTooltip: true,
    });
  }

  hasProgress() {
    return false;
  }

  onSubmit() {}

  onUnitClick() {}

  onUnitDblClick(adcode: string) {
    const u = this.ctx.byAdcode.get(adcode);
    if (u) this.ctx.renderer.drillToProvince(u.provinceAdcode);
  }
}
