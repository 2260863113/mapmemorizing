import type { Mode, RoundResult } from '../types';
import type { ModeController } from './types';
import type { AdminPanel, AdminView } from '../ui/adminPanel';
import { t } from '../i18n';

/** 管理员模式：主区切换为管理面板（用户管理/日志记录/公告管理）。 */
export class AdminMode implements ModeController {
  id: Mode = 'admin';
  title = t('mode.admin.title');

  private view: AdminView = 'users';

  constructor(private panel: AdminPanel, initialView: AdminView = 'users') {
    this.view = initialView;
  }

  /** 切换管理子视图（从下拉菜单进入时指定）。 */
  setView(view: AdminView) {
    this.view = view;
  }

  enter() {
    this.panel.show(this.view);
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
