import type { Mode } from '../types';
import { BaseMode } from './baseMode';
import type { AdminPanel, AdminView } from '../ui/adminPanel';
import { t } from '../i18n';

/** 管理员模式：主区切换为管理面板（用户管理/日志记录/公告管理）。 */
export class AdminMode extends BaseMode {
  id: Mode = 'admin';
  title = t('mode.admin.title');

  private view: AdminView = 'users';

  constructor(private panel: AdminPanel, initialView: AdminView = 'users') {
    super();
    this.view = initialView;
  }

  /** 切换管理子视图（从下拉菜单进入时指定）。 */
  setView(view: AdminView) { this.view = view; }

  enter() { this.panel.show(this.view); }
  exit() { this.panel.hide(); }
  refresh() { /* 无地图渲染 */ }
  hasProgress() { return false; }
}