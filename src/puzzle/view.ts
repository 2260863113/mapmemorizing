/**
 * 拼图画布视图：SVG 渲染 + 指针拖拽 + 缩放平移 + 左侧卡槽。
 *
 * 为什么不是 ECharts：见 docs/adr/0006。简述——geo 无法给单个 region 独立的平移，
 * 全仓也没有任何 `draggable`/`graphic` 拖拽先例；而这里要的正是"每片可自由平移、
 * 成组后整体平移、靠 DOM 命中"，正好是 SVG + `<g transform>` 的强项。
 *
 * 坐标：`<path>` 的 `d` 用**真值投影**（碎片在正确位置时的拼图 px），
 * 用户拖动只改 `<g class="puzzle-group">` 的 `translate(dx,dy)` —— 与 `PuzzleState` 一一对应。
 *
 * 指针事件统一挂在容器 `#puzzle` 上（槽与画布都是它的子节点）：槽上按下要捕获指针才能拿到
 * 后续 move/up，而捕获目标取同一个容器最省事。
 */
import { PUZZLE_SPAN_LNG, pxBBoxOf, project, svgPathOf } from './projection';
import { PuzzleState, type DropResult } from './state';

export interface PuzzleThemeColors {
  fill: string;
  stroke: string;
  label: string;
  halo: string;
}

export interface PuzzleViewOptions {
  container: HTMLElement;
  state: PuzzleState;
  /** 1x 时的每经度像素数（随视口宽度变化，由模式计算）。 */
  baseScale: () => number;
  /** 是否显示省名（简单档）。 */
  labels: () => boolean;
  theme: () => PuzzleThemeColors;
  /** 一次"放下"处理完（含吸附结果）后回调：刷新进度、判定获胜。 */
  onDrop?: (result: DropResult) => void;
  toast: (msg: string) => void;
}

export const MIN_ZOOM = 0.6;
export const MAX_ZOOM = 6;

interface SlotPointer {
  pointerId: number;
  adcode: string;
  moved: boolean;
  startX: number;
  startY: number;
}

export class PuzzleView {
  private svg: SVGSVGElement | null = null;
  private world: SVGGElement | null = null;
  private slotsEl: HTMLElement | null = null;
  private ghost: SVGGElement | null = null;
  private paths = new Map<string, SVGPathElement>();
  private labelEls = new Map<string, SVGTextElement>();
  private builtScale = 0;
  private zoom = 1;
  private panX = 0;
  private panY = 0;
  private enabled = true;

  private dragGroupId: number | null = null;
  private dragStart = { x: 0, y: 0, dx: 0, dy: 0 };
  private dragMoved = false;
  private panPointerId: number | null = null;
  private panStart = { x: 0, y: 0, panX: 0, panY: 0 };
  private slotPointer: SlotPointer | null = null;
  private selectedAdcode: string | null = null;
  private resizeObserver: ResizeObserver | null = null;

  constructor(private opts: PuzzleViewOptions) {}

  // ==================== 生命周期 ====================

  mount(): void {
    const { container } = this.opts;
    container.innerHTML = '';
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('class', 'puzzle-canvas');
    const world = document.createElementNS(ns, 'g');
    world.setAttribute('class', 'puzzle-world');
    svg.appendChild(world);
    container.appendChild(svg);
    const slots = document.createElement('div');
    slots.className = 'puzzle-slots';
    container.appendChild(slots);

    this.svg = svg;
    this.world = world;
    this.slotsEl = slots;
    this.paths.clear();
    this.labelEls.clear();
    this.builtScale = 0;
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.selectedAdcode = null;

    container.addEventListener('pointerdown', this.onPointerDown);
    container.addEventListener('pointermove', this.onPointerMove);
    container.addEventListener('pointerup', this.onPointerUp);
    container.addEventListener('pointercancel', this.onPointerUp);
    container.addEventListener('wheel', this.onWheel, { passive: false });
    container.addEventListener('dblclick', this.onDblClick);
    window.addEventListener('keydown', this.onKeyDown);
    // 容器从 display:none 变可见、侧栏开合、窗口缩放都会触发 —— 基比例依赖容器宽度，必须跟着重算
    this.resizeObserver = new ResizeObserver(() => this.refreshScale());
    this.resizeObserver.observe(container);

    this.ensurePieces();
    this.renderStructure();
    this.renderSlots();
    this.applyTransform();
  }

