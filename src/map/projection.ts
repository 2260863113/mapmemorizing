/**
 * 世界地图投影：Robinson（罗宾逊）折中投影。
 *
 * 为什么需要：默认的等距圆柱（equirectangular，经纬度线性映射）不保面积，
 * 高纬度被急剧放大 —— 在它上面俄罗斯约为真实面积的 3 倍、格陵兰约 14 倍，
 * 而非洲看起来比俄罗斯小得多（实际非洲面积约为俄罗斯的 1.8 倍）。
 * Robinson 是 1961 年为 Rand McNally 设计、后被美国国家地理采用多年的折中投影，
 * 在**面积与形状之间取中间路线**：高纬放大明显小于等距圆柱，又不至于像等面积投影
 * （Equal Earth / Gall-Peters）那样把高纬国家的形状横向拉得过宽。
 *
 * 实现方式：用官方公布的 Robinson 投影表（每 5° 一个 X/Y 系数）做**线性插值**，
 * 这是所有 Robinson 实现的通行做法，无需引入 d3-geo。
 *   x = 0.8487 * R * lam * X(phi)   —— 本文件取 R=1，单位与输出缩放解耦
 *   y = 1.3523 * R * Y(phi)
 * 其中 lam 为经度（弧度）、phi 为纬度（弧度），X/Y 取自下表并随纬度插值。
 *
 * 参考：Robinson, A.H. (1961)；系数表取自 Robinson 投影的公开标准表（如 PROJ / d3-geo 所用同一张表）。
 *
 * 与 ECharts 的接口契约（见 node_modules/echarts/lib/coord/geo/Geo.js）：
 *   - `project([lng, lat])` → [x, y]，返回 null 表示该点不可投影（Robinson 全球可投影，不返回 null）
 *   - `unproject([x, y])` → [lng, lat]，用于 roam 拖拽时把像素位移反算回经纬度
 *   - ECharts 会调用 project() 采样 boundingCoords 的四条边来算投影后的包围盒
 *     （geoCreator.js 的 sampleLine，每边 100 个采样点），因此本投影必须对边界经纬度也有效。
 *   - 一旦提供 projection，ECharts 会忽略 aspectScale 与 invertLongitute（自己算包围盒）。
 */

/**
 * Robinson 投影系数表：每 5° 纬度一个采样。
 * 每项为 [纬度°, X 系数, Y 系数]，Y 为该纬度到赤道的距离系数（乘 1.3523 得 y）。
 * 赤道 X=1.0000、Y=0；极点 X=0.5322、Y=1.0000。
 */
const ROBINSON_TABLE = [
  [0, 1.0000, 0.0000], [5, 0.9986, 0.0620], [10, 0.9954, 0.1240],
  [15, 0.9900, 0.1860], [20, 0.9822, 0.2480], [25, 0.9730, 0.3100],
  [30, 0.9600, 0.3720], [35, 0.9427, 0.4340], [40, 0.9216, 0.4958],
  [45, 0.8962, 0.5571], [50, 0.8679, 0.6176], [55, 0.8350, 0.6769],
  [60, 0.7986, 0.7346], [65, 0.7597, 0.7903], [70, 0.7186, 0.8435],
  [75, 0.6732, 0.8936], [80, 0.6213, 0.9394], [85, 0.5722, 0.9761],
  [90, 0.5322, 1.0000],
];

const DEG2RAD = Math.PI / 180;
/** 经度系数：x = X(phi) * lam * 0.8487 * R（R 取 1） */
const X_SCALE = 0.8487;
/** 纬度系数：y = Y(phi) * 1.3523 * R（R 取 1） */
const Y_SCALE = 1.3523;

/** 按纬度（度）线性插值取 X/Y 系数表项。 */
function coefficientsAt(latDeg: number): { x: number; y: number } {
  const phi = Math.min(90, Math.max(-90, latDeg));
  const a = Math.abs(phi);
  // 表在 0..90 上单调；以 5° 为步长定位相邻两项
  const idx = Math.min(Math.floor(a / 5), ROBINSON_TABLE.length - 2);
  const [lat0, x0, y0] = ROBINSON_TABLE[idx];
  const [lat1, x1, y1] = ROBINSON_TABLE[idx + 1];
  const t = lat1 === lat0 ? 0 : (a - lat0) / (lat1 - lat0);
  return { x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t };
}

