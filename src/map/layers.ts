/**
 * 渲染数据层：从「渲染状态 + 静态查表」算出 `geo.regions` 与各 series 的 `data`。
 *
 * 为什么单独成模块：这些构造器原先都是 `MapRenderer` 的私有方法，但它们**不碰相机、
 * 不碰 ECharts 实例、不碰定时器** —— 输入只有渲染状态、模式标志、以及构造期建好的查表，
 * 输出只有纯数据。混在 1700 行的类里既无法单测，也让「这个类到底管什么」更难回答。
 *
 * **留在渲染器的那部分**（本模块刻意不含）：
 *   · `buildLineData()` 会回写 `lineBoxes`（逐帧裁剪用），有副作用；
 *   · `applyLabelMode()` / `scheduleLabelModeUpdate()` 会碰 ECharts 与定时器；
 *   · `worldFaceInteractive()` / `worldFaceContext()` 是事件处理器用的薄封装。
 *
 * 输入刻意摊成一个 **19 字段的显式 context**（`LayerInput`）：这正是「数据层依赖什么」
 * 的完整清单。原先这些字段可以从 76 个方法里任意读到，改一处不知道会波及谁。
 */
import type * as echarts from 'echarts';
import type { AppData, BoundaryTone, Continent, RenderState, SubregionId, Unit, UnitColor } from '../types';
import { normalizeProvince } from '../matcher';
import type { GeoFeature, GeoPoint } from './geometry';
import { worldFeatureVisible, type WorldFaceContext } from './worldFaces';
import type { MapTheme } from './theme';

/** `geo.regions` 的元素类型（从 ECharts 的 option 类型里取）。 */
export type GeoRegion = NonNullable<echarts.GeoComponentOption['regions']>[number];

/** 标签点的 value 元组：`[lng, lat, 文字, 字色, 是否价格标签, 是否不画衬底]`。 */
export type LabelPoint = { name: string; value: [number, number, string, string, number, number] };

/** 世界分析档国名标签的显示倍率阈值；`RenderState.worldLabelZoomThreshold` 可覆盖它。 */
export const WORLD_LABEL_ZOOM = 2.2;

/**
 * 数据层的**只读**输入：渲染状态 + 模式标志 + 构造期查表。
 *
 * 全部只读 —— 本模块不修改任何输入，也不持有任何跨调用状态。
 */
export interface LayerInput {
  data: AppData;
  state: RenderState;
  theme: MapTheme;
  /** 当前缩放倍率（标签阈值分档用）。 */
  zoom: number;
  /** 世界模式：只渲染世界地图（答题国 + 装饰面）。 */
  worldMode: boolean;
  /** 省级模式：只渲染省级面，不画地级边界。 */
  provinceMode: boolean;
  /** 下钻中的省 adcode；null = 全国视野。 */
  viewProvince: string | null;
  /** 地级市标签模式（'none' = 整组不画），由 `desiredLabelMode` 决定。 */
  labelMode: 'none' | 'city';
  /** 世界范围：大洲 / 次区域（次区域优先）。 */
  worldContinent: Continent | null;
  worldSubregion: SubregionId | null;
  /** 边界深浅设置（全局设置里的三档）。 */
  cityBoundaryTone: BoundaryTone;
  worldBoundaryTone: BoundaryTone;
  /** 被「忽略面积极小的国家」排除的 iso 集合。 */
  excludedIso: Set<string>;
  /** 全部地级/省级单位（含装饰面）。 */
  units: Unit[];
  /** adcode → 文字锚点（主面质心）；缺省时回落单位 center。 */
  labelAnchors: Map<string, GeoPoint>;
  provinceLabelAnchors: Map<string, GeoPoint>;
  /** iso → 标签锚点（世界国名标签用）。 */
  worldLabelAnchors: Map<string, GeoPoint>;
  isoContinent: Map<string, Continent>;
  isoSubregion: Map<string, SubregionId>;
}

