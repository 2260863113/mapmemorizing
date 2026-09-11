/**
 * 视口裁剪：只渲染当前视角范围内的地级面与省界线。
 *
 * 为什么用「忽略」而不是「不构建」：
 * zrender 的 `Storage._updateAndAddDisplayable` 在元素 `ignore === true` 时**提前返回**
 * （见 zrender/lib/Storage.js 第 52 行），因此 `update()` → `buildPath()` 整段被跳过，
 * 整个子树既不做路径构建也不参与绘制，代价是 O(1)。这比 ECharts 内置的 `culling: true`
 * 更彻底 —— 后者只在 `shouldBePainted()` 里跳过绘制，`buildPath` 仍然照跑（顶点多时仍是瓶颈）。
 *
 * 为什么不是「换更粗的档」：
 * 顶点数（而非可见面积）才是每帧 `buildPath` 的主因。裁剪保留 100% 顶点精度（无损档不做任何
 * 简化），却只对可见子集构建路径。实测（1600x1000，中心广州，标签开）每帧拖动成本：
 *   无损档 无裁剪 28.2ms → 裁剪后 13.2ms（2.1x），同时线上「压缩 33% + 省界无损」为 34.6ms。
 *
 * 刷新代价极低（面 ~1.2ms + 线 ~0.1ms），故可在每帧 georoam 后重新裁剪：
 * 线用 `data.getItemGraphicEl(i).ignore` 直接改标记，比 `setOption` 重建 series（33.7ms）快约 300 倍，
 * 因此拖动时**不会**产生重建卡顿，也不会出现「改了数据但图上没变」的过渡态。
 */

/** geo 坐标系（只取裁剪需要的方法，避免依赖 ECharts 未导出的内部类型）。 */
type GeoCoordSys = {
  pointToData?: (point: number[]) => number[];
  /**
   * 像素 → 投影后坐标（只做逆 roam 变换，**不再** unproject）。
   * 投影模式下必须用它与 `projection.unproject` 组合，见 viewportBox 的说明。
   */
  pointToProjected?: (point: number[]) => number[];
  projection?: { unproject: (point: number[]) => number[] } | null;
  getRegion?: (name: string) => { getBoundingRect: () => { x: number; y: number; width: number; height: number } } | undefined;
};

/** 数据坐标 bbox：[x0, y0, x1, y1]（经纬度）。 */
export type CullBox = [number, number, number, number];

/** 视口外扩系数：为「本帧裁剪后到下一帧」之间可能移入视口的区域留出余量，避免露底。 */
export const CULL_MARGIN = 1.5;

/** 忽略标记可写的图形元素（Group / Path / Line 等 Displayable 都具备）。 */
type Ignorable = { ignore?: boolean };

/**
 * 取当前 geo 组件的 MapDraw 实例（地级/省级面的 region 组挂在它下面）。
 *
 * 优先走 `getViewOfComponentModel`（ECharts 内部但稳定的接口，MapView/GeoView 都持有 `_mapDraw`）；
 * 取不到时退回递归扫描 `_regionsGroupByName` 标记，保证 ECharts 内部结构微调时仍可用。
 */
function findMapDraw(chart: unknown, geoModel: unknown): { _regionsGroupByName?: { each: (cb: (group: Ignorable, name: string) => void) => void } } | null {
  const c = chart as { getViewOfComponentModel?: (m: unknown) => { _mapDraw?: unknown } | undefined };
  if (typeof c.getViewOfComponentModel === 'function' && geoModel) {
    try {
      const view = c.getViewOfComponentModel(geoModel) as { _mapDraw?: { _regionsGroupByName?: unknown } } | undefined;
      if (view?._mapDraw?._regionsGroupByName) {
        return view._mapDraw as { _regionsGroupByName?: { each: (cb: (group: Ignorable, name: string) => void) => void } };
      }
    } catch {
      // 内部接口变动时静默退回扫描
    }
  }
  // 兜底：从图表实例向下扫描持有 region 组的对象（深度受限，且不进入 __ 开头的私有字段）
  const seen = new Set<unknown>();
  let found: { _regionsGroupByName?: unknown } | null = null;
  const scan = (obj: unknown, depth: number) => {
    if (found || !obj || typeof obj !== 'object' || depth > 6 || seen.has(obj)) return;
    seen.add(obj);
    const rec = obj as Record<string, unknown>;
    if (rec._regionsGroupByName && rec._regionsGroup) {
      found = rec as { _regionsGroupByName?: unknown };
      return;
    }
    for (const k of Object.keys(rec)) {
      if (k.startsWith('__')) continue;
      try {
        scan(rec[k], depth + 1);
      } catch {
        // 访问器抛错时跳过该键
      }
    }
  };
  scan(chart, 0);
  return found as { _regionsGroupByName?: { each: (cb: (group: Ignorable, name: string) => void) => void } } | null;
}

/**
 * 把当前视口换算成数据坐标 bbox 并外扩 margin 倍。
 * 投影经 `boundingCoords` 钉死后 lng/lat → 像素是线性映射，取画布四角即可覆盖整个视口。
 *
 * 注意这里「四角即可」的前提是**线性映射**，故本函数只对中国图成立
 * （`renderer.cullToViewport()` 在世界模式下直接 early-return）。
 * 世界图在 Robinson 投影下映射非线性，画布四角并不对应数据坐标的极值，
 * 四角法会算漏；且世界族只有一个数据档、不需要靠裁剪省渲染开销。
 * 若将来真要开世界图裁剪，除了下面的投影修正，还必须改成多采样而非只取四角。
 */