/** 经纬度（[lng, lat]）→ Robinson 平面坐标（[x, y]）。ECharts 契约要求此签名。 */
export function robinsonProject(lngLat: number[]): [number, number] {
  const [lng, lat] = lngLat;
  const c = coefficientsAt(lat);
  const x = X_SCALE * c.x * lng * DEG2RAD;
  const y = Y_SCALE * c.y * (lat < 0 ? -1 : 1);
  return [x, y];
}

/**
 * Robinson 平面坐标 → 经纬度。
 * x 反算需要该纬度处的 X 系数，而纬度又依赖 y —— 故先用 y 反查纬度，再解经度。
 */
export function robinsonUnproject(xy: number[]): [number, number] {
  const [x, y] = xy;
  const lat = robinsonLatOf(y);
  const c = coefficientsAt(lat);
  const denom = X_SCALE * c.x * DEG2RAD;
  const lng = denom === 0 ? 0 : x / denom;
  return [lng, lat];
}

/** 由 Robinson 的 y 反查纬度（对 Y 表做线性插值 + 二分定位）。 */
function robinsonLatOf(y: number): number {
  const target = Math.min(Y_SCALE, Math.max(-Y_SCALE, Math.abs(y)));
  // Y 随纬度单调递增，先用表项定位区间，再线性插值
  let lo = 0;
  let hi = ROBINSON_TABLE.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (ROBINSON_TABLE[mid][2] * Y_SCALE <= target) lo = mid;
    else hi = mid;
  }
  const [lat0, , y0] = ROBINSON_TABLE[lo];
  const [lat1, , y1] = ROBINSON_TABLE[hi];
  const yy0 = y0 * Y_SCALE;
  const yy1 = y1 * Y_SCALE;
  const t = yy1 === yy0 ? 0 : (target - yy0) / (yy1 - yy0);
  const lat = lat0 + (lat1 - lat0) * t;
  return y < 0 ? -lat : lat;
}

/** 供 ECharts geo.projection 直接使用的对象。 */
export const robinsonProjection = {
  project: robinsonProject,
  unproject: robinsonUnproject,
};

// ---------------------------------------------------------------------------
// 世界图的投影范围与派生的相机常量
// ---------------------------------------------------------------------------
// 世界图**只有一个数据档**（不像中国图有地级/省级各五档），所以这里钉死投影范围不是为了
// 「换档不位移」，而是为了取得一个确定的、可复核的取景基准：无论将来几何如何微调
// （例如回补南海诸岛），投影比例与居中位置都不变。

/** 世界图纬度上界：南极到 83.6°N（83.6 以北只余格陵兰/北极群岛的边角，取舍同旧档）。 */
export const WORLD_LAT_TOP = 83.6;

/** 世界图钉死的投影范围（geo.boundingCoords 的 [左上, 右下] 经纬度）。 */
export const WORLD_BOUNDING_COORDS: [[number, number], [number, number]] = [
  [-180, -90],
  [180, WORLD_LAT_TOP],
];

/** 投影后世界图的横向总跨度（赤道上 x 从 -W/2 到 +W/2）。zoom=1 时即视图内可见投影宽度。 */
export const WORLD_PROJECTED_WIDTH = robinsonProject([180, 0])[0] - robinsonProject([-180, 0])[0];

/** 投影后世界图的纵向范围 [下, 上]。 */
export const WORLD_PROJECTED_Y: [number, number] = [
  robinsonProject([0, -90])[1],
  robinsonProject([0, WORLD_LAT_TOP])[1],
];

/**
 * 世界图默认相机中心（经纬度）。
 *
 * 为什么不直接用 [0, -3.2]（等距圆柱时代的取值）：Robinson 下投影包围盒的**纵向中点**
 * 并不落在赤道上 —— 南极到 83.6°N 关于赤道不对称（南半球多出 6.4°），故中点略偏南。
 * 若仍取赤道附近为"中心"，整幅世界图会上下偏移约 1.2% 画布高（460px 画布上约 5px）。
 * 这里由投影本身反算出「投影后正好居中」的纬度，取值随投影公式联动，不靠手抄常数。
 */
export const WORLD_PROJECTED_CENTER_LNGLAT: [number, number] = [
  0,
  robinsonUnproject([0, (WORLD_PROJECTED_Y[0] + WORLD_PROJECTED_Y[1]) / 2])[1],
];