/** 文字锚点：优先用主面质心，没有就回落单位自带 center。 */
export function labelAnchorOf(anchors: Map<string, GeoPoint>, u: Unit): GeoPoint {
  return anchors.get(u.adcode) ?? u.center;
}

/** 世界面的范围判定上下文（喂给 `worldFaces.ts` 的纯函数）。 */
function faceContext(ctx: LayerInput): WorldFaceContext {
  return {
    continent: ctx.worldContinent,
    subregion: ctx.worldSubregion,
    isoContinent: ctx.isoContinent,
    isoSubregion: ctx.isoSubregion,
  };
}

function faceVisible(ctx: LayerInput, iso: string, isDecorative: boolean): boolean {
  return worldFeatureVisible(faceContext(ctx), iso, isDecorative);
}

// ==================== 地级（全国 / 单省） ====================

/** 地级面的 region 数据：按答题态/熟练度着色，范围外的面静默透明。 */
export function buildRegionData(ctx: LayerInput): GeoRegion[] {
  const { state, theme } = ctx;
  return ctx.units.map((u) => {
    const inView = !ctx.viewProvince || u.provinceAdcode === ctx.viewProvince;
    const color: UnitColor = u.decorative ? 'gray' : state.colorOf(u.adcode);
    const coinCoins = state.coin && !u.decorative ? state.coin.coins(u.adcode) : 0;
    return {
      name: u.name,
      silent: !inView,
      itemStyle: {
        areaColor: state.coin ? (theme.coinGreen(coinCoins) ?? theme.fill[color]) : inView ? theme.fill[color] : 'rgba(0,0,0,0)',
        // 省级模式不画地级边界（省界由 province-lines 系列单独绘制）
        borderColor: inView && !ctx.provinceMode ? theme.boundary[ctx.cityBoundaryTone] : 'rgba(0,0,0,0)',
        borderWidth: inView && !ctx.provinceMode ? 0.6 : 0,
      },
      emphasis: {
        itemStyle: {
          areaColor: state.coin ? (theme.coinGreen(coinCoins, true) ?? theme.emphasis[color]) : theme.emphasis[color],
        },
        label: { show: false },
      },
      label: { show: false },
    };
  });
}

/** 地级面的 events data（供 map series 的 tooltip/事件按面名匹配）。 */
export function buildCityEventData(units: Unit[]): { name: string }[] {
  return units.map((u) => ({ name: u.name }));
}

/** 地级市地名标签：已作答（绿/红）、常显（中性）、以及无尽闯关的价格标签。 */
export function buildLabelData(ctx: LayerInput): LabelPoint[] {
  const { state, theme } = ctx;
  if (ctx.worldMode) return []; // 世界国名标签走 world-labels 系列
  if (state.hideLabels) return []; // 「隐藏地图标签」：地级市标签整组关闭
  if (ctx.labelMode !== 'city') return [];
  return ctx.units.flatMap((u) => {
    if (ctx.viewProvince && u.provinceAdcode !== ctx.viewProvince) return [];
    if (state.coin) {
      if (u.decorative) return [];
      const lab = state.coin.label(u.adcode);
      if (!lab) return [];
      const anchor = labelAnchorOf(ctx.labelAnchors, u);
      return [{ name: u.name, value: [...anchor, lab.text, theme.labelNeutral, lab.price ? 1 : 0, lab.noBg ? 1 : 0] }];
    }
    const color: UnitColor = u.decorative ? 'gray' : state.colorOf(u.adcode);
    if (color === 'blue') return []; // 答题模式不泄露当前题目答案
    const anchor = labelAnchorOf(ctx.labelAnchors, u);
    if (color === 'green') return [{ name: u.name, value: [...anchor, u.name, theme.labelGreen, 0, 0] }];
    if (color === 'red') return [{ name: u.name, value: [...anchor, u.name, theme.labelRed, 0, 0] }];
    if (state.showAllLabels) return [{ name: u.name, value: [...anchor, u.name, theme.labelNeutral, 0, 0] }];
    return [];
  });
}

