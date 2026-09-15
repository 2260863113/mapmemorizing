/**
 * 相机取景的**纯换算**：地图族默认视野、钉死的投影范围、大洲/次区域/下钻的取景框，
 * 以及跟随倍率阶梯与动画缓动。
 *
 * 为什么这样切：这些计算只吃数字与枚举 —— 既不读 ECharts 实例、也不写渲染器字段。
 * 原先它们作为私有方法散在 `MapRenderer` 里（`viewFromBox` / `continentView` /
 * `subregionView` / `defaultViewFor` / `pickViewFor` / `framingExtent` / `followZoomFor`，
 * 以及 `drillToProvince` 中断在中间的省 bbox 换算），读一行就得回类里确认「此刻
 * this.xxx 是什么」，也没法脱离浏览器单独验证。本模块与 `./follow.ts`（钳制策略）、
 * `./zoom.ts`（倍率夹取）是同一套路：**渲染器负责测量、持有字段、执行副作用；
 * 本模块只负责换算**。
 *
 * 三条约定：
 *   1. **入参显式**：原先读 `this.xxx` 的地方一律改成参数（`pickView` / `framingExtent`
 *      收一个字段上下文对象）。缺省值仍留在渲染器（例如 `applyMapCamera(mapName =
 *      this.currentMapName())`），免得同一逻辑出现「从类里调用是一个值、单独调用是另一个
 *      值」的双口径。
 *   2. **只读**：本模块不修改任何输入。`framingExtent` 命中 `viewProvinceBox` 时**原样返回
 *      该引用**（与搬迁前一致），`provinceCamera` 返回新数组。
 *   3. **数字逐字保留**：这里是取景的唯一口径，任何「顺手美化」（合并常量、改精度）都会
 *      让地图移动，故搬迁时一个数都没动。
 */
import type { Continent, SubregionId, Unit } from '../types';
import { bboxOf } from './geometry';
import { clampZoom } from './zoom';

/** 全国经度跨度（约 73.5 ~ 135.1） */
const NATION_W = 61.6;
/** 全国纬度跨度（约 3.8 ~ 53.6） */
const NATION_H = 49.8;

/** 宽省（新疆/西藏/青海/内蒙古）：视野本身很宽，跟随倍率降到 6x；海南因与港澳放大框共用而顶格。 */
const WIDE_FOLLOW_PROVINCES = new Set(['650000', '630000', '540000', '150000']);
const HAINAN_PROVINCE = '460000';

// ==================== 默认视野与投影范围 ====================

/** 全国视图默认中心/缩放（ECharts geo 在 center=数据 bbox 中心 + zoom=1 时即默认 fit、整图居中）。 */
export const DEFAULT_VIEWS: Record<string, { center: [number, number]; zoom: number }> = {
  china: { center: [104.3, 28.5], zoom: 1 },
  'china-coarse': { center: [104.3, 28.5], zoom: 1 }, // coarse 历史别名（= pro 档），同数据范围
  'china-ultra': { center: [104.3, 28.5], zoom: 1 }, // ultra 档同数据范围
  'china-pro': { center: [104.3, 28.5], zoom: 1 }, // pro 档同数据范围
  'china-plus': { center: [104.3, 28.5], zoom: 1 }, // plus 档同数据范围
  'china-lossless': { center: [104.3, 28.5], zoom: 1 }, // 无损档同数据范围
  'china-provinces': { center: [104.3, 28.5], zoom: 1 },
  'china-provinces-coarse': { center: [104.3, 28.5], zoom: 1 }, // 省级 coarse 历史别名（= ultra 档）
  'china-provinces-ultra': { center: [104.3, 28.5], zoom: 1 },
  'china-provinces-pro': { center: [104.3, 28.5], zoom: 1 },
  'china-provinces-plus': { center: [104.3, 28.5], zoom: 1 },
  'china-provinces-raw': { center: [104.3, 28.5], zoom: 1 }, // 省级无损档同数据范围
  world: { center: [0, -3.2], zoom: 1 },
};

