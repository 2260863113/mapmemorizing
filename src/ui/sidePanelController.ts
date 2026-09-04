const KEY = 'china-admin-leaderboard-panel-v2';
const MIN_WIDTH = 240;
const MAX_WIDTH = 420;
const DEFAULT_WIDTH = 300;

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function loadOpen() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return true; // 首次进入默认打开排行榜侧边栏
    return JSON.parse(raw)?.open !== false;
  } catch {
    return true;
  }
}

function loadWidth() {
  try {
    const raw = localStorage.getItem(KEY);
    const width = raw ? Number(JSON.parse(raw)?.width) : DEFAULT_WIDTH;
    return clamp(width, MIN_WIDTH, MAX_WIDTH);
  } catch {
    return DEFAULT_WIDTH;
  }
}

function save(open: boolean, width: number) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ open, width }));
  } catch {
    /* 忽略存储失败 */
  }
}

interface DragState {
  pointerId: number;
  x: number;
  width: number;
  moved: boolean;
  wasOpen: boolean;
}

/**
 * 侧边栏状态控制器：排行榜侧栏的开关/宽度持久化，以及拖拽调宽手势状态机。
 * 侧栏分两种「打开」含义：熟练度分析(stats)与排行榜(leaderboard)，由 isAnalysis 区分；
 * 只有排行榜侧的 open/width 会被持久化。DOM 类名切换仍由 syncModeChrome 负责，
 * 这里只持有状态与持久化，避免状态散落在 boot 闭包里。
 */
export class SidePanelController {
  private leaderboardOpen = loadOpen();
  private widthPx = loadWidth();
  private statsOpen = true; // 熟练度分析侧栏开合（不持久化）
  private drag: DragState | null = null;
  private suppressClick = false;

  constructor(private el: HTMLElement, private toggleEl: HTMLButtonElement) {
    this.el.style.setProperty('--side-panel-width', `${this.widthPx}px`);
  }

  /** 当前侧栏是否打开（按侧栏类型）。 */
  isOpen(isAnalysis: boolean): boolean {
    return isAnalysis ? this.statsOpen : this.leaderboardOpen;
  }

  /** 切换侧栏开合；返回切换后的开合状态。 */
  toggle(isAnalysis: boolean): boolean {
    if (isAnalysis) {
      this.statsOpen = !this.statsOpen;
      return this.statsOpen;
    }
    this.leaderboardOpen = !this.leaderboardOpen;
    save(this.leaderboardOpen, this.widthPx);
    return this.leaderboardOpen;
  }

  /** 开始拖拽（记录起点）。 */
  beginDrag(pointerId: number, x: number, isAnalysis: boolean) {
    this.drag = { pointerId, x, width: this.widthPx, moved: false, wasOpen: this.isOpen(isAnalysis) };
    this.toggleEl.setPointerCapture(pointerId);
  }

  /** 拖拽中：按位移计算新宽度，拖拽时强制侧栏打开。 */
  moveDrag(pointerId: number, x: number, isAnalysis: boolean) {
    if (!this.drag || this.drag.pointerId !== pointerId) return;
    const nextWidth = clamp(this.drag.width - (x - this.drag.x), MIN_WIDTH, MAX_WIDTH);
    if (Math.abs(nextWidth - this.drag.width) > 4) this.drag.moved = true;
    if (isAnalysis) this.statsOpen = true;
    else this.leaderboardOpen = true;
    this.setWidth(nextWidth);
  }

  /** 结束拖拽：结算是否抑制随后的 click。 */
  endDrag(pointerId: number, isAnalysis: boolean) {
    if (!this.drag || this.drag.pointerId !== pointerId) return;
    const drag = this.drag;
    const panelOpen = this.isOpen(isAnalysis);
    this.suppressClick = drag.moved || (!drag.wasOpen && panelOpen);
    this.drag = null;
    if (this.toggleEl.hasPointerCapture(pointerId)) this.toggleEl.releasePointerCapture(pointerId);
  }

  /** 消费「抑制本次 click」标记（拖拽结束后吞掉一次误触点击）。 */
  consumeSuppressClick(): boolean {
    if (!this.suppressClick) return false;
    this.suppressClick = false;
    return true;
  }

  private setWidth(width: number) {
    this.widthPx = clamp(width, MIN_WIDTH, MAX_WIDTH);
    this.el.style.setProperty('--side-panel-width', `${this.widthPx}px`);
    save(this.leaderboardOpen, this.widthPx);
  }
}