import * as echarts from 'echarts';
import type { AppData, BoundaryTone, Continent, RenderState, SubregionId, Unit, UnitColor } from '../types';
import { t } from '../i18n';
import { MAP_THEMES, type MapTheme, type ThemeName } from './theme';
import { bboxOf, bestLabelAnchor, polygonsOf, type GeoFeature, type GeoPoint } from './geometry';
import { buildLabelAnchors, buildProvinceLines } from './geoIndex';
import { MAX_ZOOM, MIN_ZOOM, clampZoom } from './zoom';
import { clampFollowCenter, followZoomFloor, isComfortablyVisible, isNegligibleMove } from './follow';
import { InsetMap } from './inset';
import { registerMaps } from './mapRegistry';
import { boxOfCoords, cullToViewport, type CullBox } from './cull';
import { worldFaceInteractive, type WorldFaceContext } from './worldFaces';
import { tierOfZoom, chinaMapNameForTier, provinceMapNameForTier, type Tier } from './tiers';
import type { MapRendererDiagnostics } from './rendererDiagnostics';
import {
  buildCityEventData,
  buildLabelData,
  buildProvinceEventData,
  buildProvinceLabelData,
  buildProvinceRegionData,
  buildRegionData,
  buildWorldEventData,
  buildWorldLabelData,
  buildWorldRegionData,
  WORLD_LABEL_ZOOM,
  type GeoRegion,
  type LabelPoint,
  type LayerInput,
} from './layers';
import {
  CITY_LABEL_SIZE,
  PRICE_LABEL_SIZE,
  PROVINCE_LABEL_SIZE,
  buildLabelGraphic,
  labelScale,
  parseLabelValue,
} from './labels';

/**
 * `series` 数组的**元素**类型。从 ECharts 自己的 option 类型里取（而不是去猜它内部
 * `SeriesOption$1` 之类被重命名的名字）。
 *
 * 为什么需要显式标注：series 的元素原本嵌在 `const option: echarts.EChartsOption = {...}`
 * 里，靠上下文把 `type: 'custom'` 收窄成字面量类型、把 `renderItem(_params, api)` 的
 * 参数推断出来。一旦把某条 series 搬进独立方法，上下文就丢了 —— 会得到
 * `Type 'string' is not assignable to type '"lines"'` 与一串 `implicitly has an any type`。
 */
type SeriesItem = Exclude<NonNullable<echarts.EChartsOption['series']>, readonly unknown[]>;
const NATION_W = 61.6; // 全国经度跨度（约 73.5 ~ 135.1）
const NATION_H = 49.8; // 全国纬度跨度（约 3.8 ~ 53.6）
const LABEL_ZOOM = 4; // 默认缩放倍率阈值；记忆模式可通过 RenderState 覆盖（世界档的 WORLD_LABEL_ZOOM 在 ./layers.ts）
const FOLLOW_ANIMATION_MS = 650;
const WIDE_FOLLOW_PROVINCES = new Set(['650000', '630000', '540000', '150000']);
const HAINAN_PROVINCE = '460000';
const LABEL_UPDATE_DELAY = 120;
const FOLLOW_FRAME_INTERVAL = 1000 / 45;

/** 投影 bbox（[[lng0,lat0],[lng1,lat1]]）拉平成 [lng0, lat0, lng1, lat1]（与 CONTINENT_VIEWS 同构）。 */
function flattenBBox(bb: [[number, number], [number, number]]): [number, number, number, number] {
  return [bb[0][0], bb[0][1], bb[1][0], bb[1][1]];
}