/** 某地图的默认全国视图（数据 bbox 中心 + zoom 1 = ECharts 的 fit 居中视图）。 */
export function defaultViewFor(mapName: string): { center: [number, number]; zoom: number } {
  return DEFAULT_VIEWS[mapName] ?? { center: [104.3, 28.5], zoom: 1 };
}

/**
 * 固定投影范围（geo.boundingCoords 的 [左上, 右下] lng/lat）。
 *
 * 为什么必需：ECharts 默认按**当前注册地图的几何 bbox** 自动适配投影范围，
 * 而同一地区不同简化档的 bbox 并不严格相同 —— 实测 ultra 档与省级粗档把南海诸岛
 * 最南端简化掉，纬度下界从 3.3974 变成 3.5349（高度少 0.1375°，约 15km）。
 * bbox 一变，投影比例与居中偏移就变，于是缩放跨换档阈值触发换档时整幅地图微移、
 * 鼠标所指位置出现偏移。
 *
 * 用 boundingCoords 把投影范围钉成常量后，地级五档与省级五档共用同一投影，
 * 换档前后同一经纬度的像素位置完全一致（这也是「地图不因换档移动」的根本保证）。
 * 取值与中国族各档数据的实际并集一致，保证默认视野与钉死前完全相同。
 *
 * 消费方两处：`./series.ts` 的 `buildGeoOption`（写进 geo.boundingCoords）与本模块的
 * `framingExtent`（中国/世界族的取景边界），故放在本模块而非渲染器。
 */
export const MAP_PROJECTION_BBOX: Record<'china' | 'world', [[number, number], [number, number]]> = {
  china: [
    [73.5, 3.4],
    [135.1, 53.6],
  ],
  world: [
    [-180, -90],
    [180, 83.6],
  ],
};

/** 投影 bbox（[[lng0,lat0],[lng1,lat1]]）拉平成 [lng0, lat0, lng1, lat1]（与 CONTINENT_VIEWS 同构）。 */
export function flattenBBox(bb: [[number, number], [number, number]]): [number, number, number, number] {
  return [bb[0][0], bb[0][1], bb[1][0], bb[1][1]];
}

// ==================== 大洲 / 次区域标定框 ====================

/**
 * 大洲聚焦框（手工标定，lng0/lat0/lng1/lat1）。
 *
 * 为什么手工标定而不是按成员国 bbox 自动计算：
 *   1. 跨经度 180° 的海外领地（俄楚科奇、美阿留申、法属波利尼西亚、新西兰查塔姆）
 *      会让自动 bbox 撑成 360°；
 *   2. 更根本的是俄罗斯：按国际惯例归欧洲，但主体横跨 20°E–180°E，
 *      「包含全部成员国」必然把欧洲拉成 200°+ 宽 —— 而使用者要的是「欧洲大陆」的取景。
 * 相机取景是 UI 决策，标定值确定、可复核、可测试；框外的远端领地仍可通过拖动到达（roam 已开启）。
 */
const CONTINENT_VIEWS: Record<Continent, [number, number, number, number]> = {
  // 亚洲：土耳其/高加索 → 日本，西伯利亚 → 印尼
  AS: [26, -11, 147, 56],
  // 欧洲：冰岛/葡萄牙 → 乌拉尔（含欧俄），北角 → 地中海
  EU: [-25, 34, 60, 71],
  // 非洲：佛得角 → 索马里角，好望角 → 突尼斯
  AF: [-20, -36, 52, 38],
  // 北美洲：阿拉斯加 → 纽芬兰，巴拿马 → 加拿大北极群岛
  NA: [-168, 6, -52, 74],
  // 南美洲：秘鲁西岸 → 巴西东岸，火地岛 → 委内瑞拉
  SA: [-82, -56, -34, 13],
  // 大洋洲：巴布亚新几内亚 → 日界线，新西兰 → 赤道（东侧岛国可平移到达）
  OC: [112, -48, 180, 2],
};