// ==================== 省级 ====================

/** 省级面的 events data（供 map series 的 tooltip/事件按省全名匹配）。 */
export function buildProvinceEventData(data: AppData): { name: string }[] {
  const geo = data.provincesGeoJson as { features?: GeoFeature[] };
  return (geo.features ?? [])
    .filter((f) => f.properties.adcode !== '100000_JD') // 南海诸岛装饰面不参与事件
    .map((f) => ({ name: f.properties.name ?? '' }));
}

/** 省级面的 region 数据：整省着色 + 整个省悬浮高亮。 */
export function buildProvinceRegionData(ctx: LayerInput): GeoRegion[] {
  const { state, theme } = ctx;
  const geo = ctx.data.provincesGeoJson as { features?: GeoFeature[] };
  return (geo.features ?? []).map((f) => {
    const adcode = f.properties.adcode ?? '';
    const isDecorative = adcode === '100000_JD';
    const color: UnitColor = isDecorative || !adcode ? 'gray' : state.colorOf(adcode);
    return {
      name: f.properties.name ?? '',
      silent: isDecorative,
      itemStyle: {
        areaColor: theme.fill[color],
        borderColor: 'rgba(0,0,0,0)', // 省界由 province-lines 系列单独绘制
        borderWidth: 0,
      },
      emphasis: {
        itemStyle: { areaColor: theme.emphasis[color] }, // 整个省面高亮
        label: { show: false },
      },
      label: { show: false },
    };
  });
}

/** 省名标签：已作答省（省级练习，绿/红）或省级地图常显全部省名（熟练度分析省级档，中性色）。 */
export function buildProvinceLabelData(ctx: LayerInput): LabelPoint[] {
  const { state, theme } = ctx;
  if (!ctx.provinceMode) return [];
  if (state.hideLabels) return []; // 「隐藏地图标签」：省名标签整组关闭
  const out: LabelPoint[] = [];
  for (const p of ctx.data.provinces) {
    const anchor = ctx.provinceLabelAnchors.get(p.adcode);
    if (!anchor) continue;
    // 熟练度分析省级档：全部省名中性色常显
    if (state.showAllProvinceLabels) {
      out.push({ name: p.name, value: [...anchor, normalizeProvince(p.name), theme.labelNeutral, 0, 0] });
      continue;
    }
    // 测验档：仅已作答省显示绿/红简称
    if (!state.provinceLabel) return [];
    const lab = state.provinceLabel(p.adcode);
    if (!lab) continue;
    const color = lab.color === 'green' ? theme.labelGreen : theme.labelRed;
    out.push({ name: p.name, value: [...anchor, lab.text, color, 0, 0] });
  }
  return out;
}

// ==================== 世界 ====================

/** 世界国面的 events data（装饰面不参与；大洲视图只含本洲）。 */
export function buildWorldEventData(ctx: LayerInput): { name: string }[] {
  const geo = ctx.data.worldGeoJson as { features?: GeoFeature[] };
  return (geo.features ?? [])
    .filter((f) => !f.properties.decorative)
    .filter((f) => faceVisible(ctx, f.properties.iso_a3 ? String(f.properties.iso_a3) : '', false))
    .map((f) => ({ name: f.properties.name ?? '' }));
}

/**
 * 世界模式的国面 region 数据：答题国按熟练度/答题态着色；装饰面灰显且静默。
 *
 * 大洲/次区域视图下**非本范围的面不渲染外观但仍登记为 `silent` 透明面**：
 * 只 continue 跳过外观会让这些面回落到 geo 层默认样式——几何依然参与命中测试、
 * 且 geo.emphasis 的悬停遮罩照常生效，于是「空白处悬停高亮看不见的国家、点击
 * 跳到它的上级区域」。登记为 silent 后 ECharts 既不派发鼠标事件也不做 emphasis，
 * 空白区因此彻底无交互。
 */
