/**
 * ECharts option 里**三块大件**的构造：geo 组件、tooltip，以及那 5 条 series 中的 4 条
 * （省界线、世界国名标签、地市标签、省级省名标签）。
 *
 * 为什么这样切：这些构造原先首尾相接成一坨 166 行的 option 字面量，读的人分不清哪几行属于
 * tooltip、哪几行属于 geo 的投影钉死、哪几行属于哪条 series；而且它们**几乎全是纯数据搬运**
 * —— 输入 `LayerInput`（数据层只读输入，见 `./layers.ts`）与主题，输出 option 片段，不读
 * ECharts 实例、不写渲染器字段。搬走后可以对着 option 断言，渲染器那边只留「先建什么、后建
 * 什么」的编排顺序。
 *
 * 三条交接约定（搬迁时的硬要求，任何一条变化都会静默改变渲染）：
 *   1. **option 字段与顺序逐字保留** —— 包括 `polyline: true`（false 时省界只画前两个点）、
 *      `z: 3 / 9 / 10` 的层序、`boundingCoords` 钉死投影、以及 series 数组里 5 条 series 的
 *      先后顺序（先事件层、再省界线、再标签）。
 *   2. **读实例状态的地方改成"活值"回调** —— tooltip 的 formatter 与标签的 renderItem 都是
 *      ECharts 在悬停/缩放期间**反复调用**的闭包，原先每帧读 `this.worldMode` / `this.zoom`。
 *      若在这里取快照，就会出现"标签字号卡在缩放开始时的值""切到省级后 tooltip 仍按世界口径"
 *      这类不报错的回归，故 `worldMode` 与 `scaleOf` 都收**闭包**而非值；查表（Map/Set）收
 *      **引用**（渲染器只原地 set，从不重新赋值）。
 *   3. **数据层调用不变** —— `build*RegionData` / `build*EventData` / `build*LabelData` 仍从
 *      `./layers.ts` 取，本模块不新增任何数据加工，也不碰 `./cull.ts`（裁剪在渲染器里按帧执行）。
 */
import type * as echarts from 'echarts';
import { t } from '../i18n';
import type { BoundaryTone, RenderState, Unit, UnitColor } from '../types';
import type { MapTheme } from './theme';
import { MAX_ZOOM, MIN_ZOOM } from './zoom';
import { MAP_PROJECTION_BBOX } from './camera';
import {
  buildCityEventData,
  buildProvinceEventData,
  buildProvinceRegionData,
  buildRegionData,
  buildWorldEventData,
  buildWorldRegionData,
  type LabelPoint,
  type LayerInput,
} from './layers';
import {
  CITY_LABEL_SIZE,
  PRICE_LABEL_SIZE,
  PROVINCE_LABEL_SIZE,
  buildLabelGraphic,
  parseLabelValue,
} from './labels';

/**
 * `series` 数组的**元素**类型。从 ECharts 自己的 option 类型里取（而不是去猜它内部
 * `SeriesOption$1` 之类被重命名的名字）。
 *
 * 为什么需要显式标注：series 的元素原本嵌在 `const option: echarts.EChartsOption = {...}`
 * 里，靠上下文把 `type: 'custom'` 收窄成字面量类型、把 `renderItem(_params, api)` 的
 * 参数推断出来。一旦把某条 series 搬进独立方法（或独立模块），上下文就丢了 —— 会得到
 * `Type 'string' is not assignable to type '"lines"'` 与一串 `implicitly has an any type`。
 */
export type SeriesItem = Exclude<NonNullable<echarts.EChartsOption['series']>, readonly unknown[]>;

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

/** geo 组件：地图名 + 投影钉死（boundingCoords）+ regions（世界 / 省级 / 地级三分支）。 */
export function buildGeoOption(mapName: string, ctx: LayerInput): echarts.EChartsOption['geo'] {
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
    boundingCoords: MAP_PROJECTION_BBOX[ctx.worldMode ? 'world' : 'china'],
  };
}

/**
 * tooltip 的**活值**依赖：查表按引用传入（渲染器只原地 set，从不重新赋值），
 * `worldMode` 收闭包 —— formatter 是 ECharts 悬停时才调用的，取快照会让"切省/切世界后
 * 第一帧的 tooltip 仍按旧口径"。
 */
export interface TooltipDeps {
  worldMode: () => boolean;
  worldNameToIso: Map<string, string>;
  isWorldFaceInteractive: (name: string) => boolean;
  nameToUnit: Map<string, Unit>;
}

/** tooltip：三档粒度各一套文案；不可交互的面（其他洲 / 被排除的极小国 / 装饰面）只显示面名。 */
export function buildTooltipOption(
  state: RenderState,
  theme: MapTheme,
  deps: TooltipDeps,
): echarts.EChartsOption['tooltip'] {
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
          if (deps.worldMode()) {
            const iso = deps.worldNameToIso.get(hitName);
            // 不可交互的面（其他洲 / 被排除的极小国 / 装饰面）不显示答题态 tooltip
            if (!iso || !deps.isWorldFaceInteractive(hitName)) return String(hitName);
            const color: UnitColor = state.colorOf(iso);
            return t('map.tooltip.worldBody', { name: hitName, status: t('map.tooltip.statusLine', { status: STATUS_TXT[color] }) });
          }
          const u = deps.nameToUnit.get(hitName);
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

/** 事件层：只提供 data 用于 tooltip/事件；区域样式由 geo.regions 负责。 */
export function eventSeries(mapName: string, ctx: LayerInput): SeriesItem {
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

/**
 * 省界线层：粗线画在地级面之上（世界模式无省界线，`buildLineData` 返回空数组）。
 *
 * 数据由渲染器传进来而不是在这里现取：`buildLineData()` 会**顺带**把每个元素的 bbox 写进
 * 渲染器的 `lineBoxes`（逐帧裁剪用），那是实例副作用，必须留在渲染器；本函数只负责把
 * 数据装进 option。
 */
export function provinceLinesSeries(
  theme: MapTheme,
  provinceBoundaryTone: BoundaryTone,
  lines: { coords: number[][] }[],
): SeriesItem {
  return {
    id: 'province-lines',
    type: 'lines',
    coordinateSystem: 'geo',
    geoIndex: 0,
    z: 3, // 画在地级面之上
    silent: true,
    tooltip: { show: false },
    polyline: true, // 必须开启：false 时每个省界环只取前两个点，边界基本不可见
    lineStyle: { color: theme.boundary[provinceBoundaryTone], width: 2.4, opacity: 1 },
    data: lines,
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
export function provinceLikeLabelSeries(
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
export function cityLabelSeries(data: LabelPoint[], theme: MapTheme, scaleOf: () => number): SeriesItem {
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
      const scale = scaleOf();
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