/**
 * 次区域聚焦框（手工标定，lng0/lat0/lng1/lat1；与 CONTINENT_VIEWS 同一套道理）。
 *
 * 为什么同样手标：
 *   - 「东欧」含俄罗斯 → 自动 bbox 会从 20°E 拉到 180°E，把视角推成半个北半球；
 *   - 「波利尼西亚/密克罗尼西亚/美拉尼西亚」跨 180° 经线，自动 bbox 直接撑成 360°；
 *   - 「加勒比」是弧状群岛，自动 bbox 会把大西洋一起框进来。
 * 框外的远端岛屿仍可通过拖动到达（roam 已开启），取景是 UI 决策而非数据推导。
 */
const SUBREGION_VIEWS: Record<SubregionId, [number, number, number, number]> = {
  // 亚洲
  EAS: [73, 18, 146, 54], // 中国 → 日本，南海 → 蒙古/黑龙江
  SEA: [92, -11, 141, 24], // 缅甸 → 菲律宾，印尼 → 中南半岛北缘
  SAS: [60, 5, 93, 37], // 阿富汗 → 孟加拉，斯里兰卡 → 喜马拉雅北麓
  WAS: [25, 12, 64, 43], // 土耳其 → 阿曼湾，也门 → 高加索
  CAS: [46, 35, 88, 56], // 里海 → 中国西界，土库曼 → 哈萨克北缘
  // 欧洲
  NEU: [-25, 53, 32, 72], // 冰岛 → 芬兰东界，波罗的海三国 → 北角
  WEU: [-11, 42, 10, 61], // 爱尔兰 → 德国西界，伊比利亚 → 苏格兰
  CEU: [5, 42, 25, 55], // 德国 → 波兰东界，阿尔卑斯 → 波罗的海
  EEU: [20, 40, 60, 70], // 波兰东界 → 乌拉尔，巴尔干 → 北冰洋沿岸
  SEU: [-10, 34, 29, 46], // 葡萄牙 → 希腊/罗马尼亚南缘，地中海 → 阿尔卑斯南麓
  // 非洲
  NAF: [-18, 15, 36, 38], // 摩洛哥 → 埃及，萨赫勒 → 地中海
  WAF: [-18, 4, 16, 25], // 佛得角 → 尼日利亚东界，几内亚湾 → 撒哈拉南缘
  MAF: [6, -8, 32, 12], // 喀麦隆 → 刚果东界，安哥拉 → 乍得北缘
  EAF: [28, -27, 52, 18], // 苏丹 → 塞舌尔，莫桑比克 → 厄立特里亚
  SAF: [11, -35, 41, -16], // 纳米比亚 → 莫桑比克东岸，好望角 → 博茨瓦纳北缘
  // 北美
  NAM: [-170, 24, -50, 74], // 阿拉斯加 → 纽芬兰，墨西哥北缘 → 加拿大北极群岛
  CAM: [-93, 7, -77, 19], // 危地马拉 → 巴拿马，巴拿马 → 墨西哥南缘
  CAR: [-85, 9, -59, 28], // 古巴西端 → 巴巴多斯，特立尼达 → 巴哈马
  // 南美（单一分区，UI 不显示次区域行；保留映射以维持数据完整性）
  SAM: [-82, -56, -34, 13],
  // 大洋洲
  ANZ: [110, -48, 179, -9], // 澳大利亚 → 新西兰，塔斯马尼亚 → 巴布亚新几内亚北缘
  MEL: [140, -23, 172, 1], // 巴布亚新几内亚 → 所罗门/瓦努阿图，斐济 → 赤道
  MIC: [130, -2, 175, 15], // 帕劳 → 马绍尔，瑙鲁 → 关岛北缘
  POL: [-180, -28, -130, 12], // 图瓦卢/萨摩亚 → 复活节岛方向，汤加 → 赤道北
};