export function buildWorldRegionData(ctx: LayerInput): GeoRegion[] {
  const { state, theme } = ctx;
  const geo = ctx.data.worldGeoJson as { features?: GeoFeature[] };
  const out: GeoRegion[] = [];
  for (const f of geo.features ?? []) {
    const iso = f.properties.iso_a3 ? String(f.properties.iso_a3) : '';
    const isDecorative = f.properties.decorative === 1 || !iso;
    const excluded = !isDecorative && ctx.excludedIso.has(iso);
    const gray = isDecorative || excluded; // 装饰面与被排除的极小国：灰显
    if (!faceVisible(ctx, iso, isDecorative)) {
      // 范围外：保留几何（否则 ECharts 会把它当默认面处理）但不可见、不可交互
      out.push({
        name: f.properties.name ?? '',
        silent: true,
        itemStyle: { areaColor: 'rgba(0,0,0,0)', borderColor: 'rgba(0,0,0,0)', borderWidth: 0 },
        emphasis: { disabled: true, itemStyle: { areaColor: 'rgba(0,0,0,0)' }, label: { show: false } },
        label: { show: false },
      });
      continue;
    }
    const color: UnitColor = gray ? 'gray' : state.colorOf(iso);
    out.push({
      name: f.properties.name ?? '',
      silent: gray,
      itemStyle: {
        areaColor: theme.fill[color],
        borderColor: theme.boundary[ctx.worldBoundaryTone], // 国家细边界（深浅可在全局设置里调）
        borderWidth: excluded ? 0.2 : 0.4,
      },
      emphasis: {
        disabled: gray,
        itemStyle: { areaColor: gray ? theme.fill.gray : theme.emphasis[color] },
        label: { show: false },
      },
      label: { show: false },
    });
  }
  return out;
}

/**
 * 国名标签：世界测验档仅已作答国（绿/红）常显；世界分析档放大到阈值后全部国名中性显。
 * 大洲视图只显本洲标签。
 */
export function buildWorldLabelData(ctx: LayerInput): LabelPoint[] {
  const { state, theme } = ctx;
  if (!ctx.worldMode) return [];
  if (state.hideLabels) return []; // 「隐藏地图标签」：国名标签整组关闭
  const out: LabelPoint[] = [];
  const visible = (iso: string) =>
    ctx.worldSubregion
      ? ctx.isoSubregion.get(iso) === ctx.worldSubregion
      : !ctx.worldContinent || ctx.isoContinent.get(iso) === ctx.worldContinent;
  // 测验档：仅已作答国显示绿/红简称
  if (state.worldLabel) {
    for (const c of ctx.data.countries) {
      if (!visible(c.iso)) continue;
      const anchor = ctx.worldLabelAnchors.get(c.iso);
      if (!anchor) continue;
      const lab = state.worldLabel(c.iso);
      if (!lab) continue;
      const color = lab.color === 'green' ? theme.labelGreen : theme.labelRed;
      out.push({ name: c.name, value: [...anchor, lab.text, color, 0, 0] });
    }
    return out;
  }
  // 分析/浏览档：按 worldLabelZoomThreshold（省略时为 WORLD_LABEL_ZOOM）决定是否常显全部国名
  if (state.worldShowAllLabels && ctx.zoom > (state.worldLabelZoomThreshold ?? WORLD_LABEL_ZOOM)) {
    for (const c of ctx.data.countries) {
      if (!visible(c.iso)) continue;
      const anchor = ctx.worldLabelAnchors.get(c.iso);
      if (!anchor) continue;
      out.push({ name: c.name, value: [...anchor, c.name, theme.labelNeutral, 0, 0] });
    }
  }
  return out;
}
