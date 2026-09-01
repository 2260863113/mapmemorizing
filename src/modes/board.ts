import type { Mode, RoundResult } from '../types';
import type { ModeController } from './types';
import type { BoardPanel } from '../ui/boardPanel';
import { t } from '../i18n';

/** 留言板模式：主区切换为发帖/回复视图，不涉及地图交互。 */
export class BoardMode implements ModeController {
  id: Mode = 'board';
  title = t('mode.board.title');

  constructor(private panel: BoardPanel) {}

  enter() {
    void this.panel.show();
  }

  exit() {
    this.panel.hide();
  }

  refresh() {
    /* 无地图渲染 */
  }

  onSubmit() {
    /* 无输入作答 */
  }

  onInput() {
    /* 无输入联想 */
  }

  onUnitClick() {
    return false;
  }

  onUnitDblClick() {
    /* 无地图交互 */
  }

  onUnitHover() {
    /* 无悬停统计 */
  }

  onUnitHoverEnd() {
    /* 无悬停统计 */
  }

  onSkip() {
    /* 无作答 */
  }

  onEnd() {
    /* 无作答 */
  }

  onReset() {
    /* 无进度 */
  }

  onViewChange() {
    /* 无地图视图 */
  }

  pause() {
    /* 无计时 */
  }

  resume() {
    /* 无计时 */
  }

  isPaused() {
    return false;
  }

  getProgress() {
    return null;
  }

  getScopeProvince() {
    return null;
  }

  collectResult(): RoundResult | null {
    return null;
  }

  hasProgress() {
    return false;
  }

  isStarted() {
    return false;
  }
}
