import type { Mode } from '../types';
import { BaseMode } from './baseMode';
import type { BoardPanel } from '../ui/boardPanel';
import { t } from '../i18n';

/** 留言板模式：主区切换为发帖/回复视图，不涉及地图交互。 */
export class BoardMode extends BaseMode {
  id: Mode = 'board';
  title = t('mode.board.title');

  constructor(private panel: BoardPanel) { super(); }

  enter() { void this.panel.show(); }
  exit() { this.panel.hide(); }
  refresh() { /* 无地图渲染 */ }
  hasProgress() { return false; }
}