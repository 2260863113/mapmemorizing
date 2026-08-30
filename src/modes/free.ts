import type { Mode, UnitColor } from '../types';
import type { ModeCtx, ModeController } from './types';
import { t } from '../i18n';

/** 熟练度分析：按累计答题分数只读着色，不响应输入或点击。 */
export class FreeMode implements ModeController {
  id: Mode = 'free';
  title = t('mode.free.title');
  private unsubscribe: (() => void) | null = null;

  constructor(private ctx: ModeCtx) {}

  enter() {
    this.ctx.setHint('');
    this.refresh();
    this.unsubscribe = this.ctx.store.subscribe(() => this.refresh());
  }

  exit() {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  refresh() {
    this.ctx.renderer.render({
      colorOf: (adcode) => scoreColor(this.ctx.store.getPractice(adcode).score),
      disableTooltip: true,
    });
    this.ctx.stats.refresh(this.ctx.renderer.currentProvince());
  }

  hasProgress() {
    return false;
  }

  onSubmit() {}

  onInput() {}

  onUnitClick() {
    return true;
  }

  onUnitDblClick() {}
}

function scoreColor(score: number): UnitColor {
  if (score >= 5) return 'scoreGreenDark';
  if (score >= 3) return 'scoreGreenMedium';
  if (score >= 1) return 'scoreGreenLight';
  if (score <= -5) return 'scoreRedDark';
  if (score <= -3) return 'scoreRedMedium';
  if (score <= -1) return 'scoreRedLight';
  return 'gray';
}