  unmount(): void {
    const { container } = this.opts;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    container.removeEventListener('pointerdown', this.onPointerDown);
    container.removeEventListener('pointermove', this.onPointerMove);
    container.removeEventListener('pointerup', this.onPointerUp);
    container.removeEventListener('pointercancel', this.onPointerUp);
    container.removeEventListener('wheel', this.onWheel);
    container.removeEventListener('dblclick', this.onDblClick);
    window.removeEventListener('keydown', this.onKeyDown);
    container.innerHTML = '';
    this.svg = null;
    this.world = null;
    this.slotsEl = null;
    this.paths.clear();
    this.labelEls.clear();
  }

  /** 视口尺寸变化后调用：基比例变了 → 重算 path/槽预览。 */
  refreshScale(): void {
    if (!this.svg) return;
    this.ensurePieces(true);
    this.renderSlots();
    this.applyTransform();
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) this.cancelInteraction();
    this.svg?.classList.toggle('puzzle-disabled', !on);
  }

  private get baseScale(): number {
    return this.opts.baseScale();
  }

  // ==================== 渲染 ====================

  private ensurePieces(force = false): void {
    const scale = this.baseScale;
    if (!force && Math.abs(scale - this.builtScale) < 0.01 && this.paths.size) return;
    const ns = 'http://www.w3.org/2000/svg';
    for (const adcode of this.opts.state.adcodes()) {
      const def = this.opts.state.def(adcode);
      if (!def) continue;
      let path = this.paths.get(adcode);
      if (!path) {
        path = document.createElementNS(ns, 'path');
        path.setAttribute('class', 'puzzle-piece');
        path.setAttribute('data-adcode', adcode);
        path.setAttribute('fill-rule', 'evenodd');
        this.paths.set(adcode, path);
      }
      path.setAttribute('d', svgPathOf(def.polygons, scale));

      let label = this.labelEls.get(adcode);
      if (!label) {
        label = document.createElementNS(ns, 'text');
        label.setAttribute('class', 'puzzle-label');
        label.setAttribute('text-anchor', 'middle');
        label.setAttribute('dominant-baseline', 'middle');
        this.labelEls.set(adcode, label);
      }
      label.textContent = def.label;
      const [lx, ly] = project(def.labelAnchor, scale);
      label.setAttribute('x', lx.toFixed(1));
      label.setAttribute('y', ly.toFixed(1));
    }
    this.builtScale = scale;
  }

  /** 按 state 重建组结构（组 → 片 + 标签），复用已生成的 path/标签元素。 */
  renderStructure(): void {
    const world = this.world;
    if (!world) return;
    world.innerHTML = '';
    this.ghost = null;
    const colors = this.opts.theme();
    const showLabels = this.opts.labels();
    for (const group of this.opts.state.groups) {
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.setAttribute('class', 'puzzle-group');
      g.setAttribute('data-group', String(group.id));
      g.setAttribute('transform', `translate(${group.dx.toFixed(2)} ${group.dy.toFixed(2)})`);
      for (const adcode of group.pieces) {
        const path = this.paths.get(adcode);
        if (path) {
          path.setAttribute('fill', colors.fill);
          path.setAttribute('stroke', colors.stroke);
          g.appendChild(path);
        }
        const label = this.labelEls.get(adcode);
        if (label && showLabels) {
          label.setAttribute('fill', colors.label);
          label.setAttribute('stroke', colors.halo);
          g.appendChild(label);
        }
      }
      world.appendChild(g);
    }
    if (this.selectedAdcode) this.updateGhost(this.selectedAdcode, this.lastClient.x, this.lastClient.y);
    this.applyTransform();
  }

  /** 只刷新配色与标签显隐（难度切换 / 主题切换 / 边界深浅变化）。 */
  refreshStyle(): void {
    this.renderStructure();
    this.renderSlots();
  }

  private renderSlots(): void {
    const slots = this.slotsEl;
    if (!slots) return;
    const scale = this.baseScale;
    const showLabels = this.opts.labels();
    const colors = this.opts.theme();
    slots.innerHTML = '';
    for (const adcode of this.opts.state.slots) {
      const def = this.opts.state.def(adcode);
      if (!def) continue;
      const slot = document.createElement('div');
      slot.className = 'puzzle-slot';
      slot.dataset.adcode = adcode;
      slot.title = def.name;
      const bbox = pxBBoxOf(def.polygons, scale);
      const w = Math.max(bbox[2] - bbox[0], 1e-6);
      const h = Math.max(bbox[3] - bbox[1], 1e-6);
      const pad = 1 / 0.78; // 预览最长边占槽 78%
      const cx = (bbox[0] + bbox[2]) / 2;
      const cy = (bbox[1] + bbox[3]) / 2;
      const mini = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      mini.setAttribute('class', 'puzzle-slot-preview');
      mini.setAttribute('viewBox', `${(cx - (w * pad) / 2).toFixed(1)} ${(cy - (h * pad) / 2).toFixed(1)} ${(w * pad).toFixed(1)} ${(h * pad).toFixed(1)}`);
      mini.setAttribute('preserveAspectRatio', 'xMidYMid meet');
      const miniPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      miniPath.setAttribute('d', svgPathOf(def.polygons, scale));
      miniPath.setAttribute('fill', colors.fill);
      miniPath.setAttribute('stroke', colors.stroke);
      miniPath.setAttribute('stroke-width', String(Math.max(w, h) / 220));
      miniPath.setAttribute('fill-rule', 'evenodd');
      mini.appendChild(miniPath);
      slot.appendChild(mini);
      if (showLabels) {
        const cap = document.createElement('div');
        cap.className = 'puzzle-slot-name';
        cap.textContent = def.label;
        slot.appendChild(cap);
      }
      slots.appendChild(slot);
    }
    slots.classList.toggle('hidden', this.opts.state.slots.length === 0);
  }

  private applyTransform(): void {
    if (!this.world || !this.svg) return;
    this.world.setAttribute('transform', `translate(${this.panX.toFixed(2)} ${this.panY.toFixed(2)}) scale(${this.zoom})`);
    this.svg.style.setProperty('--pz', String(this.zoom));
  }

  private toWorld(clientX: number, clientY: number): [number, number] {
    const rect = this.svg!.getBoundingClientRect();
    return [(clientX - rect.left - this.panX) / this.zoom, (clientY - rect.top - this.panY) / this.zoom];
  }

  // ==================== 交互 ====================

  private lastClient = { x: 0, y: 0 };

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !this.selectedAdcode) return;
    this.selectedAdcode = null;
    this.updateGhost(null, 0, 0);
  };

  private onPointerDown = (e: PointerEvent) => {
    if (!this.enabled) return;
    this.lastClient = { x: e.clientX, y: e.clientY };
    const target = e.target as Element | null;

    const slot = target?.closest?.('.puzzle-slot') as HTMLElement | null;
    if (slot?.dataset.adcode) {
      e.preventDefault();
      this.opts.container.setPointerCapture?.(e.pointerId);
      if (this.selectedAdcode === slot.dataset.adcode) {
        this.selectedAdcode = null;
        this.updateGhost(null, 0, 0);
        return;
      }
      this.slotPointer = {
        pointerId: e.pointerId,
        adcode: slot.dataset.adcode,
        moved: false,
        startX: e.clientX,
        startY: e.clientY,
      };
      return;
    }

    const pieceEl = target?.closest?.('.puzzle-piece') as SVGPathElement | null;
    if (pieceEl) {
      const adcode = pieceEl.getAttribute('data-adcode') ?? '';
      const group = this.opts.state.groupOf(adcode);
      if (!group) return;
      e.preventDefault();
      this.opts.container.setPointerCapture?.(e.pointerId);
      this.dragGroupId = group.id;
      this.dragStart = { x: e.clientX, y: e.clientY, dx: group.dx, dy: group.dy };
      this.dragMoved = false;
      return;
    }

    if (this.selectedAdcode) {
      // 点选模式：点空白处放下
      e.preventDefault();
      this.placeSelectedAt(e.clientX, e.clientY);
      return;
    }
    e.preventDefault();
    this.opts.container.setPointerCapture?.(e.pointerId);
    this.panPointerId = e.pointerId;
    this.panStart = { x: e.clientX, y: e.clientY, panX: this.panX, panY: this.panY };
  };

  private onPointerMove = (e: PointerEvent) => {
    if (!this.enabled) return;
    this.lastClient = { x: e.clientX, y: e.clientY };

    if (this.panPointerId === e.pointerId) {
      this.panX = this.panStart.panX + (e.clientX - this.panStart.x);
      this.panY = this.panStart.panY + (e.clientY - this.panStart.y);
      this.applyTransform();
      return;
    }

    const sp = this.slotPointer;
    if (sp && sp.pointerId === e.pointerId) {
      if (!sp.moved && Math.hypot(e.clientX - sp.startX, e.clientY - sp.startY) > 4) {
        sp.moved = true;
        this.beginDragFromSlot(sp.adcode, e.clientX, e.clientY);
      }
      if (sp.moved) this.dragMoveTo(e.clientX, e.clientY);
      return;
    }

    if (this.dragGroupId !== null) {
      this.dragMoveTo(e.clientX, e.clientY);
      return;
    }
    if (this.selectedAdcode) this.updateGhost(this.selectedAdcode, e.clientX, e.clientY);
  };

  private onPointerUp = (e: PointerEvent) => {
    const sp = this.slotPointer;
    if (sp && sp.pointerId === e.pointerId) {
      this.slotPointer = null;
      if (!sp.moved) {
        // 槽上"按下即抬起"= 点选：碎片留槽，出现跟随光标的半透明预览
        this.selectedAdcode = sp.adcode;
        this.updateGhost(sp.adcode, e.clientX, e.clientY);
        return;
      }
      this.finishDrag();
      return;
    }
    if (this.panPointerId === e.pointerId) {
      this.panPointerId = null;
      this.releaseCapture(e.pointerId);
      return;
    }
    if (this.dragGroupId !== null) this.finishDrag();
  };

  private releaseCapture(pointerId: number): void {
    if (this.opts.container.hasPointerCapture?.(pointerId)) this.opts.container.releasePointerCapture(pointerId);
  }

  /** 从卡槽拿起：立刻在画布上生成该片并跟随指针。 */
  private beginDragFromSlot(adcode: string, clientX: number, clientY: number): void {
    const state = this.opts.state;
    const group = state.take(adcode);
    if (!group) return;
    const def = state.def(adcode);
    const scale = this.baseScale;
    const [wx, wy] = this.toWorld(clientX, clientY);
    const origin = def ? project(def.origin, scale) : [0, 0];
    state.moveGroup(group.id, wx - origin[0], wy - origin[1]);
    this.dragGroupId = group.id;
    this.dragStart = { x: clientX, y: clientY, dx: group.dx, dy: group.dy };
    this.dragMoved = true;
    this.renderStructure();
    this.renderSlots();
  }

  private dragMoveTo(clientX: number, clientY: number): void {
    if (this.dragGroupId === null) return;
    const dx = this.dragStart.dx + (clientX - this.dragStart.x) / this.zoom;
    const dy = this.dragStart.dy + (clientY - this.dragStart.y) / this.zoom;
    this.opts.state.moveGroup(this.dragGroupId, dx, dy);
    this.applyGroupTransform(this.dragGroupId);
    this.highlightCandidates(this.dragGroupId);
    this.dragMoved = true;
  }

  private finishDrag(): void {
    const id = this.dragGroupId;
    this.dragGroupId = null;
    this.slotPointer = null;
    this.clearHighlights();
    if (id === null) return;
    if (!this.dragMoved) return; // 只是点了一下碎片
    const result = this.opts.state.drop(id);
    this.renderStructure();
    this.renderSlots();
    this.opts.onDrop?.(result);
  }

  private cancelInteraction(): void {
    this.dragGroupId = null;
    this.slotPointer = null;
    this.panPointerId = null;
    this.selectedAdcode = null;
    this.clearHighlights();
    this.updateGhost(null, 0, 0);
  }

  private onWheel = (e: WheelEvent) => {
    if (!this.enabled || !this.svg) return;
    e.preventDefault();
    const rect = this.svg.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const before = this.toWorld(e.clientX, e.clientY);
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.zoom * factor));
    if (next === this.zoom) return;
    this.zoom = next;
    // 以光标为锚点：该点在世界坐标下保持不动
    this.panX = px - before[0] * this.zoom;
    this.panY = py - before[1] * this.zoom;
    this.applyTransform();
  };

  private onDblClick = (e: MouseEvent) => {
    if (!this.enabled) return;
    const target = e.target as Element | null;
    if (target?.closest?.('.puzzle-piece') || target?.closest?.('.puzzle-slot')) return;
    this.resetView();
  };

  /** 回到默认视角：整幅中国约占视口宽 1.15 倍（略大于视口）。 */
  resetView(): void {
    this.zoom = 1;
    const width = PUZZLE_SPAN_LNG * this.baseScale;
    const rect = this.svg?.getBoundingClientRect();
    const viewW = rect?.width ?? 0;
    const viewH = rect?.height ?? 0;
    this.panX = (viewW - width) / 2;
    this.panY = viewH * 0.08;
    this.applyTransform();
  }

  /** 缩放到"刚好装下整幅拼图"并居中（获胜时用）。 */
  fitAll(padding = 56, animate = true, opts: { includeSeaIslets?: boolean; minZoom?: number } = {}): void {
    if (!this.svg) return;
    const state = this.opts.state;
    const scale = this.baseScale;
    const includeIslets = opts.includeSeaIslets === true;
    const minZoom = opts.minZoom ?? MIN_ZOOM;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const include = (box: [number, number, number, number], dx: number, dy: number) => {
      minX = Math.min(minX, box[0] + dx);
      minY = Math.min(minY, box[1] + dy);
      maxX = Math.max(maxX, box[2] + dx);
      maxY = Math.max(maxY, box[3] + dy);
    };
    for (const group of state.groups) {
      for (const adcode of group.pieces) {
        const def = state.def(adcode);
        if (!def) continue;
        include(pxBBoxOf(def.polygons, scale), group.dx, group.dy);
        // 获胜时把刚补上的远海岛礁（三沙）也算进取景，否则它们会落在视口外看不见
        if (includeIslets && def.seaIslets.length) include(pxBBoxOf(def.seaIslets, scale), group.dx, group.dy);
      }
    }
    if (!Number.isFinite(minX)) return;
    const rect = this.svg.getBoundingClientRect();
    const w = Math.max(maxX - minX, 1);
    const h = Math.max(maxY - minY, 1);
    const zoom = Math.min(MAX_ZOOM, Math.max(minZoom, Math.min((rect.width - padding * 2) / w, (rect.height - padding * 2) / h)));
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const target = { zoom, panX: rect.width / 2 - cx * zoom, panY: rect.height / 2 - cy * zoom };
    if (!animate) {
      this.zoom = target.zoom;
      this.panX = target.panX;
      this.panY = target.panY;
      this.applyTransform();
      return;
    }
    this.animateTo(target, 420);
  }

  private animateTo(target: { zoom: number; panX: number; panY: number }, ms: number): void {
    const from = { zoom: this.zoom, panX: this.panX, panY: this.panY };
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / ms);
      const k = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      this.zoom = from.zoom + (target.zoom - from.zoom) * k;
      this.panX = from.panX + (target.panX - from.panX) * k;
      this.panY = from.panY + (target.panY - from.panY) * k;
      this.applyTransform();
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /** 获胜展示：补上远海岛礁（淡入），归入其所属组。 */
  revealSeaIslets(): void {
    const world = this.world;
    if (!world) return;
    const colors = this.opts.theme();
    const scale = this.baseScale;
    for (const group of this.opts.state.groups) {
      for (const adcode of group.pieces) {
        const def = this.opts.state.def(adcode);
        if (!def || !def.seaIslets.length) continue;
        const g = world.querySelector(`g[data-group="${group.id}"]`);
        if (!g) continue;
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('class', 'puzzle-piece puzzle-sea-islets');
        path.setAttribute('d', svgPathOf(def.seaIslets, scale));
        path.setAttribute('fill', colors.fill);
        path.setAttribute('stroke', colors.stroke);
        path.setAttribute('fill-rule', 'evenodd');
        g.insertBefore(path, g.firstChild);
      }
    }
  }

  // ==================== 拖动中的辅助渲染 ====================

  private applyGroupTransform(groupId: number): void {
    const group = this.opts.state.groups.find((g) => g.id === groupId);
    const g = this.world?.querySelector(`g[data-group="${groupId}"]`);
    if (!group || !g) return;
    g.setAttribute('transform', `translate(${group.dx.toFixed(2)} ${group.dy.toFixed(2)})`);
  }

  private highlightCandidates(groupId: number): void {
    this.clearHighlights();
    for (const candidate of this.opts.state.snapCandidates(groupId)) {
      this.world?.querySelector(`g[data-group="${candidate.id}"]`)?.classList.add('can-snap');
    }
  }

  private clearHighlights(): void {
    this.world?.querySelectorAll('g.can-snap').forEach((g) => g.classList.remove('can-snap'));
  }

  private updateGhost(adcode: string | null, clientX: number, clientY: number): void {
    const world = this.world;
    if (!world) return;
    if (!adcode) {
      this.ghost?.remove();
      this.ghost = null;
      return;
    }
    const def = this.opts.state.def(adcode);
    if (!def) return;
    const scale = this.baseScale;
    if (!this.ghost) {
      const colors = this.opts.theme();
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.setAttribute('class', 'puzzle-ghost');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', svgPathOf(def.polygons, scale));
      path.setAttribute('fill', colors.fill);
      path.setAttribute('stroke', colors.stroke);
      path.setAttribute('fill-rule', 'evenodd');
      g.appendChild(path);
      world.appendChild(g);
      this.ghost = g;
    }
    const [wx, wy] = this.toWorld(clientX, clientY);
    const origin = project(def.origin, scale);
    this.ghost.setAttribute('transform', `translate(${(wx - origin[0]).toFixed(2)} ${(wy - origin[1]).toFixed(2)})`);
  }

  /** 点选模式下点击画布：把选中的片放到这里。 */
  private placeSelectedAt(clientX: number, clientY: number): void {
    const adcode = this.selectedAdcode;
    if (!adcode) return;
    this.selectedAdcode = null;
    this.updateGhost(null, 0, 0);
    this.beginDragFromSlot(adcode, clientX, clientY);
    this.finishDrag();
  }

  /** 只读快照（探针用）。 */
  debugState(): { zoom: number; pan: [number, number]; selected: string | null; panning: boolean; dragging: number | null } {
    return {
      zoom: Number(this.zoom.toFixed(3)),
      pan: [Math.round(this.panX), Math.round(this.panY)],
      selected: this.selectedAdcode,
      panning: this.panPointerId !== null,
      dragging: this.dragGroupId,
    };
  }
}
