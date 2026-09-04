import * as echarts from 'echarts';
import type { AppData, BoundaryTone, RenderState, Unit, UnitColor } from '../types';
import { t } from '../i18n';
import { normalizeProvince } from '../matcher';
import { MAP_THEMES, type MapTheme, type ThemeName } from './theme';
import { bboxOf, bestLabelAnchor, polygonsOf, type GeoFeature, type GeoPoint } from './geometry';
import { InsetMap } from './inset';
import {
  CITY_LABEL_SIZE,
  PRICE_LABEL_SIZE,
  PROVINCE_LABEL_SIZE,
  buildLabelGraphic,
  labelScale,
  parseLabelValue,
} from './labels';

type GeoRegion = NonNullable<echarts.GeoComponentOption['regions']>[number];
type LabelPoint = { name: string; value: [number, number, string, string, number, number] }; // [lng, lat, text, color, isPrice, noBg]
const NATION_W = 61.6; // 全国经度跨度（约 73.5 ~ 135.1）
const NATION_H = 49.8; // 全国纬度跨度（约 3.8 ~ 53.6）
const LABEL_ZOOM = 4; // 默认缩放倍率阈值；记忆模式可通过 RenderState 覆盖
const MIN_ZOOM = 0.8;
const MAX_ZOOM = 28;
const FOLLOW_ANIMATION_MS = 650;
const WIDE_FOLLOW_PROVINCES = new Set(['650000', '630000', '540000', '150000']);
const HAINAN_PROVINCE = '460000';
const LABEL_UPDATE_DELAY = 120;
const FOLLOW_FRAME_INTERVAL = 1000 / 45;

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