function viewportBox(chart: { getWidth: () => number; getHeight: () => number }, cs: GeoCoordSys, margin: number): CullBox | null {
  if (typeof cs.pointToData !== 'function') return null;
  /**
   * 像素 → 经纬度。
   *
   * 为什么不能直接 `cs.pointToData(px)`：ECharts 5.6 在**启用 projection 时这个方法是坏的**
   * （`lib/coord/geo/Geo.js` 的 pointToData 先 `projection.unproject(point)` 再
   * `this.pointToProjected(point)`，顺序反了 —— 它把**原始像素**直接喂给了 unproject）。
   * 实测往返 0/6 正确（纬度恒塌缩成常数）。正确顺序是先逆 roam 变换、再 unproject。
   * 中国图没有 projection，故 pointToData 正常，走原路径即可。
   */
  const toLngLat = (px: number[]): number[] | null => {
    if (cs.projection && typeof cs.pointToProjected === 'function') {
      const proj = cs.pointToProjected(px);
      return proj ? cs.projection.unproject(proj) : null;
    }
    return cs.pointToData!(px);
  };
  const w = chart.getWidth();
  const h = chart.getHeight();
  if (!(w > 0) || !(h > 0)) return null;
  const corners = [
    [0, 0],
    [w, 0],
    [0, h],
    [w, h],
  ];
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of corners) {
    const d = toLngLat(p);
    if (!d || !Number.isFinite(d[0]) || !Number.isFinite(d[1])) return null;
    if (d[0] < x0) x0 = d[0];
    if (d[0] > x1) x1 = d[0];
    if (d[1] < y0) y0 = d[1];
    if (d[1] > y1) y1 = d[1];
  }
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const hw = ((x1 - x0) / 2) * margin;
  const hh = ((y1 - y0) / 2) * margin;
  return [cx - hw, cy - hh, cx + hw, cy + hh];
}

/** 两个 bbox 是否相交（用于判断可见性）。 */
function intersects(a: CullBox, b: CullBox): boolean {
  return !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3]);
}

/** 一次裁剪的结果（用于诊断/测试）。 */
export type CullResult = { facesKept: number; facesTotal: number; linesKept: number; linesTotal: number };

/**
 * 按当前视口设置 `ignore`：视口外的地级面组与省界折线被跳过构建与绘制。
 *
 * 必须在 geo 重建之后（`render()` 末尾）以及每次 `georoam` 之后调用：
 * 前者因为 replaceMerge 会重建 region 组、标记被重置；后者因为视口移动后可见集合会变。
 *
 * @param lineBoxes 省界折线各元素的数据坐标 bbox，顺序须与 'province-lines' 系列 data 一致。
 */
export function cullToViewport(
  chart: unknown,
  lineBoxes: CullBox[],
  margin = CULL_MARGIN,
): CullResult | null {
  const c = chart as {
    getWidth: () => number;
    getHeight: () => number;
    getModel?: () => { getComponent: (t: string) => unknown; getSeries: () => { id?: string; getData: () => unknown }[] };
  };
  if (typeof c.getModel !== 'function' || typeof c.getWidth !== 'function') return null;
  let geoModel: unknown;
  let cs: GeoCoordSys | undefined;
  try {
    geoModel = c.getModel().getComponent('geo');
    cs = (geoModel as { coordinateSystem?: GeoCoordSys } | undefined)?.coordinateSystem;
  } catch {
    return null;
  }
  if (!cs) return null;
  const box = viewportBox(c, cs, margin);
  if (!box) return null;

  let facesKept = 0;
  let facesTotal = 0;
  let linesKept = 0;
  let linesTotal = 0;

  // ---- 地级/省级面：按 region 名取几何 bbox（getBoundingRect 内部有缓存，重复调用很便宜） ----
  const md = findMapDraw(chart, geoModel);
  if (md?._regionsGroupByName && typeof cs.getRegion === 'function') {
    md._regionsGroupByName.each((group, name) => {
      facesTotal++;
      const region = cs?.getRegion?.(name);
      let visible = true;
      if (region) {
        const r = region.getBoundingRect();
        visible = intersects([r.x, r.y, r.x + r.width, r.y + r.height], box);
      }
      // 拿不到几何时保守地保持可见，宁可多画也不留空洞
      group.ignore = !visible;
      if (visible) facesKept++;
    });
  }

  // ---- 省界折线：按预计算的 bbox 逐个标记（比 setOption 重建 series 快约 300 倍） ----
  try {
    const series = c.getModel?.().getSeries().find((s) => s.id === 'province-lines') as
      | { getData: () => { count: () => number; getItemGraphicEl: (i: number) => Ignorable | null } }
      | undefined;
    if (series && lineBoxes.length) {
      const data = series.getData();
      const count = data.count();
      // 索引必须与 lineBoxes 对齐；不一致时整体跳过，避免把线条错配成别的省
      if (count === lineBoxes.length) {
        for (let i = 0; i < count; i++) {
          const el = data.getItemGraphicEl(i);
          if (!el) continue;
          const visible = intersects(lineBoxes[i], box);
          el.ignore = !visible;
          if (visible) linesKept++;
          linesTotal++;
        }
      } else {
        linesTotal = count;
      }
    }
  } catch {
    // lines 系列不存在（世界模式等）时忽略
  }

  return { facesKept, facesTotal, linesKept, linesTotal };
}

/** 计算一组折线上所有顶点的数据坐标 bbox（构建时算一次，逐帧裁剪只做比较）。 */
export function boxOfCoords(coords: number[][]): CullBox {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of coords) {
    const x = p[0];
    const y = p[1];
    if (typeof x !== 'number' || typeof y !== 'number') continue;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  // 空/非法坐标返回全范围，使其恒可见（不会被误裁掉）
  if (!Number.isFinite(x0) || !Number.isFinite(y0)) return [-Infinity, -Infinity, Infinity, Infinity];
  return [x0, y0, x1, y1];
}
