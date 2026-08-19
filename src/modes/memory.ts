import type { Mode } from '../types';
import type { ModeCtx, ModeController } from './types';

/** 记忆模式：全图显示所有地级市名称（白底标签），纯浏览、不交互 */
export class MemoryMode implements ModeController {
  id: Mode = 'memory';
  title = '记忆模式';

  constructor(private ctx: ModeCtx) {}

  enter() {
    this.ctx.setHint('纯浏览模式：查看全部地级市名称（标签位于区域中心），可自由缩放、双击区域进入该省');
    this.refresh();
  }

  exit() {}

  refresh() {
    this.ctx.renderer.render({
      colorOf: () => 'gray',
      showAllLabels: true,
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