/** 按标定框换算 center/zoom（世界图 zoom 1 时经度跨度约 360，留 12% 边距）。 */
export function viewFromBox(box: [number, number, number, number]): { center: [number, number]; zoom: number } {
  const [x0, y0, x1, y1] = box;
  const center: [number, number] = [(x0 + x1) / 2, (y0 + y1) / 2];
  const spanX = Math.max(x1 - x0, 1e-6);
  return { center, zoom: clampZoom((360 / spanX) * 0.88) };
}

/** 计算某大洲的聚焦 center/zoom（按标定框换算，见 CONTINENT_VIEWS 的说明）。 */
export function continentView(c: Continent): { center: [number, number]; zoom: number } {
  return viewFromBox(CONTINENT_VIEWS[c]);
}

/** 计算某次区域的聚焦 center/zoom（按标定框换算）。 */
export function subregionView(id: SubregionId): { center: [number, number]; zoom: number } {
  return viewFromBox(SUBREGION_VIEWS[id]);
}

// ==================== 视图记忆的选择 ====================

/**
 * 视图记忆槽的只读快照（渲染器的四个字段摊平）。
 *
 * 为什么摊平成参数而不是传渲染器：本模块由此不持有任何对渲染器的引用，取景逻辑可以脱离
 * ECharts 实例验证；渲染器侧只留一个 6 行的适配器 `pickViewFor()` 把字段读出来。
 */
export interface ViewPickContext {
  /** 世界模式下的次区域范围（null = 全洲/全世界）。 */
  worldSubregion: SubregionId | null;
  /** 世界模式下的大洲范围（null = 全世界）。 */
  worldContinent: Continent | null;
  /** 世界族上次的全国视野记忆。 */
  savedWorldView: { center: [number, number]; zoom: number } | null;
  /** 中国族（省级/地级共用一槽）上次的全国视野记忆。 */
  savedChinaView: { center: [number, number]; zoom: number } | null;
}

/** 进入某地图族时应用记忆：有记忆则恢复，无则默认居中。仅算返回值，不 setOption。 */
export function pickView(mapName: string, ctx: ViewPickContext): { center: [number, number]; zoom: number } {
  if (mapName === 'world') {
    // 次区域/大洲视图优先于世界记忆：切范围必须聚焦该范围，不能被「上次世界视野」覆盖
    if (ctx.worldSubregion) return subregionView(ctx.worldSubregion);
    if (ctx.worldContinent) return continentView(ctx.worldContinent);
    if (ctx.savedWorldView) {
      return { center: [ctx.savedWorldView.center[0], ctx.savedWorldView.center[1]], zoom: ctx.savedWorldView.zoom };
    }
  } else if (ctx.savedChinaView) {
    return { center: [ctx.savedChinaView.center[0], ctx.savedChinaView.center[1]], zoom: ctx.savedChinaView.zoom };
  }
  const def = defaultViewFor(mapName);
  return { center: [def.center[0], def.center[1]], zoom: def.zoom };
}

// ==================== 跟随钳制（取景边界 + 边距） ====================

/** 取景边界的输入（渲染器字段的只读快照；摊平理由同 ViewPickContext）。 */
export interface FramingExtentContext {
  worldMode: boolean;
  worldSubregion: SubregionId | null;
  worldContinent: Continent | null;
  /** 下钻中的省 adcode；null = 全国视野。 */
  viewProvince: string | null;
  /** 下钻省的几何 bbox（该省全部地级单位并集）。 */
  viewProvinceBox: [number, number, number, number] | null;
}

/**
 * 当前视图的**取景边界**：视口允许显示的数据矩形（lng0/lat0/lng1/lat1）。
 *
 * 视口越出它就会露出纯背景色 —— 这正是「跟随把边界附近的目标顶到正中 → 半屏空白」的根因。
 * 分层取值：下钻省 = 该省地级单位并集 bbox；世界次区域/大洲 = 各自标定框；
 * 否则按地图族用钉死的投影 bbox（中国 / 世界）。
 *
 * 注意命中 `viewProvinceBox` 时返回的是**传入的那个引用**（搬迁前 `this.viewProvinceBox`
 * 也是如此），调用方不得就地改写它。
 */