/**
 * 某纬度处、给定经度区间的**投影后横向宽度**。
 *
 * 为什么需要：Robinson 的 x = X(φ)·λ·0.8487，X 随纬度下降（赤道 1.0 → 极点 0.53）。
 * 因此同一段经度跨度的投影宽度随纬度变化 —— 大洲取景若按「经度跨度」直接反推 zoom，
 * 在高纬会算得偏小（画面装不下）。取框内各纬度的最大宽度才算「装得下」。
 */
export function projectedWidth(lng0: number, lng1: number, lat: number): number {
  return Math.abs(robinsonProject([lng1, lat])[0] - robinsonProject([lng0, lat])[0]);
}

/** 经验证的纬点数：Robinson 的 X(φ) 在框内单调，取若干纬度采样求最大投影宽度。 */
export function maxProjectedWidth(lng0: number, lng1: number, lat0: number, lat1: number): number {
  const STEPS = 24;
  let best = 0;
  for (let i = 0; i <= STEPS; i += 1) {
    const lat = lat0 + ((lat1 - lat0) * i) / STEPS;
    const w = projectedWidth(lng0, lng1, lat);
    if (w > best) best = w;
  }
  return best;
}

/**
 * 世界图上「投影宽度 → 像素宽度」的换算系数（zoom = 1 时）。
 *
 * 为什么不能直接用 WORLD_PROJECTED_WIDTH：ECharts 的 `zoom` 是相对**它自己算出的投影矩形**
 * 而言的。矩形被 fit 进画布后，1 个投影单位对应的像素数是
 * `min(画布宽/矩形宽, 画布高/矩形高)`，与矩形宽高都有关，而不是与「真实投影宽度」有关。
 *
 * 实测（1400×700 画布）：矩形 w=4.2843 h=2.6584 → 按高 fit，pxPerUnit = 700/2.6584 = 263.3；
 * 若误用真实宽度 5.3325 反推，会把 zoom 算大约 1.24 倍。
 */
export function pixelsPerProjectedUnit(rectWidth: number, rectHeight: number, canvasW: number, canvasH: number): number {
  if (!(rectWidth > 0) || !(rectHeight > 0)) return 0;
  return Math.min(canvasW / rectWidth, canvasH / rectHeight);
}

/**
 * 把经纬度框「完整装进画布」的 zoom（留 padding 比例的边距）。
 *
 * 为什么必须**宽高双适配**：只按宽度反推 zoom 时，南北跨度大的框（南美 -56..13、
 * 非洲 -36..38）会把画面纵向撑爆 —— 实测南美占到画布高的 228%、非洲 164%。
 * 这是本函数存在的原因：取宽高两个约束里更严格的那个。
 *
 * @param canvasW/canvasH 画布像素尺寸
 * @param padding 留白比例（0.12 = 四周各留 12% 中的一部分）
 */
export function fitZoomForLngLatBox(
  lng0: number,
  lat0: number,
  lng1: number,
  lat1: number,
  pxPerUnit: number,
  canvasW: number,
  canvasH: number,
  padding = 0.12,
): number {
  if (!(pxPerUnit > 0) || !(canvasW > 0) || !(canvasH > 0)) return 1;
  // 框四角投影后取包围盒（Robinson 下框的投影形状不是矩形，故用四角近似 + 中间纬度补宽）
  const corners = [
    robinsonProject([lng0, lat0]),
    robinsonProject([lng1, lat0]),
    robinsonProject([lng0, lat1]),
    robinsonProject([lng1, lat1]),
  ];
  const xs = corners.map((p) => p[0]);
  const ys = corners.map((p) => p[1]);
  // 横向还要考虑框内最大投影宽度（高纬收缩后，最宽处可能不在角上）
  const spanX = Math.max(Math.max(...xs) - Math.min(...xs), maxProjectedWidth(lng0, lng1, lat0, lat1));
  const spanY = Math.max(...ys) - Math.min(...ys);
  if (!(spanX > 0) || !(spanY > 0)) return 1;
  const targetW = canvasW * (1 - padding);
  const targetH = canvasH * (1 - padding);
  return Math.min(targetW / (spanX * pxPerUnit), targetH / (spanY * pxPerUnit));
}
