/**
 * 相机跟随的**钳制策略**（纯函数，有单测）。
 *
 * 与渲染器的分工：渲染器负责**测量**（`viewportWindow()` 把画布像素换算成数据坐标矩形与
 * 像素比、`framingExtent()` 给出取景边界），本模块只做**策略**——给定测量结果与目标点，
 * 算出镜头该去哪、要不要动。这样这套「跟随不再把目标顶到正中」的规则可以脱离 ECharts
 * 实例直接单测（`followClamp.test.ts`），也让 1800 行的 `MapRenderer` 少掉 5 个方法。
 *
 * 数字口径见 `FOLLOW_MARGIN_RATIO` 的注释；阈值推导见 docs/adr/0005 的「跟随钳制」一节。
 */
import { clampZoom } from './zoom';

/**
 * 跟随钳制用到的视口矩形：当前视口在**数据坐标系**下的范围 + 每像素度数 + 画布尺寸。
 *
 * 投影经 `boundingCoords` 钉死后 lng/lat → 像素是线性映射，故一张矩形足以描述。
 * `width`/`height` 是画布像素尺寸，用来算「短边的 10%」这个边距。
 */
export interface ViewportWindow {
  box: [number, number, number, number];
  perPxX: number;
  perPxY: number;
  width: number;
  height: number;
}

/**
 * 跟随钳制的边距比例：视口**短边**的 10%。
 *
 * 一个数同时承担三件事（见 `clampFollowCenter` / `isComfortablyVisible`）：
 *   1. 钳制时允许镜头偏离目标正中的上限；
 *   2. 目标正好落在取景边界上时被容忍的露白上限（推导：露白 ≤ m）；
 *   3. 只平移的跟随里判定「目标已舒适可见、无需移动」的距离阈值。
 */
export const FOLLOW_MARGIN_RATIO = 0.1;

/**
 * 单轴跟随钳制（纯函数，便于单测）：`clamp( clamp(t, min+hw, max−hw), t−(hw−m), t+(hw−m) )`。
 *
 * @param t    目标坐标（lng 或 lat）
 * @param span 该轴视口跨度（数据单位，目标倍率下）
 * @param m    边距（数据单位，目标倍率下）
 * @param min  取景边界下界
 * @param max  取景边界上界
 */
export function clampFollowAxis(t: number, span: number, m: number, min: number, max: number): number {
  const hw = Math.max(span, 0) / 2;
  const lo = min + hw;
  const hi = max - hw;
  // 内层：视口不越出取景边界；边界比视口还小时（区间为空）退化为边界中心
  const inner = lo > hi ? (min + max) / 2 : Math.min(hi, Math.max(lo, t));
  // 外层：目标离屏幕边至少 m；与内层冲突时让步（允许 ≤ m 的露白）
  const slack = Math.max(hw - m, 0);
  return Math.min(t + slack, Math.max(t - slack, inner));
}

/**
 * 把目标点钳制成镜头中心。
 *
 * `zoom` 是**目标倍率**（要与 `currentZoom` 区分：视口跨度要按倍率比例换算过去）。
 * 视口不可测（geo 未就绪）时原样返回目标点，调用方按「未钳制」处理。
 */
export function clampFollowCenter(
  win: ViewportWindow | null,
  currentZoom: number,
  target: [number, number],
  zoom: number,
  extent: [number, number, number, number],
): [number, number] {
  if (!win) return [target[0], target[1]];
  const k = currentZoom / Math.max(zoom, 1e-6); // 当前倍率下的视口跨度 → 目标倍率下的跨度
  const spanX = (win.box[2] - win.box[0]) * k;
  const spanY = (win.box[3] - win.box[1]) * k;
  const marginPx = Math.min(win.width, win.height) * FOLLOW_MARGIN_RATIO;
  const marginX = marginPx * win.perPxX * k;
  const marginY = marginPx * win.perPxY * k;
  return [
    clampFollowAxis(target[0], spanX, marginX, extent[0], extent[2]),
    clampFollowAxis(target[1], spanY, marginY, extent[1], extent[3]),
  ];
}

/**
 * 跟随倍率的**下限**：取景边界必须覆盖视口，否则无论怎么摆中心都会露白。
 *
 * 只抬高不压低：全国/世界/大洲档算出来约 1.25x，低于梯子最低档（世界 3x、中国 6x 起），
 * 故这些档位不受影响；真正生效的是**下钻后的小省**（宁夏 12x → 约 22x），
 * 夹在 [MIN_ZOOM, MAX_ZOOM] 内 —— 边界比 28x 视口还小的极小范围仍会留白，属固有代价。
 */
export function followZoomFloor(
  win: ViewportWindow | null,
  currentZoom: number,
  extent: [number, number, number, number],
  zoom: number,
): number {
  if (!win) return clampZoom(zoom);
  // 该轴跨度 × 当前倍率 = 1x 时的跨度；它除以边界跨度即「覆盖视口所需倍率」
  const extW = Math.max(extent[2] - extent[0], 1e-6);
  const extH = Math.max(extent[3] - extent[1], 1e-6);
  const needX = ((win.box[2] - win.box[0]) * currentZoom) / extW;
  const needY = ((win.box[3] - win.box[1]) * currentZoom) / extH;
  return clampZoom(Math.max(zoom, needX, needY));
}

/** 目标是否已「舒适可见」：在视口内且距四边 ≥ 边距 m（只平移的跟随用它决定动不动）。 */
export function isComfortablyVisible(win: ViewportWindow | null, p: [number, number]): boolean {
  if (!win) return false;
  const marginPx = Math.min(win.width, win.height) * FOLLOW_MARGIN_RATIO;
  const mX = marginPx * win.perPxX;
  const mY = marginPx * win.perPxY;
  return (
    p[0] >= win.box[0] + mX && p[0] <= win.box[2] - mX && p[1] >= win.box[1] + mY && p[1] <= win.box[3] - mY
  );
}

/** 钳制后与当前镜头几乎重合（<1px）→ 不值得跑那 650ms 动画。 */
export function isNegligibleMove(
  win: ViewportWindow | null,
  currentCenter: [number, number],
  currentZoom: number,
  center: [number, number],
  zoom: number,
): boolean {
  if (!win) return false;
  const k = currentZoom / Math.max(zoom, 1e-6);
  const dx = (Math.abs(center[0] - currentCenter[0]) * k) / Math.max(win.perPxX, 1e-9);
  const dy = (Math.abs(center[1] - currentCenter[1]) * k) / Math.max(win.perPxY, 1e-9);
  return dx < 1 && dy < 1;
}