export function framingExtent(ctx: FramingExtentContext): [number, number, number, number] {
  if (ctx.worldMode) {
    if (ctx.worldSubregion) return SUBREGION_VIEWS[ctx.worldSubregion];
    if (ctx.worldContinent) return CONTINENT_VIEWS[ctx.worldContinent];
    return flattenBBox(MAP_PROJECTION_BBOX.world);
  }
  if (ctx.viewProvince && ctx.viewProvinceBox) return ctx.viewProvinceBox;
  return flattenBBox(MAP_PROJECTION_BBOX.china);
}

/**
 * 中国族按省下钻时的跟随倍率阶梯（世界档另有一套，见 `worldFollowZoom`，它留在渲染器里
 * —— 那是**导出**给验收探针的标定函数，位置不动）。
 *
 * 宽省（新疆/西藏/青海/内蒙古）视野本身就宽，用 6x；海南被港澳放大框共用，用 28x 顶格；
 * 其余省 12x。这些数是目视标定的取景决策，与 `MIN_ZOOM`/`MAX_ZOOM` 无关。
 */
export function followZoomFor(provinceAdcode: string) {
  if (WIDE_FOLLOW_PROVINCES.has(provinceAdcode)) return 6;
  if (provinceAdcode === HAINAN_PROVINCE) return 28;
  return 12;
}

// ==================== 下钻取景 ====================

/** 下钻取景的三件套：取景边界（= 该省 bbox，邻省透明时越出即露白）、中心、倍率。 */
export interface ProvinceCamera {
  box: [number, number, number, number];
  center: [number, number];
  zoom: number;
}

/** `drillToProvince` 用的地级要素（只用到 adcode 与几何坐标）。 */
type DrillFeature = { properties: { adcode: string }; geometry: { coordinates: unknown } };

/**
 * 由「该省全部地级单位」的几何并集算出下钻相机；单位无一命中要素时返回 null（调用方原样 return）。
 *
 * 倍率口径：把并集 bbox 与全国跨度（NATION_W/NATION_H）相比，取两轴中较大的占比当作需要放大的
 * 倍数，再乘 0.9 留边距，下限 1.05（略大于默认 1，保证下钻视觉上有"贴近"感），最后夹到梯子范围。
 * 0.5 度是退化下限：单点/极小要素不会让比例爆炸。
 */
export function provinceCamera(units: Unit[], features: DrillFeature[]): ProvinceCamera | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const u of units) {
    const feat = features.find((f) => f.properties.adcode === u.adcode);
    if (!feat) continue;
    const b = bboxOf(feat);
    minX = Math.min(minX, b[0]);
    minY = Math.min(minY, b[1]);
    maxX = Math.max(maxX, b[2]);
    maxY = Math.max(maxY, b[3]);
  }
  if (!isFinite(minX)) return null;
  const bw = Math.max(maxX - minX, 0.5);
  const bh = Math.max(maxY - minY, 0.5);
  const zoom = clampZoom(Math.max(1.05, (1 / Math.max(bw / NATION_W, bh / NATION_H)) * 0.9));
  return { box: [minX, minY, maxX, maxY], center: [(minX + maxX) / 2, (minY + maxY) / 2], zoom };
}

// ==================== 跟随动画的缓动 ====================

/**
 * 镜头动画缓动（ease-in-out cubic）。
 *
 * 纯函数无状态，但它是**每帧**在 `requestAnimationFrame` 回调里调用的，改一个系数就是
 * 650ms 动画的观感回归，故与取景换算放在一起、也是本模块唯一的"时序"函数。
 */
export function easeInOutCubic(t: number) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}