function clampZoom(zoom: number) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
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
  private provinceLines: { adcode: string; coords: number[][] }[] = [];
  private labelAnchors = new Map<string, GeoPoint>();
  private provinceLabelAnchors = new Map<string, GeoPoint>();
  private provinceNameToAdcode = new Map<string, string>(); // 省全名 → 省 adcode（省级地图命中）
  private inset: InsetMap;
  private viewProvince: string | null = null;
  private center: [number, number] = [104.5, 35];
  private zoom = 1;
  /** 下钻前全国视图快照：从全国下钻某省时记录 center/zoom，返回全国（backToNation）时恢复。 */
  private savedNationView: { center: [number, number]; zoom: number } | null = null;
  private labelMode: 'none' | 'city' = 'none';
  private labelScaleApplied = 1; // 最近一次应用的标签缩放（缩放变化时触发重绘）
  private labelUpdateTimer: number | null = null;
  private followRaf: number | null = null;
  private lastState: RenderState | null = null;
  private themeName: ThemeName = 'light';
  private cityBoundaryTone: BoundaryTone = 'light';
  private provinceBoundaryTone: BoundaryTone = 'dark';
  private provinceMode = false; // 省级模式：不画地级边界、省界加粗、不支持下钻
  private provinceModeInset = true; // 省级模式是否显示港澳放大框
  private provinceModeDrill = false; // 省级模式是否支持下钻（双击省级面 → onUnitDblClick(省adcode)）
  private flashAdcode: string | null = null;
  private flashTimer: number | null = null;
  /** 命名 resize 监听器引用，dispose 时移除，避免匿名监听泄漏。 */
  private handleResize = () => this.resize();
  onViewChange: (() => void) | null = null;
  onZoomChange: (() => void) | null = null;

  constructor(private el: HTMLElement, private data: AppData, private handlers: MapHandlers) {
    echarts.registerMap('china', data.geoJson as never);
    echarts.registerMap('china-provinces', data.provincesGeoJson as never); // 省级地图：只渲染 35 个省面
    this.inset = new InsetMap({
      theme: () => this.theme(),
      state: () => this.lastState,
      boundaryTone: () => this.provinceBoundaryTone,
      handlers: this.handlers,
      provincesGeoJson: data.provincesGeoJson,
    });
    this.inset.registerMap(); // 港澳放大框：香港+澳门+广东沿海
    this.chart = echarts.init(el);
    this.units = data.allUnits;
    for (const u of this.units) {
      this.nameToUnit.set(u.name, u);
      this.adcodeToUnit.set(u.adcode, u);
    }
    this.provinceLines = this.buildProvinceLines();
    this.labelAnchors = this.buildLabelAnchors();
    this.provinceLabelAnchors = this.buildProvinceLabelAnchors();
    // 省全名 → 省 adcode（省级地图点击/悬浮命中整省时回传）
    const provGeo = data.provincesGeoJson as { features?: GeoFeature[] };
    for (const f of provGeo.features ?? []) {
      if (f.properties.name && f.properties.adcode) this.provinceNameToAdcode.set(f.properties.name, f.properties.adcode);
    }
    this.chart.on('click', (p) => {
      this.clearFlash(); // 点击任何位置先清除黄色高亮，避免点空白处不消失
      const params = p as { componentType?: string; seriesType?: string; name?: string };
      const isUnitHit = params.componentType === 'series' && params.seriesType === 'map';
      if (!isUnitHit) {
        if (this.viewProvince) this.handlers.onBlankClick();
        return;
      }
      // 省级模式：命中省级面 → 按省全名查省 adcode 回传，不支持下钻
      if (this.provinceMode) {
        const adcode = this.provinceNameToAdcode.get(params.name ?? '');
        if (adcode && adcode !== '100000_JD') this.handlers.onUnitClick(adcode);
        else if (this.viewProvince) this.handlers.onBlankClick();
        return;
      }
      const u = this.nameToUnit.get(params.name ?? '');
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

    this.chart.getZr().on('click', (event) => {
      if (!event.target && this.viewProvince) this.handlers.onBlankClick();
    });

    this.chart.on('mouseover', (p) => {
      const params = p as { componentType?: string; seriesType?: string; name?: string };
      if (params.componentType !== 'series' || params.seriesType !== 'map') return;
      // 省级模式：命中省级面 → 按省全名查省 adcode
      if (this.provinceMode) {
        const adcode = this.provinceNameToAdcode.get(params.name ?? '');
        if (adcode) this.handlers.onUnitHover?.(adcode);
        return;
      }
      const u = this.nameToUnit.get(params.name ?? '');
      if (u) this.handlers.onUnitHover?.(u.adcode);
    });
    this.chart.on('mouseout', (p) => {
      const params = p as { componentType?: string; seriesType?: string };
      if (params.componentType === 'series' && params.seriesType === 'map') this.handlers.onUnitHoverEnd?.();
    });

    this.chart.on('dblclick', (p) => {
      const params = p as { componentType?: string; seriesType?: string; name?: string };
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

    // 缩放/拖动时只记录 zoom。不要在 georoam 中完整 setOption 重建 map/lines，
    // 否则 ECharts 会让地级 MapDraw 进入过渡态，而省界 lines 已经跟随新坐标系。
    this.chart.on('georoam', (p) => {
      if (this.followRaf !== null) {
        cancelAnimationFrame(this.followRaf);
        this.followRaf = null;
      }
      const params = p as { zoom?: number; totalZoom?: number; center?: number[] };
      if (Array.isArray(params.center) && typeof params.center[0] === 'number' && typeof params.center[1] === 'number') {
        this.center = [params.center[0], params.center[1]];
      }
      if (typeof params.totalZoom === 'number') {
        this.zoom = clampZoom(params.totalZoom);
      } else if (typeof params.zoom === 'number') {
        this.zoom = clampZoom(this.zoom * params.zoom);
      }
      this.scheduleLabelModeUpdate();
      this.onZoomChange?.();
    });

    window.addEventListener('resize', this.handleResize);
  }

  /** 容器尺寸变化（如从留言板切回地图）时重算画布。 */
  resize() {
    this.chart.resize();
    this.inset.resize();
  }

  setDarkMode(darkMode: boolean) {
    const next: ThemeName = darkMode ? 'dark' : 'light';
    if (next === this.themeName) return;
    this.themeName = next;
    if (this.lastState) this.render(this.lastState);
  }

  setBoundaryTones(cityBoundaryTone: BoundaryTone, provinceBoundaryTone: BoundaryTone) {
    if (cityBoundaryTone === this.cityBoundaryTone && provinceBoundaryTone === this.provinceBoundaryTone) return;
    this.cityBoundaryTone = cityBoundaryTone;
    this.provinceBoundaryTone = provinceBoundaryTone;
    if (this.lastState) this.render(this.lastState);
  }

  /** 省级模式：仅渲染省级地图（35 个省面），不渲染地级市行政区；港澳放大框与下钻能力可选。 */
  setProvinceMode(on: boolean, opts: { inset?: boolean; allowDrill?: boolean } = {}) {
    const nextInset = opts.inset ?? true;
    const nextDrill = opts.allowDrill ?? false;
    if (this.provinceMode === on && this.provinceModeInset === nextInset && this.provinceModeDrill === nextDrill) return;
    this.provinceMode = on;
    this.provinceModeInset = nextInset;
    this.provinceModeDrill = nextDrill;
    let resetFromDrill = false;
    if (this.viewProvince) {
      // 离开钻省状态回到全国：若存在下钻前视图快照则恢复之（否则回默认全国视图）
      const saved = this.savedNationView;
      this.savedNationView = null;
      this.viewProvince = null;
      this.center = saved ? saved.center : [104.5, 35];
      this.zoom = saved ? saved.zoom : 1;
      this.labelMode = 'none';
      resetFromDrill = true;
    }
    if (this.provinceMode && this.provinceModeInset) this.inset.show();
    else this.inset.hide();
    if (this.lastState) this.render(this.lastState);
    if (resetFromDrill) {
      // render 可能因地图切换（china ↔ china-provinces）重置相机，显式写回恢复的下钻前视图
      this.chart.setOption({ geo: { map: this.currentMapName(), center: this.center, zoom: this.zoom } });
      this.onZoomChange?.();
    }
  }

  /** 显示港澳放大框（延迟到容器可见后再初始化图表，否则 ECharts 按 0 尺寸渲染）。 */
  private theme(): MapTheme {
    return MAP_THEMES[this.themeName];
  }

  /** 省界折线：省界 GeoJSON 的每个环转为线坐标（用于 lines 系列粗线渲染） */
  private buildProvinceLines(): { adcode: string; coords: number[][] }[] {
    const geo = this.data.provincesGeoJson as {
      features: { properties: { adcode: string }; geometry: { type: string; coordinates: unknown } }[];
    };
    const out: { adcode: string; coords: number[][] }[] = [];
    for (const f of geo.features) {
      const g = f.geometry;
      const rings: unknown[] = [];
      if (g.type === 'Polygon') rings.push(...(g.coordinates as unknown[]));
      else if (g.type === 'MultiPolygon') {
        for (const poly of g.coordinates as unknown[]) rings.push(...(poly as unknown[]));
      }
      for (const ring of rings) {
        const coords = (ring as unknown[])
          .filter((c) => Array.isArray(c) && typeof (c as number[])[0] === 'number')
          .map((c) => c as number[]);
        if (coords.length >= 2) out.push({ adcode: f.properties.adcode, coords });
      }
    }
    return out;
  }

  /** 当前视图下的省界线数据（下钻时只保留当前省） */
  private buildLineData(): { coords: number[][] }[] {
    return this.provinceLines
      .filter((l) => !this.viewProvince || l.adcode === this.viewProvince || (l.adcode === '100000_JD' && this.viewProvince === '460000'))
      .map((l) => ({ coords: l.coords }));
  }

  /** 标签锚点只服务文字位置，不影响聚焦和下钻使用的地图相机中心。 */
  private buildLabelAnchors(): Map<string, GeoPoint> {
    const geo = this.data.geoJson as { features?: GeoFeature[] };
    const out = new Map<string, GeoPoint>();
    for (const feature of geo.features ?? []) {
      const adcode = feature.properties.adcode;
      if (!adcode) continue;
      const polygons = polygonsOf(feature);
      if (!polygons.length) continue;
      out.set(adcode, bestLabelAnchor(polygons));
    }
    return out;
  }

  /** 省级名字标签锚点：从省界 GeoJSON 计算（省级练习/熟练度分析的省名标签用）。 */
  private buildProvinceLabelAnchors(): Map<string, GeoPoint> {
    const geo = this.data.provincesGeoJson as { features?: GeoFeature[] };
    const out = new Map<string, GeoPoint>();
    for (const feature of geo.features ?? []) {
      const adcode = feature.properties.adcode;
      if (!adcode) continue;
      const polygons = polygonsOf(feature);
      if (!polygons.length) continue;
      out.set(adcode, bestLabelAnchor(polygons));
    }
    return out;
  }

  private labelAnchorOf(u: Unit): GeoPoint {
    return this.labelAnchors.get(u.adcode) ?? u.center;
  }

  private buildRegionData(state: RenderState): GeoRegion[] {
    const theme = this.theme();
    return this.units.map((u) => {
      const inView = !this.viewProvince || u.provinceAdcode === this.viewProvince;
      const color: UnitColor = u.decorative ? 'gray' : state.colorOf(u.adcode);
      const coinCoins = state.coin && !u.decorative ? state.coin.coins(u.adcode) : 0;
      return {
        name: u.name,
        silent: !inView,
        itemStyle: {
          areaColor: state.coin ? (theme.coinGreen(coinCoins) ?? theme.fill[color]) : inView ? theme.fill[color] : 'rgba(0,0,0,0)',
          // 省级模式不画地级边界（省界由 province-lines 系列单独绘制）
          borderColor: inView && !this.provinceMode ? theme.boundary[this.cityBoundaryTone] : 'rgba(0,0,0,0)',
          borderWidth: inView && !this.provinceMode ? 0.6 : 0,
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

  /** 省级模式的省面数据（供 map series 的 tooltip/事件按省全名匹配）。 */
  private buildProvinceEventData(): { name: string }[] {
    const geo = this.data.provincesGeoJson as { features?: GeoFeature[] };
    return (geo.features ?? [])
      .filter((f) => f.properties.adcode !== '100000_JD') // 南海诸岛装饰面不参与事件
      .map((f) => ({ name: f.properties.name ?? '' }));
  }

  /** 省级模式的省面 region 数据：整省着色 + 整个省悬浮高亮。 */
  private buildProvinceRegionData(state: RenderState): GeoRegion[] {
    const theme = this.theme();
    const geo = this.data.provincesGeoJson as { features?: GeoFeature[] };
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

  private buildLabelData(state: RenderState): LabelPoint[] {
    if (this.labelMode !== 'city') return [];
    const theme = this.theme();
    return this.units.flatMap((u) => {
      if (this.viewProvince && u.provinceAdcode !== this.viewProvince) return [];
      if (state.coin) {
        if (u.decorative) return [];
        const lab = state.coin.label(u.adcode);
        if (!lab) return [];
        const anchor = this.labelAnchorOf(u);
        return [{ name: u.name, value: [...anchor, lab.text, theme.labelNeutral, lab.price ? 1 : 0, lab.noBg ? 1 : 0] }];
      }
      const color: UnitColor = u.decorative ? 'gray' : state.colorOf(u.adcode);
      if (color === 'blue') return []; // 答题模式不泄露当前题目答案
      const anchor = this.labelAnchorOf(u);
      if (color === 'green') return [{ name: u.name, value: [...anchor, u.name, theme.labelGreen, 0, 0] }];
      if (color === 'red') return [{ name: u.name, value: [...anchor, u.name, theme.labelRed, 0, 0] }];
      if (state.showAllLabels) return [{ name: u.name, value: [...anchor, u.name, theme.labelNeutral, 0, 0] }];
      return [];
    });
  }

  /** 省名标签：已作答省（省级练习，绿/红）或省级地图常显全部省名（熟练度分析省级档，中性色）。 */
  private buildProvinceLabelData(state: RenderState): LabelPoint[] {
    if (!this.provinceMode) return [];
    const theme = this.theme();
    const out: LabelPoint[] = [];
    for (const p of this.data.provinces) {
      const anchor = this.provinceLabelAnchors.get(p.adcode);
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

  private provinceFeatureName(adcode: string): string {
    const geo = this.data.provincesGeoJson as { features?: GeoFeature[] };
    const f = (geo.features ?? []).find((x) => x.properties.adcode === adcode);
    return f?.properties.name ?? '';
  }

  private desiredLabelMode(state: RenderState | null = this.lastState): 'none' | 'city' {
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
      this.chart.setOption({
        series: [
          { id: 'city-labels', data: this.buildLabelData(this.lastState) },
          { id: 'province-labels', data: this.buildProvinceLabelData(this.lastState) },
        ],
      } as never);
    }
  }

  private scheduleLabelModeUpdate() {
    if (this.labelUpdateTimer !== null) window.clearTimeout(this.labelUpdateTimer);
    this.labelUpdateTimer = window.setTimeout(() => {
      this.labelUpdateTimer = null;
      this.applyLabelMode();
    }, LABEL_UPDATE_DELAY);
  }

  /** 按当前模式状态重绘（保留用户缩放/平移） */
  render(state: RenderState) {
    this.lastState = state;
    this.labelMode = this.desiredLabelMode(state);
    this.labelScaleApplied = labelScale(this.zoom);

    // 省级模式：geo 切换为省级地图（只渲染 35 个省面，不渲染地级市行政区）
    const mapName = this.provinceMode ? 'china-provinces' : 'china';
    // map series 只提供 data 用于 tooltip/事件；区域样式由 geo.regions 负责。
    const eventData = this.provinceMode ? this.buildProvinceEventData() : this.units.map((u) => ({ name: u.name }));
    const labelData = this.buildLabelData(state);
    const provinceLabelData = this.buildProvinceLabelData(state);
    const theme = this.theme();

    const option: echarts.EChartsOption = {
      backgroundColor: theme.background,
      animation: false,
      animationDuration: 0,
      animationDurationUpdate: 0,
      tooltip: state.disableTooltip
        ? { show: false }
        : {
            trigger: 'item',
            backgroundColor: theme.tooltipBg,
            borderColor: theme.tooltipBorder,
            textStyle: { color: theme.tooltipText },
            formatter: (p) => {
              const params = p as { name?: string };
              const u = this.nameToUnit.get(params.name ?? '');
              if (!u) return String(params.name ?? '');
              if (state.coin) {
                const coins = u.decorative ? 0 : state.coin.coins(u.adcode);
                const coinsTxt = coins > 0 ? `${coins}￥` : t('map.tooltip.coinCollected');
                return t('map.tooltip.body', { name: u.name, province: u.province, coins: coinsTxt });
              }
              const color: UnitColor = u.decorative ? 'gray' : state.colorOf(u.adcode);
              const status = u.decorative ? '' : t('map.tooltip.statusLine', { status: STATUS_TXT[color] });
              return t('map.tooltip.bodyBase', { name: u.name, province: u.province, status });
            },
          },
      geo: {
        map: mapName, // 省级模式用省级地图；否则用地级地图（series 绑定后使用同一地图，地名才能匹配上）
        roam: true,
        scaleLimit: { min: MIN_ZOOM, max: MAX_ZOOM },
        silent: false,
        selectedMode: false,
        tooltip: { show: false },
        label: { show: false },
        emphasis: {
          label: { show: false },
          itemStyle: { areaColor: theme.hoverArea }, // 悬停高亮（半透明遮罩，覆盖整个省面）
        },
        select: { label: { show: false } },
        itemStyle: {
          areaColor: 'rgba(0,0,0,0)',
          borderColor: 'rgba(0,0,0,0)',
          borderWidth: 0, // geo 自身透明；边界由 geo.regions / province-lines 绘制
        },
        regions: this.provinceMode ? this.buildProvinceRegionData(state) : this.buildRegionData(state),
      },
      series: [
        {
          id: 'city-events',
          type: 'map',
          map: mapName,
          geoIndex: 0,
          selectedMode: false,
          label: { show: false },
          emphasis: { label: { show: false } },
          select: { label: { show: false } },
          data: eventData,
        },
        {
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
        },
        {
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
          data: labelData,
        },
        {
          // 省级练习省名标签：已作答省的简称，始终显示
          id: 'province-labels',
          type: 'custom',
          coordinateSystem: 'geo',
          geoIndex: 0,
          z: 9, // 低于 city-labels 但高于省界线
          silent: true,
          tooltip: { show: false },
          renderItem: (_params, api) => {
            const parsed = parseLabelValue(api);
            if (!parsed) return { type: 'group', children: [] };
            const scale = labelScale(this.zoom);
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
          data: provinceLabelData,
        },
      ],
    };
    this.chart.setOption(option);
    // 省级模式下同步刷新港澳放大框着色；期望显示时确保容器可见（防任何路径误隐藏后无 render 恢复）
    if (this.provinceMode && this.provinceModeInset) this.inset.show();
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

  /** 标记成功时的高亮动画（临时改色后恢复，不依赖 emphasis 机制）；省级模式按省面 name 匹配。 */
  flash(adcode: string) {
    const matchName = this.provinceMode ? this.provinceFeatureName(adcode) : (this.adcodeToUnit.get(adcode)?.name ?? '');
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
      this.chart.setOption({ geo: { regions } } as never);
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
    const u = this.units.find((item) => item.adcode === adcode);
    if (!u) return;
    if (this.viewProvince && this.viewProvince !== u.provinceAdcode) {
      this.viewProvince = null;
      if (this.lastState) this.render(this.lastState);
    }
    this.animateViewTo(u.center, this.followZoomFor(u.provinceAdcode));
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
      this.chart.setOption({ geo: { map: this.currentMapName(), center, zoom: this.zoom } }, { lazyUpdate: true, silent: true });
      lastFrame = now;
      this.onZoomChange?.();
      if (t < 1) {
        this.followRaf = requestAnimationFrame(step);
      } else {
        this.followRaf = null;
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

  /** 下钻到某省：其他区域消失，自动缩放居中。 */
  drillToProvince(adcode: string) {
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
    this.center = [(minX + maxX) / 2, (minY + maxY) / 2];
    this.zoom = zoom;
    this.labelMode = this.desiredLabelMode();
    if (this.lastState) this.render(this.lastState);
    // 必须带上 map：首次渲染前调用时 geo 组件尚未初始化，缺 map 会加载空地图导致崩溃。
    this.chart.setOption({ geo: { map: this.currentMapName(), center: this.center, zoom } });
    this.onZoomChange?.();
    this.onViewChange?.();
  }

  backToNation() {
    const saved = this.savedNationView;
    this.savedNationView = null; // 快照一次性使用：返回全国后清除
    this.viewProvince = null;
    if (saved) {
      this.center = saved.center;
      this.zoom = saved.zoom;
    } else {
      this.center = [104.5, 35];
      this.zoom = 1;
    }
    this.labelMode = 'none';
    if (this.lastState) this.render(this.lastState);
    this.chart.setOption({ geo: { map: this.currentMapName(), center: this.center, zoom: this.zoom } });
    this.onZoomChange?.();
    this.onViewChange?.();
  }

  /** 当前 geo 地图名：省级模式用省级地图，否则地级地图。 */
  private currentMapName(): string {
    return this.provinceMode ? 'china-provinces' : 'china';
  }

  currentProvince(): string | null {
    return this.viewProvince;
  }

  currentZoom() {
    return this.zoom;
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