// 五档缩放档位的阈值与地图名映射统一放在 ./tiers.ts（纯逻辑 + 单测覆盖），
// renderer 只经 activeTier() / chinaTierMapName() / provinceTierMapName() 间接使用，
// 避免地级与省级各写一套阈值而漂移。见该文件顶部注释的精细度阶梯表。
/** 全国视图默认中心/缩放（ECharts geo 在 center=数据 bbox 中心 + zoom=1 时即默认 fit、整图居中）。 */
const DEFAULT_VIEWS: Record<string, { center: [number, number]; zoom: number }> = {
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
 */
const MAP_PROJECTION_BBOX: Record<'china' | 'world', [[number, number], [number, number]]> = {
  china: [
    [73.5, 3.4],
    [135.1, 53.6],
  ],
  world: [
    [-180, -90],
    [180, 83.6],
  ],
};

const STATUS_TXT: Record<UnitColor, string> = {
  green: t('map.status.green'),
  blue: t('map.status.blue'),
  red: t('map.status.red'),
  gray: t('map.status.gray'),
  scoreGreenLight: t('map.status.scoreGreenLight'),
  scoreGreenMedium: t('map.status.scoreGreenMedium'),
  scoreGreenDark: t('map.status.scoreGreenDark'),
  scoreRedLight: t('map.status.scoreRedLight'),
  scoreRedMedium: t('map.status.scoreRedMedium'),
  scoreRedDark: t('map.status.scoreRedDark'),
};

export interface MapHandlers {
  onUnitClick: (adcode: string) => boolean | void;
  onUnitDblClick: (adcode: string) => void;
  onBlankClick: () => void;
  onUnitHover?: (adcode: string) => void;
  onUnitHoverEnd?: () => void;
}

/**
 * 世界自动跟随的缩放区间。
 *
 * 上限绑定地图的 `MAX_ZOOM`（28）——本模型实际用不到上限（最小国瑙鲁约 23.6x），
 * 保留它只是为了给退化输入一个边界，并避免与地图 scaleLimit 漂移。
 * 下限 3 是最大国（俄罗斯）的落点。
 */
export const WORLD_FOLLOW_MIN_ZOOM = 3;
export const WORLD_FOLLOW_MAX_ZOOM = MAX_ZOOM;

/**
 * 自动跟随标定系数：`zoom = A − B·ln(面积)`。
 *
 * ### 为什么是对数，而不是「与面积/√面积 成反比」
 *
 * 用户给的三档锚点（立陶宛 9.19 → 11x、法国 71.54 → 8x、俄罗斯 2924.11 → 3x）
 * 决定了曲线形状，检验方式是看相邻锚点在两种坐标下的斜率是否一致：
 *
 * - **幂律** `zoom = k·面积^-p` 要求 (ln 面积, ln zoom) 共线。实测两段斜率为
 *   **−0.1551** 与 **−0.2643**，相差 **0.59 倍** → 不存在能同时命中三档的幂律。
 *   上一轮那套「K/√面积」正是幂律，在这批锚点下无论如何调 K 都过不了。
 * - **对数** `zoom = A − B·ln(面积)` 只要求 (ln 面积, zoom) 共线。实测两段斜率为
 *   **−1.4615** 与 **−1.3475**，几乎相等 → 对数模型可用。
 *
 * 最小二乘解出 A = 14.0045、B = 1.3832，取整为 **A = 14、B = 1.38**。
 *
 * ### 标定结果（用户给定，全部命中）
 *
 * | 国家 | 面积(度²) | 目标 | 公式值 |
 * |---|---|---|---|
 * | 立陶宛 | 9.185 | 11x | **10.94** |
 * | 法国 | 71.538 | 8x | **8.11** |
 * | 俄罗斯 | 2924.108 | 3x | **2.99** |
 *
 * ### 与上一轮锚点的取舍
 *
 * 本轮锚点把区间**整体压缩**了（俄罗斯 2x→3x、法国 13x→8x）。因此极小国不再
 * 顶到 28x：安道尔约 18.2x、马耳他约 19.1x、列支敦士登约 19.8x，全池最大约
 * 23.6x（瑙鲁）。这与上一轮「极小国放 28x」的口径不同，是用户本轮明确改的口径。
 */
export const WORLD_FOLLOW_A = 14;
export const WORLD_FOLLOW_B = 1.38;

/** 面积缺失/非法时的兜底倍率（法国量级，保证镜头仍可用）。 */
const WORLD_FOLLOW_FALLBACK_ZOOM = 8;

/**
 * 面积 → 跟随缩放：`zoom = A − B·ln(面积)`，再夹到 `[MIN, MAX]`。
 *
 * 注意这是**绝对映射**（只依赖面积本身），不是按当前池子的面积区间归一化 ——
 * 归一化会让同一个国家因为「当前是全世界还是某洲」而拿到不同倍率，不可预期。
 */
export function worldFollowZoom(area: number): number {
  if (!Number.isFinite(area) || area <= 0) return WORLD_FOLLOW_FALLBACK_ZOOM;
  const z = WORLD_FOLLOW_A - WORLD_FOLLOW_B * Math.log(area);
  if (!Number.isFinite(z)) return WORLD_FOLLOW_FALLBACK_ZOOM;
  return Math.min(WORLD_FOLLOW_MAX_ZOOM, Math.max(WORLD_FOLLOW_MIN_ZOOM, z));
}

function easeInOutCubic(t: number) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * ECharts 渲染器：单视图架构。
 * - geo 组件：map = 'china'（地级数据）作为唯一坐标系（roam），通过 `geo.regions`
 *   绘制地级面（状态着色 + 细边界 + 白底标签）；geo 自身默认透明。
 *   注意：绑定 `geoIndex` 的 map series 不会绘制自己的 `itemStyle`/`label`，
 *   必须把这些配置放到 `geo.regions` 上才会生效。
 * - series[0] map series：绑定 geoIndex，仅提供 data 用于 tooltip/事件；
 * - series[1] lines series：绑定同一 geo，绘制省界粗线（`polyline: true`
 *   才能让每个省界环的所有点连成完整边界，默认 false 只画前两个点）。
 */
export class MapRenderer {
  private chart: echarts.ECharts;
  private units: Unit[];
  private nameToUnit = new Map<string, Unit>();
  private adcodeToUnit = new Map<string, Unit>();
  /** 省界线五档折线（与地级档位阈值完全一致，见文件顶部阈值注释）。 */
  private provinceLines: Record<'ultra' | 'pro' | 'fine' | 'plus' | 'lossless', { adcode: string; coords: number[][] }[]> = {
    ultra: [], pro: [], fine: [], plus: [], lossless: [],
  };
  private labelAnchors = new Map<string, GeoPoint>();
  private provinceLabelAnchors = new Map<string, GeoPoint>();
  private provinceNameToAdcode = new Map<string, string>(); // 省全名 → 省 adcode（省级地图命中）
  private inset: InsetMap;
  private viewProvince: string | null = null;
  /**
   * 下钻省的几何 bbox（该省全部地级单位并集，与 `drillToProvince` 的取景框同源）。
   * 钻省期间它就是**取景边界**：邻省是透明的，跟随越出这个框就会露出纯背景。
   */
  private viewProvinceBox: [number, number, number, number] | null = null;
  /** 当前相机中心（数据坐标）。地图切换/复位时按 DEFAULT_VIEWS 回该地图 bbox 中心。 */
  private center: [number, number] = [104.3, 28.5];
  private zoom = 1;
  /** 下钻前全国视图快照：从全国下钻某省时记录 center/zoom，返回全国（backToNation）时恢复。 */
  private savedNationView: { center: [number, number]; zoom: number } | null = null;
  /** 世界视图记忆：进入世界前记录世界地图上次的全国视野（center/zoom），切回世界时恢复。 */
  private savedWorldView: { center: [number, number]; zoom: number } | null = null;
  /** 中国视图记忆：离开中国切世界前记录当时的全国视野，切回中国时恢复（省级/地级共用，center/zoom 互换兼容）。 */
  private savedChinaView: { center: [number, number]; zoom: number } | null = null;
  private labelMode: 'none' | 'city' = 'none';
  private labelScaleApplied = 1; // 最近一次应用的标签缩放（缩放变化时触发重绘）
  private labelUpdateTimer: number | null = null;
  private followRaf: number | null = null;
  private lastState: RenderState | null = null;
  private themeName: ThemeName = 'light';
  private cityBoundaryTone: BoundaryTone = 'light';
  private provinceBoundaryTone: BoundaryTone = 'dark';
  private worldBoundaryTone: BoundaryTone = 'mid'; // 世界地图国家边界（默认取中间灰，同历史视觉）
  private provinceMode = false; // 省级模式：不画地级边界、省界加粗、不支持下钻
  private provinceModeInset = true; // 省级模式是否显示港澳放大框
  private provinceModeDrill = false; // 省级模式是否支持下钻（双击省级面 → onUnitDblClick(省adcode)）
  private worldMode = false; // 世界模式：只渲染世界地图（答题国 + 装饰面），无放大框、无下钻
  private worldContinent: Continent | null = null; // 世界模式下的洲范围（null = 全世界；非空 = 只渲染该洲 + 聚焦）
  private worldSubregion: SubregionId | null = null; // 世界模式下的次区域范围（null = 全洲；非空 = 只渲染该次区域 + 聚焦）
  /** 最近一次 render 实际应用到的 geo 地图名（用于检测地图切换，切换时强制重建 geo 组件）。 */
  private appliedMapName = '';
  /** 最近一次的「地图名|大洲|次区域」签名（洲/次区域变化需 replaceMerge 重建 geo.regions）。 */
  private appliedContinentKey = '';
  private worldNameToIso = new Map<string, string>(); // 世界面 name → iso_a3
  private worldIsoToName = new Map<string, string>(); // iso_a3 → 世界面 name（答题国）
  private worldDecorativeNames = new Set<string>(); // 装饰面 name（灰显、不响应）
  private worldLabelAnchors = new Map<string, GeoPoint>(); // iso → 标签锚点（按主面质心）
  private isoContinent = new Map<string, Continent>(); // iso → 大洲（世界大洲视图过滤用）
  private isoSubregion = new Map<string, SubregionId>(); // iso → 次区域（世界次区域视图过滤用）
  /** 被设置排除出答题的极小国家 iso（灰显、完全无交互；未开启该设置时为空集）。 */
  private excludedIso = new Set<string>();
  /** 排除国名 → iso：这些面按装饰面处理（silent + 灰色）。 */
  private worldExcludedNames = new Set<string>();
  private flashAdcode: string | null = null;
  private flashTimer: number | null = null;
  /** 省界折线各元素的数据坐标 bbox（下标与 'province-lines' 系列 data 对齐，供逐帧视口裁剪用）。 */
  private lineBoxes: CullBox[] = [];
  /** 命名 resize 监听器引用，dispose 时移除，避免匿名监听泄漏。 */
  private handleResize = () => this.resize();
  onViewChange: (() => void) | null = null;
  onZoomChange: (() => void) | null = null;

  constructor(private el: HTMLElement, private data: AppData, private handlers: MapHandlers) {
    registerMaps(data); // 13 张地图的注册表（见 ./mapRegistry.ts）
    this.inset = this.createInset(data); // 港澳放大框
    this.chart = echarts.init(el);
    this.units = data.allUnits; // 留在构造器里赋值：strictPropertyInitialization 要求
    this.buildIndexTables(data); // 构造期查表：单位索引 / 五档省界 / 文字锚点 / 世界面表
    this.wireChartEvents(); // 单击 / 悬停 / 双击 / 缩放平移
    window.addEventListener('resize', this.handleResize);
  }

  /**
   * 港澳放大框。主题 / 当前状态 / 边界深浅都传 **lambda** —— 它们是活值：
   * 放大框要跟着主题与设置走，不能在构造时取快照。
   */
  private createInset(data: AppData): InsetMap {
    const inset = new InsetMap({
      theme: () => this.theme(),
      state: () => this.lastState,
      boundaryTone: () => this.provinceBoundaryTone,
      handlers: this.handlers,
      provincesGeoJson: data.hkmacGeoJson ?? data.provincesGeoJson, // 港澳放大框用无压缩面（回退到省界细档）
    });
    inset.registerMap(); // 港澳放大框：香港+澳门+广东沿海
    return inset;
  }

  /**
   * 构造期只建一次的查表：单位索引、五档省界折线、两级文字锚点、省名表、世界面表。
   *
   * 这些以前全摊在 223 行的构造器里，与「注册地图」「接 ECharts 事件」混在一起，
   * 读的人分不清哪几行属于几何、哪几行属于事件接线。
   */
  private buildIndexTables(data: AppData) {
    for (const c of data.countries) this.isoContinent.set(c.iso, c.continent); // 大洲视图过滤表
    for (const [iso, sr] of Object.entries(data.isoSubregion)) this.isoSubregion.set(iso, sr); // 次区域视图过滤表
    for (const u of this.units) {
      this.nameToUnit.set(u.name, u);
      this.adcodeToUnit.set(u.adcode, u);
    }
    // 构造期几何索引：纯函数建表（见 ./geoIndex.ts）
    this.provinceLines.ultra = buildProvinceLines(data.provincesUltraGeoJson, data.provincesGeoJson);
    this.provinceLines.pro = buildProvinceLines(data.provincesProGeoJson, data.provincesGeoJson);
    this.provinceLines.fine = buildProvinceLines(data.provincesGeoJson, data.provincesGeoJson);
    this.provinceLines.plus = buildProvinceLines(data.provincesPlusGeoJson, data.provincesGeoJson);
    this.provinceLines.lossless = buildProvinceLines(data.provincesRawGeoJson, data.provincesGeoJson);
    // 地级与省级的文字锚点用的是同一套算法，只是数据源不同
    this.labelAnchors = buildLabelAnchors(data.geoJson as { features?: GeoFeature[] });
    this.provinceLabelAnchors = buildLabelAnchors(data.provincesGeoJson as { features?: GeoFeature[] });
    // 省全名 → 省 adcode（省级地图点击/悬浮命中整省时回传）
    const provGeo = data.provincesGeoJson as { features?: GeoFeature[] };
    for (const f of provGeo.features ?? []) {
      if (f.properties.name && f.properties.adcode) this.provinceNameToAdcode.set(f.properties.name, f.properties.adcode);
    }
    // 世界面 name → iso / 装饰面判定 / 标签锚点（只取主面，标签不致落在公海）
    const worldGeo = data.worldGeoJson as { features?: GeoFeature[] };
    for (const f of worldGeo.features ?? []) {
      const nm = f.properties.name ?? '';
      const iso = f.properties.iso_a3 ? String(f.properties.iso_a3) : '';
      if (iso) this.worldNameToIso.set(nm, iso);
      if (f.properties.decorative) this.worldDecorativeNames.add(nm);
      else {
        this.worldIsoToName.set(iso, nm);
        const polygons = polygonsOf(f);
        if (polygons.length) this.worldLabelAnchors.set(iso, bestLabelAnchor(polygons));
      }
    }
  }

  // ==================== ECharts 事件接线 ====================

  private wireChartEvents() {
    this.wireChartClick();
    this.wireChartHover();
    this.wireChartDblClick();
    this.wireChartRoam();
  }

  /** 单击：命中单位 / 装饰面 / 空白，三档粒度各一套语义（各分支的判断理由见方法内注释）。 */
  private wireChartClick() {
    this.chart.on('click', (p) => {
      this.clearFlash(); // 点击任何位置先清除黄色高亮，避免点空白处不消失
      const params = p as { componentType?: string; seriesType?: string; name?: string };
      const isUnitHit = params.componentType === 'series' && params.seriesType === 'map';
      if (!isUnitHit) {
        // 命中 geo 层（非 map series）时的兜底；真正的「什么都没点中」走下面的 zr handler
        // （ECharts 的 _initEvents 只在 params 存在时才 trigger，故空点根本不会进这个回调）。
        if (this.hasDrillLevel()) this.handlers.onBlankClick();
        return;
      }
      const hitName = params.name ?? '';
      // 世界模式：命中答题国 → 按 iso 回传；装饰面/被排除的极小国/当前范围外的面一律静默
      if (this.worldMode) {
        if (!this.worldFaceInteractive(hitName)) {
          // 命中的是不可交互的面（大洲视图下其他洲、被排除的极小国等）：等价于点了空白
          if (this.hasDrillLevel()) this.handlers.onBlankClick();
          return;
        }
        const iso = this.worldNameToIso.get(hitName);
        if (iso) this.handlers.onUnitClick(iso);
        return;
      }
      // 省级模式：命中省级面 → 按省全名查省 adcode 回传，不支持下钻
      if (this.provinceMode) {
        const adcode = this.provinceNameToAdcode.get(hitName);
        if (adcode && adcode !== '100000_JD') this.handlers.onUnitClick(adcode);
        else if (this.viewProvince) this.handlers.onBlankClick();
        return;
      }
      const u = this.nameToUnit.get(hitName);
      if (!u) {
        if (this.viewProvince) this.handlers.onBlankClick();
        return;
      }
      if (!this.viewProvince) {
        if (this.handlers.onUnitClick(u.adcode) === true) return;
        this.drillToProvince(u.provinceAdcode);
        return;
      }
      if (u.provinceAdcode !== this.viewProvince) return;
      this.handlers.onUnitClick(u.adcode);
    });

    // 真正的「什么都没点中」判定：zrender 的 event.target 为空即未命中任何图形。
    // 上面的 chart.on('click') 在空点时不会触发（ECharts 的 _initEvents 只在命中
    // 图形、能构造出 params 时才 trigger），所以空点必须靠这里。
    // 中国钻省时返回全国；世界层大洲/次区域下钻时返回上一级（见 hasDrillLevel）。
    this.chart.getZr().on('click', (event) => {
      if (!event.target && this.hasDrillLevel()) this.handlers.onBlankClick();
    });
  }

  /** 悬停：世界面按「可交互性」决定回传还是显式结束（防止残留高亮）。 */
  private wireChartHover() {
    this.chart.on('mouseover', (p) => {
      const params = p as { componentType?: string; seriesType?: string; name?: string };
      if (params.componentType !== 'series' || params.seriesType !== 'map') return;
      const hitName = params.name ?? '';
      if (this.worldMode) {
        if (this.worldFaceInteractive(hitName)) {
          const iso = this.worldNameToIso.get(hitName);
          if (iso) this.handlers.onUnitHover?.(iso);
        } else {
          // 空白/其他洲/被排除的极小国：显式结束悬停，防止残留高亮
          this.handlers.onUnitHoverEnd?.();
        }
        return;
      }
      // 省级模式：命中省级面 → 按省全名查省 adcode
      if (this.provinceMode) {
        const adcode = this.provinceNameToAdcode.get(hitName);
        if (adcode) this.handlers.onUnitHover?.(adcode);
        return;
      }
      const u = this.nameToUnit.get(hitName);
      if (u) this.handlers.onUnitHover?.(u.adcode);
    });
    this.chart.on('mouseout', (p) => {
      const params = p as { componentType?: string; seriesType?: string };
      if (params.componentType === 'series' && params.seriesType === 'map') this.handlers.onUnitHoverEnd?.();
    });
  }

  /** 双击：世界下钻 / 省级浏览下钻 / 中国全国下钻。双击空白**不是**下钻语义（那由 zr click 负责）。 */
  private wireChartDblClick() {
    this.chart.on('dblclick', (p) => {
      const params = p as { componentType?: string; seriesType?: string; name?: string };
      // 世界模式：双击答题国 → 交给模式层「逐层下钻」（熟练度分析世界档靠这条下钻；
      // 测验模式未开始时单击已能下钻，双击只是把同样的下钻再走一遍，模式层有幂等守卫）。
      // 双击空白处不是下钻语义——空点返回上一层由上面的 zr click handler 负责。
      if (this.worldMode) {
        const hitName = params.name ?? '';
        if (this.worldFaceInteractive(hitName)) {
          const iso = this.worldNameToIso.get(hitName);
          if (iso) this.handlers.onUnitDblClick(iso);
        } else if (this.hasDrillLevel()) {
          this.handlers.onBlankClick();
        }
        return;
      }
      if (this.provinceMode) {
        if (!this.provinceModeDrill) return; // 省级模式：默认不支持下钻
        // 省级浏览（熟练度分析省级档）：双击省级面 → 回传省 adcode 交给模式下钻
        const adcode = this.provinceNameToAdcode.get(params.name ?? '');
        if (adcode && adcode !== '100000_JD') this.handlers.onUnitDblClick(adcode);
        return;
      }
      if (this.viewProvince) {
        this.handlers.onBlankClick();
        return;
      }
      if (params.componentType === 'series' && params.seriesType === 'map') {
        const u = this.nameToUnit.get(params.name ?? '');
        if (!u) return;
        this.handlers.onUnitDblClick(u.adcode);
        return;
      }
      // geo 兜底：空白/边界附近点击命中的地级 region
      if (params.componentType === 'geo') {
        const u = this.nameToUnit.get(params.name ?? '');
        if (!u) return;
        this.handlers.onUnitDblClick(u.adcode);
      }
    });
  }

  /** 缩放/拖动：只同步相机与裁剪，**不**重建 map/lines（理由见方法内注释）。 */
  private wireChartRoam() {
    // 缩放/拖动时只记录 zoom。不要在 georoam 中完整 setOption 重建 map/lines，
    // 否则 ECharts 会让地级 MapDraw 进入过渡态，而省界 lines 已经跟随新坐标系。
    this.chart.on('georoam', (p) => {
      if (this.followRaf !== null) {
        cancelAnimationFrame(this.followRaf);
        this.followRaf = null;
      }
      // ECharts 滚轮/捏合缩放以鼠标为锚点，缩放时 geo 中心会**隐式移动**（锚点缩放）；
      // 但 zoom 事件的 payload 只含 zoom/totalZoom，不含 center（见 MapDraw.js 的
      // zoom dispatch：仅 {totalZoom, zoom, originX, originY}）。若只靠 payload 里的
      // params.center 同步，this.center 会在缩放期间停留在旧值 —— 跨换档阈值时
      // render() 用这个旧 center 重建 geo，地图就会朝缩放锚点方向跳一下（十几像素）。
      // 因此这里直接从 geo 坐标系读 ECharts 已经更新好的**权威** center/zoom，而非依赖 payload。
      // 注：georoam 事件在 geoRoam action 处理完（updateCenterAndZoom 已写回 geo center）之后才触发，
      // 故此刻读到的 getCenter() 是缩放后的最新值（实测 rc 与 geo 中心恒一致）。
      const geoModel = (this.chart as unknown as {
        getModel: () => { getComponent: (t: string) => { coordinateSystem?: { getCenter?: () => number[]; getZoom?: () => number } } | null };
      }).getModel().getComponent('geo');
      const geo = geoModel?.coordinateSystem;
      if (geo?.getCenter && geo?.getZoom) {
        const c = geo.getCenter();
        if (c && Number.isFinite(c[0]) && Number.isFinite(c[1])) {
          this.center = [c[0], c[1]];
        }
        this.zoom = clampZoom(geo.getZoom() || 1);
      } else {
        // 兜底：geo 组件不可得时退回 payload 解析（旧路径，理论不可达）
        const params = p as { zoom?: number; totalZoom?: number; center?: number[] };
        if (Array.isArray(params.center) && typeof params.center[0] === 'number' && typeof params.center[1] === 'number') {
          this.center = [params.center[0], params.center[1]];
        }
        if (typeof params.totalZoom === 'number') {
          this.zoom = clampZoom(params.totalZoom);
        } else if (typeof params.zoom === 'number') {
          this.zoom = clampZoom(this.zoom * params.zoom);
        }
      }
      this.scheduleLabelModeUpdate();
      this.cullToViewport(); // 视口移动后可见集合变化：刷新裁剪（约 1.3ms，可每帧执行）
      this.onZoomChange?.();
    });
  }

  /** 容器尺寸变化（如从留言板切回地图）时重算画布。 */
  resize() {
    this.chart.resize();
    this.inset.resize();
    // 画布尺寸变了 → 视口覆盖的数据范围随之变化，需按新尺寸重算裁剪
    this.cullToViewport();
  }

  /** 某地图的默认全国视图（数据 bbox 中心 + zoom 1 = ECharts 的 fit 居中视图）。 */
  private defaultViewFor(mapName: string): { center: [number, number]; zoom: number } {
    return DEFAULT_VIEWS[mapName] ?? { center: [104.3, 28.5], zoom: 1 };
  }

  /** 切走某地图族前，把当前全国视野记入对应记忆槽（仅全国层：钻省状态不参与，此时以钻省前快照为准）。 */
  private snapshotViewBeforeLeave() {
    const mapName = this.currentMapName();
    if (mapName === 'world') {
      this.savedWorldView = { center: [this.center[0], this.center[1]], zoom: this.zoom };
    } else {
      // 钻省中切走：记忆的是钻省前的全国视野（省画面切走不应成为「返回位置」）
      if (this.viewProvince !== null && this.savedNationView) {
        this.savedChinaView = {
          center: [this.savedNationView.center[0], this.savedNationView.center[1]],
          zoom: this.savedNationView.zoom,
        };
      } else {
        // china 与 china-provinces 数据范围一致，center/zoom 可互换 → 中国单槽共享
        this.savedChinaView = { center: [this.center[0], this.center[1]], zoom: this.zoom };
      }
    }
  }

  /** 进入某地图族时应用记忆：有记忆则恢复，无则默认居中。仅设字段，不 setOption。 */
  private pickViewFor(mapName: string): { center: [number, number]; zoom: number } {
    if (mapName === 'world') {
      // 次区域/大洲视图优先于世界记忆：切范围必须聚焦该范围，不能被「上次世界视野」覆盖
      if (this.worldSubregion) return this.subregionView(this.worldSubregion);
      if (this.worldContinent) return this.continentView(this.worldContinent);
      if (this.savedWorldView) {
        return { center: [this.savedWorldView.center[0], this.savedWorldView.center[1]], zoom: this.savedWorldView.zoom };
      }
    } else if (this.savedChinaView) {
      return { center: [this.savedChinaView.center[0], this.savedChinaView.center[1]], zoom: this.savedChinaView.zoom };
    }
    const def = this.defaultViewFor(mapName);
    return { center: [def.center[0], def.center[1]], zoom: def.zoom };
  }

  /** 应用地图相机（含记忆恢复），并 setOption 生效。 */
  private applyMapCamera(mapName = this.currentMapName()) {
    const v = this.pickViewFor(mapName);
    this.center = [v.center[0], v.center[1]];
    this.zoom = v.zoom;
    this.chart.setOption({ geo: { map: mapName, center: this.center, zoom: this.zoom } });
    this.cullToViewport(); // 相机切换后视口范围变化（如省→全国）
    this.onZoomChange?.();
  }

  setDarkMode(darkMode: boolean) {
    const next: ThemeName = darkMode ? 'dark' : 'light';
    if (next === this.themeName) return;
    this.themeName = next;
    if (this.lastState) this.render(this.lastState);
  }

  setBoundaryTones(cityBoundaryTone: BoundaryTone, provinceBoundaryTone: BoundaryTone, worldBoundaryTone: BoundaryTone = this.worldBoundaryTone) {
    if (
      cityBoundaryTone === this.cityBoundaryTone &&
      provinceBoundaryTone === this.provinceBoundaryTone &&
      worldBoundaryTone === this.worldBoundaryTone
    ) {
      return;
    }
    this.cityBoundaryTone = cityBoundaryTone;
    this.provinceBoundaryTone = provinceBoundaryTone;
    this.worldBoundaryTone = worldBoundaryTone;
    if (this.lastState) this.render(this.lastState);
  }

  /** 省级模式：仅渲染省级地图（35 个省面），不渲染地级市行政区；港澳放大框与下钻能力可选。 */
  setProvinceMode(on: boolean, opts: { inset?: boolean; allowDrill?: boolean } = {}) {
    const nextInset = opts.inset ?? true;
    const nextDrill = opts.allowDrill ?? false;
    if (this.provinceMode === on && this.provinceModeInset === nextInset && this.provinceModeDrill === nextDrill && !this.worldMode) return;
    const wasWorld = this.worldMode;
    // 离开世界（进入中国）：先把世界上次视野存入世界槽（此时仍处于世界状态，快照的是世界画面）
    if (wasWorld) this.snapshotViewBeforeLeave();
    this.worldMode = false;
    this.provinceMode = on;
    this.provinceModeInset = nextInset;
    this.provinceModeDrill = nextDrill;
    let restoreCamera = false;
    if (wasWorld) {
      // 世界 → 中国：恢复中国记忆（省级/地级共用一槽），无记忆则默认居中
      this.savedNationView = null;
      this.viewProvince = null;
      this.viewProvinceBox = null;
      this.labelMode = 'none';
      const v = this.pickViewFor(this.currentMapName());
      this.center = [v.center[0], v.center[1]];
      this.zoom = v.zoom;
      restoreCamera = true; // 地图名从 world → china/china-provinces，末尾显式写回相机
    } else if (this.viewProvince) {
      // 离开钻省状态回到全国：若存在下钻前视图快照则恢复之（否则回默认全国视图）
      const saved = this.savedNationView;
      this.savedNationView = null;
      this.viewProvince = null;
      this.viewProvinceBox = null;
      this.center = saved ? saved.center : this.defaultViewFor(this.currentMapName()).center;
      this.zoom = saved ? saved.zoom : this.defaultViewFor(this.currentMapName()).zoom;
      this.labelMode = 'none';
      restoreCamera = true;
    }
    if (!this.worldMode && this.provinceMode && this.provinceModeInset) this.inset.show();
    else this.inset.hide();
    if (this.lastState) this.render(this.lastState);
    if (restoreCamera) {
      // render 可能因地图切换（china ↔ china-provinces）重置相机，显式写回目标相机
      this.applyMapCamera(this.currentMapName());
    }
  }

  /**
   * 世界模式：只渲染世界地图（195 答题国 + 装饰面），无放大框、无省级下钻；退出时复位到全国视图。
   * continent 非空时进入「大洲视图」：聚焦该洲 bbox，且只渲染该洲国家（其他洲隐藏）。
   * subregion 非空时进入「次区域视图」：在该洲内进一步只渲染该次区域国家并聚焦之（次区域 ⊆ 大洲）。
   * 传入的 subregion 若不属于该洲会被忽略（视为全洲）——避免状态不一致时渲染出空地图。
   */
  setWorldMode(on: boolean, continent: Continent | null = null, subregion: SubregionId | null = null) {
    const nextSub = on && continent && subregion && this.subregionContinent(subregion) === continent ? subregion : null;
    if (this.worldMode === on && !this.provinceMode && this.worldContinent === continent && this.worldSubregion === nextSub) return;
    const wasWorld = this.worldMode;
    // 跨越世界/中国边界：先把当前族（离开方）的全国视野存入其记忆槽
    if (on !== wasWorld) this.snapshotViewBeforeLeave();
    this.worldMode = on;
    this.worldContinent = on ? continent : null;
    this.worldSubregion = nextSub;
    this.provinceMode = false;
    this.provinceModeInset = false;
    this.provinceModeDrill = false;
    this.inset.hide();
    if (on !== wasWorld) {
      // 进入目标族：恢复其记忆（无则默认居中）
      this.savedNationView = null;
      this.viewProvince = null;
      this.viewProvinceBox = null;
      this.labelMode = 'none';
    }
    if (on && nextSub) {
      // 次区域视图：聚焦该次区域 bbox（比大洲更近）
      const v = this.subregionView(nextSub);
      this.center = [v.center[0], v.center[1]];
      this.zoom = v.zoom;
    } else if (on && this.worldContinent) {
      // 大洲视图：聚焦该洲 bbox
      const v = this.continentView(this.worldContinent);
      this.center = [v.center[0], v.center[1]];
      this.zoom = v.zoom;
    } else if (on !== wasWorld) {
      const v = this.pickViewFor(this.currentMapName());
      this.center = [v.center[0], v.center[1]];
      this.zoom = v.zoom;
    }
    if (this.lastState) this.render(this.lastState);
    this.applyMapCamera(this.currentMapName());
    this.onViewChange?.();
  }

  /** 当前大洲视图（null = 全世界）。 */
  currentContinent(): Continent | null {
    return this.worldContinent;
  }

  /** 当前次区域视图（null = 全洲或全世界）。 */
  currentSubregion(): SubregionId | null {
    return this.worldSubregion;
  }

  /**
   * 设置被「忽略面积极小的国家」排除的 iso 集合。
   *
   * 这些国家**保留灰色面**（而不是删除几何）：
   *  1. 无交互靠 `silent: true` 实现，与装饰面同一套机制；
   *  2. 梵蒂冈嵌在意大利的一个内部环（空洞）里，删掉它的面会在意大利上留下缺口，
   *     灰色面正好填住这个洞，地图完整性不受影响。
   * 集合变化时若正在世界模式则立即重渲染。
   */
  setExcludedCountries(isos: Iterable<string>) {
    const next = new Set(isos);
    const same = next.size === this.excludedIso.size && [...next].every((i) => this.excludedIso.has(i));
    if (same) return;
    this.excludedIso = next;
    this.worldExcludedNames.clear();
    for (const [name, iso] of this.worldNameToIso) if (next.has(iso)) this.worldExcludedNames.add(name);
    if (this.worldMode && this.lastState) this.render(this.lastState);
  }

  /** 世界层是否有可返回的上级（大洲或次区域下钻中）。 */
  hasWorldDrill(): boolean {
    return this.worldMode && (this.worldContinent !== null || this.worldSubregion !== null);
  }

  /**
   * 当前视图是否有「上一级」可返回（点空白返回的判定）。
   * 中国：钻省（viewProvince）；世界：大洲或次区域下钻中。
   * 注意这是**视图能力**判定，不代表允许执行——答题进行中的拦截在模式层（Q7/Q13）。
   */
  private hasDrillLevel(): boolean {
    return this.viewProvince !== null || this.hasWorldDrill();
  }

  /** 次区域 → 所属大洲（由 data.subregions 元数据查；无命中返回 null）。 */
  private subregionContinent(id: SubregionId): Continent | null {
    return this.data.subregions.find((s) => s.id === id)?.continent ?? null;
  }

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
  private static readonly CONTINENT_VIEWS: Record<Continent, [number, number, number, number]> = {
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

  /** 计算某大洲的聚焦 center/zoom（按标定框换算，见 CONTINENT_VIEWS 的说明）。 */
  private continentView(c: Continent): { center: [number, number]; zoom: number } {
    return this.viewFromBox(MapRenderer.CONTINENT_VIEWS[c]);
  }

  /**
   * 次区域聚焦框（手工标定，lng0/lat0/lng1/lat1；与 CONTINENT_VIEWS 同一套道理）。
   *
   * 为什么同样手标：
   *   - 「东欧」含俄罗斯 → 自动 bbox 会从 20°E 拉到 180°E，把视角推成半个北半球；
   *   - 「波利尼西亚/密克罗尼西亚/美拉尼西亚」跨 180° 经线，自动 bbox 直接撑成 360°；
   *   - 「加勒比」是弧状群岛，自动 bbox 会把大西洋一起框进来。
   * 框外的远端岛屿仍可通过拖动到达（roam 已开启），取景是 UI 决策而非数据推导。
   */
  private static readonly SUBREGION_VIEWS: Record<SubregionId, [number, number, number, number]> = {
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
  private viewFromBox(box: [number, number, number, number]): { center: [number, number]; zoom: number } {
    const [x0, y0, x1, y1] = box;
    const center: [number, number] = [(x0 + x1) / 2, (y0 + y1) / 2];
    const spanX = Math.max(x1 - x0, 1e-6);
    return { center, zoom: clampZoom((360 / spanX) * 0.88) };
  }

  /** 计算某次区域的聚焦 center/zoom（按标定框换算）。 */
  private subregionView(id: SubregionId): { center: [number, number]; zoom: number } {
    return this.viewFromBox(MapRenderer.SUBREGION_VIEWS[id]);
  }

  /** 显示港澳放大框（延迟到容器可见后再初始化图表，否则 ECharts 按 0 尺寸渲染）。 */
  private theme(): MapTheme {
    return MAP_THEMES[this.themeName];
  }

  /**
   * 组装数据层的只读输入。
   *
   * 这是 `MapRenderer` 与 `./layers.ts` 之间**唯一**的桥：本类的 19 个字段在此摊平成一份
   * 显式 context，数据层因此不持有对渲染器的任何引用 —— 它可以脱离 ECharts 实例单独测。
   * 每次 render 组装一次，同一个 context 喂给所有构造器。
   */
  private layerInput(state: RenderState): LayerInput {
    return {
      data: this.data,
      state,
      theme: this.theme(),
      zoom: this.zoom,
      worldMode: this.worldMode,
      provinceMode: this.provinceMode,
      viewProvince: this.viewProvince,
      labelMode: this.labelMode,
      worldContinent: this.worldContinent,
      worldSubregion: this.worldSubregion,
      cityBoundaryTone: this.cityBoundaryTone,
      worldBoundaryTone: this.worldBoundaryTone,
      excludedIso: this.excludedIso,
      units: this.units,
      labelAnchors: this.labelAnchors,
      provinceLabelAnchors: this.provinceLabelAnchors,
      worldLabelAnchors: this.worldLabelAnchors,
      isoContinent: this.isoContinent,
      isoSubregion: this.isoSubregion,
    };
  }

  /**
   * 按 zoom 解析当前档位（阈值与映射见 ./tiers.ts，有单测覆盖）。
   * 钻省时强制 lossless：钻省后视口只剩一个省，顶点再多也被裁剪挡住。
   */
  private activeTier(): Tier {
    return tierOfZoom(this.zoom, this.viewProvince !== null);
  }

  /** 省界线当前档（与地级档位同步换档，五档）。 */
  private activeProvinceLines(): { adcode: string; coords: number[][] }[] {
    return this.provinceLines[this.activeTier()];
  }

  /** 当前视图下的省界线数据（下钻时只保留当前省）；世界模式无省界线。 */
  private buildLineData(): { coords: number[][] }[] {
    if (this.worldMode) {
      this.lineBoxes = [];
      return [];
    }
    const lines = this.activeProvinceLines()
      .filter((l) => !this.viewProvince || l.adcode === this.viewProvince || (l.adcode === '100000_JD' && this.viewProvince === '460000'))
      .map((l) => ({ coords: l.coords }));
    // 逐帧裁剪需要每个元素的数据坐标 bbox：构建时算一次，拖动时只做区间比较
    this.lineBoxes = lines.map((l) => boxOfCoords(l.coords));
    return lines;
  }

  private worldFaceContext(): WorldFaceContext {
    return {
      continent: this.worldContinent,
      subregion: this.worldSubregion,
      isoContinent: this.isoContinent,
      isoSubregion: this.isoSubregion,
    };
  }

  /**
   * 世界面是否可交互（悬停高亮 / 点击 / tooltip）。
   *
   * 不可交互的三种面：
   *  1. 当前范围之外的面——下钻到大洲/次区域后，其余洲的国面**仍在几何上存在**，
   *     若不判范围，悬停空白处会高亮一个看不见的国家、点击还会跳到它的上级区域；
   *  2. 被「忽略面积极小的国家」排除的面；
   *  3. 装饰面（属地/南极等）。
   *
   * 三者都由 buildWorldRegionData 渲染成 `silent: true` 的几何面（ECharts 对 silent
   * region 既不派发事件也不做 emphasis 高亮），这里的判断用于 name→iso 回传的兜底。
   */
  private worldFaceInteractive(name: string): boolean {
    return worldFaceInteractive(this.worldFaceContext(), name, {
      nameToIso: this.worldNameToIso,
      decorativeNames: this.worldDecorativeNames,
      excludedNames: this.worldExcludedNames,
    });
  }


  private provinceFeatureName(adcode: string): string {
    const geo = this.data.provincesGeoJson as { features?: GeoFeature[] };
    const f = (geo.features ?? []).find((x) => x.properties.adcode === adcode);
    return f?.properties.name ?? '';
  }

  private desiredLabelMode(state: RenderState | null = this.lastState): 'none' | 'city' {
    // 世界模式：地级市标签系列不参与；国名标签由 world-labels 系列渲染。
    // 世界分析/浏览档国名是否常显由 worldShowAllLabels + worldLabelZoomThreshold 决定
    //（未开始的浏览标签与熟练度分析传 0 = 任何倍率都显示），把该开关复用到 'city' 档位以驱动缩放后刷新。
    if (this.worldMode) {
      if (!state?.hideLabels && state?.worldShowAllLabels && this.zoom > (state?.worldLabelZoomThreshold ?? WORLD_LABEL_ZOOM)) {
        return 'city';
      }
      return 'none';
    }
    // 省级模式：彻底禁用地级市地名标签（省名标签由 province-labels 系列单独渲染）
    if (this.provinceMode) return 'none';
    const threshold = state?.labelZoomThreshold ?? LABEL_ZOOM;
    return this.zoom > threshold ? 'city' : 'none';
  }

  private applyLabelMode() {
    const mode = this.desiredLabelMode();
    if (mode === 'none' && this.labelMode === 'none') return;
    const scale = labelScale(this.zoom);
    const changed = mode !== this.labelMode || scale !== this.labelScaleApplied;
    this.labelMode = mode;
    this.labelScaleApplied = scale;
    if (changed && this.lastState) {
      // 世界分析档国名标签随缩放进出显示阈值，也在缩放结束后同步
      const ctx = this.layerInput(this.lastState);
      const patch: Record<string, unknown> = {
        'city-labels': { data: buildLabelData(ctx) },
        'province-labels': { data: buildProvinceLabelData(ctx) },
        'world-labels': { data: buildWorldLabelData(ctx) },
      };
      this.chart.setOption({ series: Object.entries(patch).map(([id, o]) => ({ id, ...(o as object) })) } as never);
    }
  }

  private scheduleLabelModeUpdate() {
    if (this.labelUpdateTimer !== null) window.clearTimeout(this.labelUpdateTimer);
    this.labelUpdateTimer = window.setTimeout(() => {
      this.labelUpdateTimer = null;
      // zoom 停止变化后：先按 zoom 档位决定是否换地图档（五档），再刷标签。
      // 换档需完整 render（replaceMerge 重建 geo），不能只 applyLabelMode。
      const settledMap = this.worldMode ? 'world' : this.provinceMode ? this.provinceTierMapName() : this.chinaTierMapName();
      const applied = this.appliedMapName;
      if (applied && settledMap !== applied && this.lastState) {
        this.render(this.lastState);
        return;
      }
      this.applyLabelMode();
    }, LABEL_UPDATE_DELAY);
  }

  /** 按当前模式状态重绘（保留用户缩放/平移） */
  render(state: RenderState) {
    this.lastState = state;
    this.labelMode = this.desiredLabelMode(state);
    this.labelScaleApplied = labelScale(this.zoom);

    // 世界模式 geo 切世界地图；省级模式切省级地图；否则地级地图（按 zoom/钻省切五档）
    const mapName = this.currentMapName();
    const theme = this.theme();
    // 数据层的只读输入组装**一次**，喂给所有构造器（见 ./layers.ts）
    const ctx = this.layerInput(state);

    // option 的三块大件各自成方法：它们原先首尾相接成一坨 166 行的字面量，
    // 读的人分不清哪几行属于 tooltip、哪几行属于 geo 的投影钉死、哪几行属于 5 条 series。
    const option: echarts.EChartsOption = {
      backgroundColor: theme.background,
      animation: false,
      animationDuration: 0,
      animationDurationUpdate: 0,
      tooltip: this.buildTooltipOption(state, theme),
      geo: this.buildGeoOption(mapName, ctx),
      series: this.buildSeriesOption(mapName, ctx),
    };
    // ECharts 已知问题：geo 组件的 map 在多个已注册地图间切换（省级↔市级↔世界）时，
    // 普通 setOption 合并会让 geo 停留在上一次绘制状态 → 切回后中国地图整片空白。
    // 检测到 geo 地图名变化时用 replaceMerge 强制重建 geo（与同级 series/map），确保重绘新地图面。
    const mapChanged = mapName !== this.appliedMapName;
    // 大洲/次区域切换时地图名不变（同为 world），但 geo.regions 数组整体变化（隐藏其他面）：
    // 普通合并可能残留上一范围的 region 样式，故与地图切换同样走 replaceMerge。
    const continentKey = `${mapName}|${this.worldContinent ?? ''}|${this.worldSubregion ?? ''}`;
    const continentChanged = continentKey !== this.appliedContinentKey;
    this.appliedContinentKey = continentKey;
    this.appliedMapName = mapName;
    this.chart.setOption(option, mapChanged || continentChanged ? { replaceMerge: ['geo', 'series'] } : undefined);
    // 大洲切换重建 geo 后同样需要写回相机（否则 replaceMerge 丢相机 → 回到默认全球视野）
    if (continentChanged && !mapChanged) {
      this.chart.setOption({ geo: { map: mapName, center: this.center, zoom: this.zoom } });
    }
    if (mapChanged) {
      // 地图切换（世界↔省级↔地级）：replaceMerge 重建的 geo 不继承相机，
      // 需显式写回当前相机。this.center/zoom 由调用方（setWorldMode/setProvinceMode/backToNation/drill）
      // 在 render 前已按「跨族记忆恢复或默认居中」设置好，此处不得再强制复位默认，
      // 否则会覆盖刚恢复的切回位置（如世界→中国恢复上次视野）。
      this.chart.setOption({ geo: { map: mapName, center: this.center, zoom: this.zoom } });
      this.onZoomChange?.();
    }
    // 省级模式下同步刷新港澳放大框着色；期望显示时确保容器可见（防任何路径误隐藏后无 render 恢复）
    if (this.provinceMode && this.provinceModeInset) this.inset.show();
    // 视口裁剪必须放在最后一次 setOption 之后：replaceMerge 会重建 region 组、
    // 清掉上一轮的 ignore 标记，且换档后可见集合本身也变了。
    this.cullToViewport();
  }

  /** tooltip：三档粒度各一套文案；不可交互的面（其他洲 / 被排除的极小国 / 装饰面）只显示面名。 */
  private buildTooltipOption(state: RenderState, theme: MapTheme): echarts.EChartsOption['tooltip'] {
    return state.disableTooltip
      ? { show: false }
      : {
          trigger: 'item',
          backgroundColor: theme.tooltipBg,
          borderColor: theme.tooltipBorder,
          textStyle: { color: theme.tooltipText },
          formatter: (p) => {
            const params = p as { name?: string };
            const hitName = params.name ?? '';
            if (this.worldMode) {
              const iso = this.worldNameToIso.get(hitName);
              // 不可交互的面（其他洲 / 被排除的极小国 / 装饰面）不显示答题态 tooltip
              if (!iso || !this.worldFaceInteractive(hitName)) return String(hitName);
              const color: UnitColor = state.colorOf(iso);
              return t('map.tooltip.worldBody', { name: hitName, status: t('map.tooltip.statusLine', { status: STATUS_TXT[color] }) });
            }
            const u = this.nameToUnit.get(hitName);
            if (!u) return String(hitName);
            if (state.coin) {
              const coins = u.decorative ? 0 : state.coin.coins(u.adcode);
              const coinsTxt = coins > 0 ? `${coins}￥` : t('map.tooltip.coinCollected');
              return t('map.tooltip.body', { name: u.name, province: u.province, coins: coinsTxt });
            }
            const color: UnitColor = u.decorative ? 'gray' : state.colorOf(u.adcode);
            const status = u.decorative ? '' : t('map.tooltip.statusLine', { status: STATUS_TXT[color] });
            return t('map.tooltip.bodyBase', { name: u.name, province: u.province, status });
          },
        };
  }

  /** geo 组件：地图名 + 投影钉死（boundingCoords）+ regions（世界 / 省级 / 地级三分支）。 */
  private buildGeoOption(mapName: string, ctx: LayerInput): echarts.EChartsOption['geo'] {
    const theme = ctx.theme;
    return {
      map: mapName, // 世界/省级用专属地图；否则用地级地图（series 绑定后使用同一地图，地名才能匹配上）
      roam: true,
      scaleLimit: { min: MIN_ZOOM, max: MAX_ZOOM },
      silent: false,
      selectedMode: false,
      tooltip: { show: false },
      label: { show: false },
      emphasis: {
        label: { show: false },
        itemStyle: { areaColor: theme.hoverArea }, // 悬停高亮（半透明遮罩，覆盖整个面）
      },
      select: { label: { show: false } },
      itemStyle: {
        areaColor: 'rgba(0,0,0,0)',
        borderColor: 'rgba(0,0,0,0)',
        borderWidth: 0, // geo 自身透明；边界由 geo.regions / province-lines 绘制
      },
      regions: ctx.worldMode
        ? buildWorldRegionData(ctx)
        : ctx.provinceMode
          ? buildProvinceRegionData(ctx)
          : buildRegionData(ctx),
      // 固定投影范围：ECharts 默认按**当前几何 bbox** 自动适配投影，而各简化档的 bbox 并不相同
      // （ultra/省级粗档把南海诸岛最南端简掉了，纬度下界 3.3974 → 3.5349，高度少 0.1375°）。
      // bbox 一变，投影比例与偏移就变 → 缩放跨换档阈值时整幅地图微移、鼠标所指位置偏移。
      // 用 boundingCoords 把投影范围钉死为常量，各档共用同一投影 → 换档前后像素位置完全一致。
      boundingCoords: MAP_PROJECTION_BBOX[this.worldMode ? 'world' : 'china'],
    };
  }

  /** 5 条 series：事件层、省界线、以及三条标签层。 */
  private buildSeriesOption(mapName: string, ctx: LayerInput): echarts.EChartsOption['series'] {
    const theme = ctx.theme;
    return [
      this.eventSeries(mapName, ctx),
      this.provinceLinesSeries(theme),
      // 世界练习的国名标签：随缩放缩小
      this.provinceLikeLabelSeries('world-labels', 10, buildWorldLabelData(ctx), theme, () => labelScale(this.zoom)),
      this.cityLabelSeries(buildLabelData(ctx), theme),
      // 省级练习的省名标签：已作答省的简称，**始终显示**。字号固定为最大档（scale=1）、
      // 不随缩放缩小，故恒按「放大足够时」的样式渲染（字号/衬底/间距统一最大）；
      // z = 9 低于 city-labels 但高于省界线。
      this.provinceLikeLabelSeries('province-labels', 9, buildProvinceLabelData(ctx), theme, () => 1),
    ];
  }

  /** 事件层：只提供 data 用于 tooltip/事件；区域样式由 geo.regions 负责。 */
  private eventSeries(mapName: string, ctx: LayerInput): SeriesItem {
    const data = ctx.worldMode
      ? buildWorldEventData(ctx)
      : ctx.provinceMode
        ? buildProvinceEventData(ctx.data)
        : buildCityEventData(ctx.units);
    return {
      id: 'city-events',
      type: 'map',
      map: mapName,
      geoIndex: 0,
      selectedMode: false,
      label: { show: false },
      emphasis: { label: { show: false } },
      select: { label: { show: false } },
      data,
    };
  }

  /** 省界线层：粗线画在地级面之上（世界模式无省界线，buildLineData 返回空）。 */
  private provinceLinesSeries(theme: MapTheme): SeriesItem {
    return {
      id: 'province-lines',
      type: 'lines',
      coordinateSystem: 'geo',
      geoIndex: 0,
      z: 3, // 画在地级面之上
      silent: true,
      tooltip: { show: false },
      polyline: true, // 必须开启：false 时每个省界环只取前两个点，边界基本不可见
      lineStyle: { color: theme.boundary[this.provinceBoundaryTone], width: 2.4, opacity: 1 },
      data: this.buildLineData(),
    };
  }

  /**
   * 国名 / 省名标签层。
   *
   * 这两条 series 的骨架**完全相同**（同 geoIndex、同 silent、同无 tooltip、同字号与衬底
   * 比例），原先各写一份、只差 id / z / 「scale 从哪来」。合并成一个工厂，免得两份
   * renderItem 各自漂移（改了一处忘另一处）。调用点：
   *   · 国名标签（世界练习）随缩放缩小 → `() => labelScale(this.zoom)`
   *   · 省名标签（省级练习）恒按放大足够时的样式渲染 → `() => 1`
   *
   * `scaleOf` 是**闭包**而不是值，这一点是硬要求：ECharts 会在缩放/拖动期间反复调用
   * `renderItem`，每次都该读当时的 `this.zoom`。若在构建 option 时取快照，标签字号
   * 会在缩放过程中卡住（不报错、只是"看起来有点怪"的回归）。
   */
  private provinceLikeLabelSeries(
    id: string,
    z: number,
    data: LabelPoint[],
    theme: MapTheme,
    scaleOf: () => number,
  ): SeriesItem {
    return {
      id,
      type: 'custom',
      coordinateSystem: 'geo',
      geoIndex: 0,
      z,
      silent: true,
      tooltip: { show: false },
      renderItem: (_params, api) => {
        const parsed = parseLabelValue(api);
        if (!parsed) return { type: 'group', children: [] };
        const scale = scaleOf();
        return buildLabelGraphic({
          ...parsed,
          scale,
          theme,
          fontSize: PROVINCE_LABEL_SIZE * scale,
          padX: 7 * scale,
          padY: 4 * scale,
          minWidth: 30 * scale,
          fontWeight: 600,
        });
      },
      data,
    };
  }

  /** 地名标签层（含无尽闯关的价格标签：字号与衬底按 `isPrice` 分档，故与上面那条不共用）。 */
  private cityLabelSeries(data: LabelPoint[], theme: MapTheme): SeriesItem {
    return {
      id: 'city-labels',
      type: 'custom',
      coordinateSystem: 'geo',
      geoIndex: 0,
      z: 10,
      silent: true,
      tooltip: { show: false },
      renderItem: (_params, api) => {
        const parsed = parseLabelValue(api);
        if (!parsed) return { type: 'group', children: [] };
        const scale = labelScale(this.zoom);
        const fontSize = (parsed.isPrice ? PRICE_LABEL_SIZE : CITY_LABEL_SIZE) * scale;
        return buildLabelGraphic({
          ...parsed,
          scale,
          theme,
          fontSize,
          padX: (parsed.isPrice ? 4 : 8) * scale,
          padY: (parsed.isPrice ? 3 : 6) * scale,
          minWidth: (parsed.isPrice ? 26 : 34) * scale,
          fontWeight: parsed.isPrice ? 700 : 600,
        });
      },
      data,
    };
  }

  /**
   * 只渲染当前视角范围内的地级面与省界线（详见 cull.ts 的说明）。
   *
   * 调用点有两处：render() 末尾（geo 重建后标记会被重置）与 georoam（视口移动后可见集合变化）。
   * 刷新成本约为面 1.2ms + 线 0.1ms，可安全地每帧执行。
   */
  private cullToViewport() {
    if (this.worldMode) return; // 世界图面数很少，且国名标签需常显
    cullToViewport(this.chart, this.lineBoxes);
  }

  /** 清除临时黄色高亮（点击空白/其他区域时立即恢复） */
  private clearFlash() {
    if (this.flashTimer !== null) {
      window.clearTimeout(this.flashTimer);
      this.flashTimer = null;
    }
    if (!this.flashAdcode) return;
    this.flashAdcode = null;
    if (this.lastState) this.render(this.lastState);
  }

  /** 标记成功时的高亮动画（临时改色后恢复，不依赖 emphasis 机制）；省级按省面 name、世界按国名匹配。 */
  flash(adcode: string) {
    let matchName = '';
    if (this.worldMode) matchName = this.worldIsoToName.get(adcode) ?? '';
    else if (this.provinceMode) matchName = this.provinceFeatureName(adcode);
    else matchName = this.adcodeToUnit.get(adcode)?.name ?? '';
    if (!matchName) return;
    this.clearFlash();
    const opt = this.chart.getOption() as {
      geo?: { regions?: GeoRegion[] }[] | { regions?: GeoRegion[] };
    };
    const geos = Array.isArray(opt.geo) ? opt.geo : [opt.geo];
    const regions = geos[0]?.regions;
    const theme = this.theme();
    if (Array.isArray(regions)) {
      for (const item of regions) {
        if (item.name === matchName) {
          item.itemStyle = { ...item.itemStyle, areaColor: theme.flashArea, borderColor: theme.flashBorder, borderWidth: 1.2 };
        }
      }
      // setOption 改 geo.regions 会重建 MapDraw 的 region 组 → 清掉上一轮的 ignore 标记，
      // 故必须紧跟一次裁剪，否则每次高亮都会让整幅地图重新参与构建与绘制（丢失裁剪收益）。
      this.chart.setOption({ geo: { regions } } as never);
      this.cullToViewport();
    }
    this.flashAdcode = adcode;
    this.flashTimer = window.setTimeout(() => {
      if (this.flashAdcode === adcode) {
        this.flashAdcode = null;
        this.flashTimer = null;
        if (this.lastState) this.render(this.lastState);
      }
    }, 900);
  }

  focusUnit(adcode: string, _zoom: number) {
    if (this.worldMode) return; // 世界模式无自动聚焦（输入模式世界档不跟随）
    const u = this.units.find((item) => item.adcode === adcode);
    if (!u) return;
    if (this.viewProvince && this.viewProvince !== u.provinceAdcode) {
      this.viewProvince = null;
      this.viewProvinceBox = null;
      if (this.lastState) this.render(this.lastState);
    }
    const extent = this.framingExtent();
    const win = this.viewportWindow();
    const zoom = followZoomFloor(win, this.zoom, extent, this.followZoomFor(u.provinceAdcode));
    const center = clampFollowCenter(win, this.zoom, u.center, zoom, extent);
    if (isNegligibleMove(win, this.center, this.zoom, center, zoom)) return; // 钳制后基本没动，就别白跑一趟动画
    this.animateViewTo(center, zoom);
  }

  /**
   * 世界模式自动跟随：镜头移到某国，**缩放倍率与国家面积成反比**（面积越小放得越大）。
   *
   * 倍率由 `worldFollowZoom(面积)` 按绝对映射算出（`A − B·ln(面积)`，夹到 [3, 28]）：
   * 极小国顶到地图上限 28x、法国约 8x、俄罗斯 3x，标定见该函数的注释；
   * 再取 `followZoomFloor()` 的倍率下限（取景边界必须覆盖视口）。落点经 `clampFollowCenter()` 钳制。
   */
  focusWorldCountry(iso: string) {
    if (!this.worldMode) return;
    const center = this.worldLabelAnchors.get(iso);
    if (!center) return;
    const extent = this.framingExtent();
    const win = this.viewportWindow();
    const zoom = followZoomFloor(win, this.zoom, extent, worldFollowZoom(this.countryArea(iso)));
    const next = clampFollowCenter(win, this.zoom, [center[0], center[1]], zoom, extent);
    if (isNegligibleMove(win, this.center, this.zoom, next, zoom)) return;
    this.animateViewTo(next, zoom);
  }

  /** 把镜头移到某国**但不改变缩放**（所有模式答错时跟随到正确答案位置用）。 */
  panWorldCountry(iso: string) {
    if (!this.worldMode) return;
    const center = this.worldLabelAnchors.get(iso);
    if (center) this.panFollow([center[0], center[1]]);
  }

  /** 把镜头移到某地级单位**但不改变缩放**（中国族答错时跟随）。 */
  panUnit(adcode: string) {
    const u = this.units.find((item) => item.adcode === adcode);
    if (u) this.panFollow(u.center);
  }

  // ==================== 跟随钳制（取景边界 + 边距） ====================

  /**
   * 当前视图的**取景边界**：视口允许显示的数据矩形（lng0/lat0/lng1/lat1）。
   *
   * 视口越出它就会露出纯背景色 —— 这正是「跟随把边界附近的目标顶到正中 → 半屏空白」的根因。
   * 分层取值：下钻省 = 该省地级单位并集 bbox；世界次区域/大洲 = 各自标定框；
   * 否则按地图族用钉死的投影 bbox（中国 / 世界）。
   */
  private framingExtent(): [number, number, number, number] {
    if (this.worldMode) {
      if (this.worldSubregion) return MapRenderer.SUBREGION_VIEWS[this.worldSubregion];
      if (this.worldContinent) return MapRenderer.CONTINENT_VIEWS[this.worldContinent];
      return flattenBBox(MAP_PROJECTION_BBOX.world);
    }
    if (this.viewProvince && this.viewProvinceBox) return this.viewProvinceBox;
    return flattenBBox(MAP_PROJECTION_BBOX.china);
  }

  /** geo 坐标系（读数用）：`pointToData` 把画布像素换算成经纬度。 */
  private geoCoordSystem(): { pointToData?: (p: number[]) => number[] } | null {
    const geoModel = (this.chart as unknown as {
      getModel: () => { getComponent: (t: string) => { coordinateSystem?: unknown } | null };
    }).getModel().getComponent('geo');
    const cs = geoModel?.coordinateSystem as { pointToData?: (p: number[]) => number[] } | undefined;
    return cs?.pointToData ? cs : null;
  }

  /**
   * 当前视口在数据坐标下的矩形 + 每像素度数。
   *
   * 投影经 `boundingCoords` 钉死后 lng/lat → 像素是线性映射（与 cull.ts 同一假设），
   * 故取画布两角经 `pointToData` 换算即可；geo 未就绪时返回 null（调用方按"未钳制"处理）。
   */
  private viewportWindow(): { box: [number, number, number, number]; perPxX: number; perPxY: number; width: number; height: number } | null {
    const cs = this.geoCoordSystem();
    if (!cs?.pointToData) return null;
    const width = this.chart.getWidth();
    const height = this.chart.getHeight();
    if (!(width > 0) || !(height > 0)) return null;
    const a = cs.pointToData([0, 0]);
    const b = cs.pointToData([width, height]);
    if (!a || !b || ![a[0], a[1], b[0], b[1]].every((v) => Number.isFinite(v))) return null;
    const box: [number, number, number, number] = [
      Math.min(a[0], b[0]),
      Math.min(a[1], b[1]),
      Math.max(a[0], b[0]),
      Math.max(a[1], b[1]),
    ];
    return { box, perPxX: (box[2] - box[0]) / width, perPxY: (box[3] - box[1]) / height, width, height };
  }

  /**
   * 只平移的跟随（答错跟随，缩放不变）：目标已舒适可见就**完全不动**（闪红本身已是反馈），
   * 否则钳制后平移。
   *
   * 策略在 `./follow.ts`（纯函数），这里只负责**测量**（`viewportWindow()`）与执行动画。
   */
  private panFollow(target: [number, number]) {
    const win = this.viewportWindow();
    if (isComfortablyVisible(win, target)) return;
    const extent = this.framingExtent();
    const center = clampFollowCenter(win, this.zoom, target, this.zoom, extent);
    if (isNegligibleMove(win, this.center, this.zoom, center, this.zoom)) return;
    this.animateViewTo(center, this.zoom);
  }

  private countryArea(iso: string): number {
    return this.data.countryArea?.[iso] ?? 0;
  }

  private followZoomFor(provinceAdcode: string) {
    if (WIDE_FOLLOW_PROVINCES.has(provinceAdcode)) return 6;
    if (provinceAdcode === HAINAN_PROVINCE) return 28;
    return 12;
  }

  private animateViewTo(targetCenter: [number, number], targetZoom: number) {
    if (this.followRaf !== null) cancelAnimationFrame(this.followRaf);
    const current = this.currentGeoView();
    const startCenter = current.center;
    const startZoom = current.zoom;
    // 动画期间 map 固定为起点档（避免帧间合并式切换地图名触发 ECharts 空白 bug）；
    // 动画结束后（下方）统一走档位检查，若目标 zoom 跨档则 replaceMerge 换图。
    const animMap = this.worldMode ? 'world' : this.provinceMode ? this.provinceTierMapName() : this.chinaTierMapName();
    const start = performance.now();
    let lastFrame = start - FOLLOW_FRAME_INTERVAL;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / FOLLOW_ANIMATION_MS);
      if (t < 1 && now - lastFrame < FOLLOW_FRAME_INTERVAL) {
        this.followRaf = requestAnimationFrame(step);
        return;
      }
      const k = easeInOutCubic(t);
      const center: [number, number] = [
        startCenter[0] + (targetCenter[0] - startCenter[0]) * k,
        startCenter[1] + (targetCenter[1] - startCenter[1]) * k,
      ];
      this.zoom = clampZoom(startZoom + (targetZoom - startZoom) * k);
      this.center = center;
      this.chart.setOption({ geo: { map: animMap, center, zoom: this.zoom } }, { lazyUpdate: true, silent: true });
      this.cullToViewport(); // 跟随动画每帧更新裁剪，避免动画中出现视口外的空档
      lastFrame = now;
      this.onZoomChange?.();
      if (t < 1) {
        this.followRaf = requestAnimationFrame(step);
      } else {
        this.followRaf = null;
        // 动画结束：若目标 zoom 跨档（如 zoom 1→12 应从 coarse 切 fine），走完整 render 换图
        const targetMap = this.worldMode ? 'world' : this.provinceMode ? this.provinceTierMapName() : this.chinaTierMapName();
        if (targetMap !== this.appliedMapName && this.lastState) {
          this.render(this.lastState);
          return;
        }
        this.applyLabelMode();
      }
    };
    this.followRaf = requestAnimationFrame(step);
  }

  private currentGeoView(): { center: [number, number]; zoom: number } {
    const opt = this.chart.getOption() as { geo?: { center?: number[] }[] | { center?: number[] } };
    const geo = Array.isArray(opt.geo) ? opt.geo[0] : opt.geo;
    const center = geo?.center;
    if (Array.isArray(center) && typeof center[0] === 'number' && typeof center[1] === 'number') {
      this.center = [center[0], center[1]];
    }
    return { center: this.center, zoom: this.zoom };
  }

  /** 下钻到某省：其他区域消失，自动缩放居中。世界模式不支持，直接忽略。 */
  drillToProvince(adcode: string) {
    if (this.worldMode) return; // 世界：国家为最小单元，无省级下钻概念
    if (this.viewProvince === adcode) return; // 幂等
    const units = this.units.filter((u) => u.provinceAdcode === adcode && !u.decorative);
    if (!units.length) return;
    const geo = this.data.geoJson as {
      features: { properties: { adcode: string }; geometry: { coordinates: unknown } }[];
    };
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const u of units) {
      const feat = geo.features.find((f) => f.properties.adcode === u.adcode);
      if (!feat) continue;
      const b = bboxOf(feat);
      minX = Math.min(minX, b[0]);
      minY = Math.min(minY, b[1]);
      maxX = Math.max(maxX, b[2]);
      maxY = Math.max(maxY, b[3]);
    }
    if (!isFinite(minX)) return;
    const bw = Math.max(maxX - minX, 0.5);
    const bh = Math.max(maxY - minY, 0.5);
    const zoom = clampZoom(Math.max(1.05, (1 / Math.max(bw / NATION_W, bh / NATION_H)) * 0.9));
    if (this.viewProvince === null) {
      // 从全国下钻：记住下钻前的全国视图（缩放/位置），返回全国（backToNation）时恢复
      this.savedNationView = { center: [this.center[0], this.center[1]], zoom: this.zoom };
    }
    this.viewProvince = adcode;
    // 该省几何 bbox 同时充当钻省期间的**取景边界**（邻省透明，越出即露白）
    this.viewProvinceBox = [minX, minY, maxX, maxY];
    this.center = [(minX + maxX) / 2, (minY + maxY) / 2];
    this.zoom = zoom;
    this.labelMode = this.desiredLabelMode();
    if (this.lastState) this.render(this.lastState);
    // 必须带上 map：首次渲染前调用时 geo 组件尚未初始化，缺 map 会加载空地图导致崩溃。
    this.chart.setOption({ geo: { map: this.currentMapName(), center: this.center, zoom } });
    this.cullToViewport(); // 下钻改变相机与地图档，需在此刷新裁剪
    this.onZoomChange?.();
    this.onViewChange?.();
  }

  backToNation() {
    if (this.worldMode) {
      // 世界无下钻概念：回到默认世界视野
      this.savedNationView = null;
      this.viewProvince = null;
      this.viewProvinceBox = null;
      const def = this.defaultViewFor('world');
      this.center = [def.center[0], def.center[1]];
      this.zoom = def.zoom;
      this.labelMode = 'none';
      if (this.lastState) this.render(this.lastState);
      this.chart.setOption({ geo: { map: this.currentMapName(), center: this.center, zoom: this.zoom } });
      this.onZoomChange?.();
      this.onViewChange?.();
      return;
    }
    const saved = this.savedNationView;
    this.savedNationView = null; // 快照一次性使用：返回全国后清除
    this.viewProvince = null;
    this.viewProvinceBox = null;
    if (saved) {
      this.center = saved.center;
      this.zoom = saved.zoom;
    } else {
      const def = this.defaultViewFor(this.currentMapName());
      this.center = [def.center[0], def.center[1]];
      this.zoom = def.zoom;
    }
    this.labelMode = 'none';
    if (this.lastState) this.render(this.lastState);
    this.chart.setOption({ geo: { map: this.currentMapName(), center: this.center, zoom: this.zoom } });
    this.cullToViewport(); // 直接写相机不走 georoam，需在此刷新裁剪
    this.onZoomChange?.();
    this.onViewChange?.();
  }

  /** 地级地图名（五档，映射见 ./tiers.ts）。钻省同样走 lossless。 */
  private chinaTierMapName(): string {
    return chinaMapNameForTier(this.activeTier());
  }

  /** 省级地图名（五档，与地级同一套阈值）。 */
  private provinceTierMapName(): string {
    return provinceMapNameForTier(this.activeTier());
  }

  /** 当前 geo 地图名：世界模式用世界地图，省级模式用省级地图，否则地级地图（均按 zoom 切五档）。 */
  private currentMapName(): string {
    if (this.worldMode) return 'world';
    if (this.provinceMode) return this.provinceTierMapName();
    return this.chinaTierMapName();
  }

  currentProvince(): string | null {
    return this.viewProvince;
  }

  currentZoom() {
    return this.zoom;
  }

  /**
   * 验收探针的**只读**诊断视图（见 `rendererDiagnostics.ts` 的说明）。
   *
   * 生产路径不调用（只有 URL 带 `?probe=1` 时探针取一次）。存在的意义是把「探针依赖哪些
   * 私有状态」变成一份**编译器可校验**的契约：方法体在类内部，任何被改名 / 删除 / 改签名的
   * 成员都会让 `tsc` 在这里直接报错，而不是让探针在验收时静默读到 `undefined`。
   *
   * 返回的是**活值**（getter 直接读当前字段），故探针取一次即可长期持有。
   */
  diagnostics(): MapRendererDiagnostics {
    const self = this;
    return {
      get chart() { return self.chart; },
      get lastState() { return self.lastState; },
      get zoom() { return self.zoom; },
      get center() { return self.center; },
      get labelMode() { return self.labelMode; },
      get worldMode() { return self.worldMode; },
      get provinceMode() { return self.provinceMode; },
      get provinceModeDrill() { return self.provinceModeDrill; },
      get provinceModeInset() { return self.provinceModeInset; },
      get worldContinent() { return self.worldContinent; },
      get worldSubregion() { return self.worldSubregion; },
      get cityBoundaryTone() { return self.cityBoundaryTone; },
      get provinceBoundaryTone() { return self.provinceBoundaryTone; },
      get worldBoundaryTone() { return self.worldBoundaryTone; },
      get worldNameToIso() { return self.worldNameToIso; },
      get worldDecorativeNames() { return self.worldDecorativeNames; },
      get worldExcludedNames() { return self.worldExcludedNames; },
      get isoContinent() { return self.isoContinent; },
      get worldLabelAnchors() { return self.worldLabelAnchors; },
      currentGeoView: () => self.currentGeoView(),
      animateViewTo: (center, zoom) => self.animateViewTo(center, zoom),
      framingExtent: () => self.framingExtent(),
      viewportWindow: () => self.viewportWindow(),
      flash: (adcode) => self.flash(adcode),
      // 数据层已迁到 ./layers.ts；这里保留同签名的薄封装，验收探针的契约不变。
      buildLabelData: (state) => buildLabelData(self.layerInput(state)),
      buildProvinceLabelData: (state) => buildProvinceLabelData(self.layerInput(state)),
      buildWorldLabelData: (state) => buildWorldLabelData(self.layerInput(state)),
    };
  }

  dispose() {
    window.removeEventListener('resize', this.handleResize);
    if (this.labelUpdateTimer !== null) {
      window.clearTimeout(this.labelUpdateTimer);
      this.labelUpdateTimer = null;
    }
    if (this.flashTimer !== null) {
      window.clearTimeout(this.flashTimer);
      this.flashTimer = null;
    }
    if (this.followRaf !== null) {
      cancelAnimationFrame(this.followRaf);
      this.followRaf = null;
    }
    this.chart.dispose();
    this.inset.dispose();
  }
}

