import * as echarts from 'echarts';
import type { AppData, BoundaryTone, RenderState, Unit, UnitColor } from '../types';
import { t } from '../i18n';

type GeoRegion = NonNullable<echarts.GeoComponentOption['regions']>[number];
type LabelPoint = { name: string; value: [number, number, string, string, number, number] }; // [lng, lat, text, color, isPrice, noBg]
type GeoPoint = [number, number];
type PolygonRings = GeoPoint[][];
type GeoFeature = { properties: { adcode?: string; name?: string }; geometry: { type: string; coordinates: unknown } };
type ThemeName = 'light' | 'dark';
type MapTheme = {
  background: string;
  fill: Record<UnitColor, string>;
  emphasis: Record<UnitColor, string>;
  boundary: Record<BoundaryTone, string>;
  hoverArea: string;
  labelBg: string;
  labelShadow: string;
  labelGreen: string;
  labelRed: string;
  labelNeutral: string;
  tooltipBg: string;
  tooltipText: string;
  tooltipBorder: string;
  flashArea: string;
  flashBorder: string;
  /** 无尽闯关：金币数量 → 绿色深浅（0/负值返回 null，回落原色） */
  coinGreen: (coins: number, hover?: boolean) => string | null;
};

const MAP_THEMES: Record<ThemeName, MapTheme> = {
  light: {
    background: '#d1d5db',
    fill: {
      green: '#7fbf8b',
      blue: '#6fa8dc', // 当前题目
      red: '#d98989', // 答错标记
      gray: '#e7e2d8',
      scoreGreenLight: '#c7e8ce',
      scoreGreenMedium: '#86c993',
      scoreGreenDark: '#4f9d60',
      scoreRedLight: '#f0c8c8',
      scoreRedMedium: '#dc9292',
      scoreRedDark: '#bd5d5d',
    },
    emphasis: {
      green: '#93cfa0',
      blue: '#83b7e3',
      red: '#e1a0a0',
      gray: '#eee9df',
      scoreGreenLight: '#d7f0dc',
      scoreGreenMedium: '#a2d8ac',
      scoreGreenDark: '#6bb87a',
      scoreRedLight: '#f6dada',
      scoreRedMedium: '#e5aaaa',
      scoreRedDark: '#cf7777',
    },
    boundary: {
      light: '#b9b2a6',
      mid: '#90969d',
      dark: '#6b7280',
    },
    hoverArea: 'rgba(255,255,255,0.22)',
    labelBg: 'rgba(255,255,255,0.94)',
    labelShadow: 'rgba(15, 23, 42, 0.22)',
    labelGreen: '#15803d',
    labelRed: '#b91c1c',
    labelNeutral: '#374151',
    tooltipBg: 'rgba(255,255,255,0.96)',
    tooltipText: '#111827',
    tooltipBorder: '#d1d5db',
    flashArea: '#e8cf78',
    flashBorder: '#b68b2f',
    coinGreen(coins, hover = false) {
      if (coins <= 0) return null;
      const t = Math.min(1, coins / 500);
      const s = 42 + t * 14;
      const l = Math.min(88, (hover ? 5 : 0) + (82 - t * 48));
      return `hsl(140, ${s.toFixed(1)}%, ${Math.max(26, l).toFixed(1)}%)`;
    },
  },
  dark: {
    background: '#374151',
    fill: {
      green: '#166534',
      blue: '#1d4ed8',
      red: '#991b1b',
      gray: '#1f2937',
      scoreGreenLight: '#3b7a4b',
      scoreGreenMedium: '#23703a',
      scoreGreenDark: '#166534',
      scoreRedLight: '#8b4b4b',
      scoreRedMedium: '#a23737',
      scoreRedDark: '#991b1b',
    },
    emphasis: {
      green: '#15803d',
      blue: '#2563eb',
      red: '#b91c1c',
      gray: '#334155',
      scoreGreenLight: '#4f985f',
      scoreGreenMedium: '#2d8a46',
      scoreGreenDark: '#15803d',
      scoreRedLight: '#a65b5b',
      scoreRedMedium: '#b83f3f',
      scoreRedDark: '#b91c1c',
    },
    boundary: {
      light: '#475569',
      mid: '#6b8197',
      dark: '#94a3b8',
    },
    hoverArea: 'rgba(148,163,184,0.18)',
    labelBg: 'rgba(15,23,42,0.9)',
    labelShadow: 'rgba(0, 0, 0, 0.42)',
    labelGreen: '#86efac',
    labelRed: '#fca5a5',
    labelNeutral: '#dbeafe',
    tooltipBg: 'rgba(15,23,42,0.96)',
    tooltipText: '#e5e7eb',
    tooltipBorder: '#475569',
    flashArea: '#ca8a04',
    flashBorder: '#fde68a',
    coinGreen(coins, hover = false) {
      if (coins <= 0) return null;
      const t = Math.min(1, coins / 500);
      const s = 48 + t * 16;
      const l = Math.min(64, (hover ? 9 : 0) + (26 + t * 22));
      return `hsl(140, ${s.toFixed(1)}%, ${Math.max(18, l).toFixed(1)}%)`;
    },
  },
};
const NATION_W = 61.6; // 全国经度跨度（约 73.5 ~ 135.1）
const NATION_H = 49.8; // 全国纬度跨度（约 3.8 ~ 53.6）
const LABEL_ZOOM = 4; // 默认缩放倍率阈值；记忆模式可通过 RenderState 覆盖
const LABEL_FIX_ZOOM = 4; // 标签固定大小阈值：4x 以上不再放大，4x 以下随地图缩放（避免小倍率看不清价格）
const MIN_ZOOM = 0.8;
const MAX_ZOOM = 28;
const FOLLOW_ANIMATION_MS = 650;
const WIDE_FOLLOW_PROVINCES = new Set(['650000', '630000', '540000', '150000']);
const HAINAN_PROVINCE = '460000';
const CITY_LABEL_SIZE = 14;
const PRICE_LABEL_SIZE = 18; // 价格标签字号（随缩放缩放）
const PROVINCE_LABEL_SIZE = 15; // 省名标签字号（每日竞速作答反馈）
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

/** 标签缩放：缩放倍率 <4x 时跟随地图等比例缩放（下限 0.5 保证小倍率可读），>=4x 时保持固定大小。 */
function labelScale(zoom: number) {
  return Math.max(0.5, Math.min(1, zoom / LABEL_FIX_ZOOM));
}

/** 文本渲染宽度估算：CJK 按全角、ASCII 按半角。 */
function textRenderWidth(text: string, fontSize: number) {
  let width = 0;
  for (const ch of text) {
    width += ch.charCodeAt(0) > 0xff ? fontSize : fontSize * 0.6;
  }
  return width;
}

function labelShape(name: string, point: number[], fontSize: number, padX: number, padY: number, minWidth: number) {
  const width = Math.max(minWidth, textRenderWidth(name, fontSize) + padX * 2);
  const height = fontSize + padY * 2;
  return {
    x: point[0] - width / 2,
    y: point[1] - height / 2,
    width,
    height,
  };
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
  private insetEl: HTMLElement | null = null;
  private insetChart: echarts.ECharts | null = null;
  private viewProvince: string | null = null;
  private center: [number, number] = [104.5, 35];
  private zoom = 1;
  private labelMode: 'none' | 'city' = 'none';
  private labelScaleApplied = 1; // 最近一次应用的标签缩放（缩放变化时触发重绘）
  private labelUpdateTimer: number | null = null;
  private followRaf: number | null = null;
  private lastState: RenderState | null = null;
  private themeName: ThemeName = 'light';
  private cityBoundaryTone: BoundaryTone = 'light';
  private provinceBoundaryTone: BoundaryTone = 'dark';
  private provinceMode = false; // 省级模式：不画地级边界、省界加粗、不支持下钻
  private flashAdcode: string | null = null;
  private flashTimer: number | null = null;
  onViewChange: (() => void) | null = null;
  onZoomChange: (() => void) | null = null;

  constructor(private el: HTMLElement, private data: AppData, private handlers: MapHandlers) {
    echarts.registerMap('china', data.geoJson as never);
    echarts.registerMap('china-provinces', data.provincesGeoJson as never); // 省级地图：每日竞速只渲染 35 个省面
    echarts.registerMap('hkmac', this.buildHkmacGeo() as never); // 港澳放大框：香港+澳门+广东沿海
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
    this.insetEl = document.getElementById('hkmac-inset');

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
      if (this.provinceMode) return; // 省级模式不支持下钻
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

    window.addEventListener('resize', () => {
      this.chart.resize();
      this.insetChart?.resize();
    });
  }

  /** 容器尺寸变化（如从留言板切回地图）时重算画布。 */
  resize() {
    this.chart.resize();
    this.insetChart?.resize();
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

  /** 省级模式：仅渲染省级地图（35 个省面），不渲染地级市行政区；不支持下钻；港澳放大框联动显隐。 */
  setProvinceMode(on: boolean) {
    if (this.provinceMode === on) return;
    this.provinceMode = on;
    if (this.viewProvince) {
      this.viewProvince = null;
      this.center = [104.5, 35];
      this.zoom = 1;
      this.labelMode = 'none';
    }
    if (on) this.showInset();
    else this.hideInset();
    if (this.lastState) this.render(this.lastState);
  }

  /** 显示港澳放大框（延迟到容器可见后再初始化图表，否则 ECharts 按 0 尺寸渲染）。 */
  private showInset() {
    if (!this.insetEl) return;
    this.insetEl.classList.remove('hidden');
    if (!this.insetChart) {
      this.insetChart = echarts.init(this.insetEl);
      this.insetChart.on('click', (p) => this.onInsetClick(p));
      this.insetChart.on('mouseover', (p) => this.onInsetHover(p));
      this.insetChart.on('mouseout', () => this.handlers.onUnitHoverEnd?.());
    }
    this.renderInset();
  }

  private hideInset() {
    if (this.insetEl) this.insetEl.classList.add('hidden');
  }

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

  /** 省级名字标签锚点：从省界 GeoJSON 计算（每日竞速省名标签用）。 */
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

  /** 港澳放大框专用地图：香港 + 澳门 + 广东（周边海岸），从省界 GeoJSON 抽取。 */
  private buildHkmacGeo(): unknown {
    const src = this.data.provincesGeoJson as { type: string; features?: GeoFeature[] };
    const keep = new Set(['440000', '810000', '820000']);
    return {
      type: src.type,
      features: (src.features ?? []).filter((f) => keep.has(f.properties.adcode ?? '')),
    };
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

  /** 每日竞速省名标签：已作答省份的简称（答对绿字/答错红字），始终显示不随缩放消失。 */
  private buildProvinceLabelData(state: RenderState): LabelPoint[] {
    if (!state.provinceLabel || !this.provinceMode) return [];
    const theme = this.theme();
    const out: LabelPoint[] = [];
    for (const p of this.data.provinces) {
      const lab = state.provinceLabel(p.adcode);
      if (!lab) continue;
      const anchor = this.provinceLabelAnchors.get(p.adcode);
      if (!anchor) continue;
      const color = lab.color === 'green' ? theme.labelGreen : theme.labelRed;
      out.push({ name: p.name, value: [...anchor, lab.text, color, 0, 0] });
    }
    return out;
  }

  /** 港澳放大框渲染：香港、澳门按主图状态着色并显示简称标签，广东为淡灰底（不可作答）。 */
  private renderInset() {
    const chart = this.insetChart;
    if (!chart) return;
    const state = this.lastState;
    if (!state) return;
    const theme = this.theme();
    const regionOf = (adcode: string, short: string): GeoRegion => {
      const color: UnitColor = state.colorOf(adcode);
      return {
        name: this.provinceFeatureName(adcode),
        itemStyle: { areaColor: theme.fill[color], borderColor: theme.boundary[this.provinceBoundaryTone], borderWidth: 1 },
        emphasis: { itemStyle: { areaColor: theme.emphasis[color] }, label: { show: false } },
        label: { show: true, formatter: short, color: theme.labelNeutral, fontSize: 10, fontWeight: 600 },
      };
    };
    const hk = regionOf('810000', '香港');
    const mo = regionOf('820000', '澳门');
    // 广东沿海：淡灰底，silent 不参与作答
    const gd: GeoRegion = {
      name: this.provinceFeatureName('440000'),
      silent: true,
      itemStyle: { areaColor: theme.fill.gray, borderColor: theme.boundary[this.provinceBoundaryTone], borderWidth: 1 },
      emphasis: { itemStyle: { areaColor: theme.fill.gray }, label: { show: false } },
      label: { show: false },
    };
    chart.setOption({
      backgroundColor: 'transparent',
      geo: {
        map: 'hkmac',
        roam: false,
        silent: false,
        zoom: 6,
        center: [113.97, 22.34],
        itemStyle: { borderColor: 'rgba(0,0,0,0)', borderWidth: 0 },
        regions: [gd, hk, mo],
      },
    } as never);
  }

  private provinceFeatureName(adcode: string): string {
    const geo = this.data.provincesGeoJson as { features?: GeoFeature[] };
    const f = (geo.features ?? []).find((x) => x.properties.adcode === adcode);
    return f?.properties.name ?? '';
  }

  /** 放大框点击：命中香港/澳门省面时回传省 adcode。 */
  private onInsetClick(p: unknown) {
    const params = p as { name?: string };
    const adcode = this.insetNameToAdcode(params.name);
    if (adcode) this.handlers.onUnitClick(adcode);
  }

  private onInsetHover(p: unknown) {
    const params = p as { name?: string };
    const adcode = this.insetNameToAdcode(params.name);
    if (adcode) this.handlers.onUnitHover?.(adcode);
  }

  private insetNameToAdcode(name: string | undefined): string | null {
    if (!name) return null;
    if (name === this.provinceFeatureName('810000')) return '810000';
    if (name === this.provinceFeatureName('820000')) return '820000';
    return null;
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
            const value = [api.value(0), api.value(1)] as [number, number];
            // ECharts custom series 会把 value 数组中的字符串数字转成 number，
            // 这里统一转字符串，保证价格/地名都能显示。
            const rawText = api.value(2);
            const name = rawText == null ? '' : String(rawText);
            const color = String(api.value(3));
            const isPrice = Number(api.value(4)) === 1;
            const noBg = Number(api.value(5)) === 1;
            const point = api.coord(value) as number[];
            // NaN 防御：坐标非有限或文本异常时跳过该标签，避免显示 "NaN"
            if (!Number.isFinite(point[0]) || !Number.isFinite(point[1]) || !name || name === 'NaN' || name === 'undefined') {
              return { type: 'group', children: [] };
            }
            const scale = labelScale(this.zoom);
            const fontSize = (isPrice ? PRICE_LABEL_SIZE : CITY_LABEL_SIZE) * scale;
            const font = `${isPrice ? 700 : 600} ${fontSize}px Microsoft YaHei, PingFang SC, system-ui, sans-serif`;
            // 隐藏衬底的价格：无背景矩形，白色文字 + 细黑描边（固定 1-2px），不随字号变粗
            if (isPrice && noBg) {
              return {
                type: 'group',
                children: [
                  {
                    type: 'text',
                    style: {
                      x: point[0],
                      y: point[1] + fontSize * 0.1,
                      text: name,
                      fill: '#ffffff',
                      textBorderColor: '#000000',
                      textBorderWidth: 1.5,
                      font,
                      align: 'center',
                      verticalAlign: 'middle',
                    },
                  },
                ],
              };
            }
            const padX = (isPrice ? 4 : 8) * scale;
            const padY = (isPrice ? 3 : 6) * scale;
            const minWidth = (isPrice ? 26 : 34) * scale;
            const shape = labelShape(name, point, fontSize, padX, padY, minWidth);
            return {
              type: 'group',
              children: [
                {
                  type: 'rect',
                  shape,
                  style: {
                    fill: theme.labelBg,
                    shadowColor: theme.labelShadow,
                    shadowBlur: 8 * scale,
                    shadowOffsetY: 2 * scale,
                  },
                },
                {
                  type: 'text',
                  style: {
                    x: point[0],
                    y: point[1] + (isPrice ? fontSize * 0.1 : 0), // 价格文本下移微调，保证垂直居中
                    text: name,
                    fill: color,
                    font,
                    align: 'center',
                    verticalAlign: 'middle',
                  },
                },
              ],
            };
          },
          data: labelData,
        },
        {
          // 每日竞速省名标签：已作答省的简称，始终显示
          id: 'province-labels',
          type: 'custom',
          coordinateSystem: 'geo',
          geoIndex: 0,
          z: 9, // 低于 city-labels 但高于省界线
          silent: true,
          tooltip: { show: false },
          renderItem: (_params, api) => {
            const value = [api.value(0), api.value(1)] as [number, number];
            const rawText = api.value(2);
            const name = rawText == null ? '' : String(rawText);
            const color = String(api.value(3));
            const point = api.coord(value) as number[];
            // NaN 防御
            if (!Number.isFinite(point[0]) || !Number.isFinite(point[1]) || !name || name === 'NaN' || name === 'undefined') {
              return { type: 'group', children: [] };
            }
            const scale = labelScale(this.zoom);
            const fontSize = PROVINCE_LABEL_SIZE * scale;
            const font = `600 ${fontSize}px Microsoft YaHei, PingFang SC, system-ui, sans-serif`;
            const padX = 7 * scale;
            const padY = 4 * scale;
            const shape = labelShape(name, point, fontSize, padX, padY, 30 * scale);
            return {
              type: 'group',
              children: [
                {
                  type: 'rect',
                  shape,
                  style: {
                    fill: theme.labelBg,
                    shadowColor: theme.labelShadow,
                    shadowBlur: 8 * scale,
                    shadowOffsetY: 2 * scale,
                  },
                },
                {
                  type: 'text',
                  style: {
                    x: point[0],
                    y: point[1],
                    text: name,
                    fill: color,
                    font,
                    align: 'center',
                    verticalAlign: 'middle',
                  },
                },
              ],
            };
          },
          data: provinceLabelData,
        },
      ],
    };
    this.chart.setOption(option);
    // 省级模式下同步刷新港澳放大框着色
    if (this.provinceMode) this.renderInset();
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

  /** 标记成功时的高亮动画（临时改色后恢复，不依赖 emphasis 机制） */
  flash(adcode: string) {
    const u = this.adcodeToUnit.get(adcode);
    if (!u) return;
    this.clearFlash();
    const opt = this.chart.getOption() as {
      geo?: { regions?: GeoRegion[] }[] | { regions?: GeoRegion[] };
    };
    const geos = Array.isArray(opt.geo) ? opt.geo : [opt.geo];
    const regions = geos[0]?.regions;
    const theme = this.theme();
    if (Array.isArray(regions)) {
      for (const item of regions) {
        if (item.name === u.name) {
          item.itemStyle = { ...item.itemStyle, areaColor: theme.flashArea, borderColor: theme.flashBorder, borderWidth: 1.2 };
        }
      }
      this.chart.setOption({ geo: { regions } } as never);
    }
    this.flashAdcode = u.adcode;
    this.flashTimer = window.setTimeout(() => {
      if (this.flashAdcode === u.adcode) {
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
    this.viewProvince = null;
    this.center = [104.5, 35];
    this.zoom = 1;
    this.labelMode = 'none';
    if (this.lastState) this.render(this.lastState);
    this.chart.setOption({ geo: { map: this.currentMapName(), center: this.center, zoom: 1 } });
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
    this.insetChart?.dispose();
    this.insetChart = null;
  }
}

function bboxOf(feature: { geometry: { coordinates: unknown } }): [number, number, number, number] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const walk = (coords: unknown) => {
    if (!Array.isArray(coords)) return;
    for (const c of coords as unknown[]) {
      if (Array.isArray(c) && typeof c[0] === 'number') {
        const x = c[0] as number;
        const y = c[1] as number;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      } else {
        walk(c);
      }
    }
  };
  walk(feature.geometry.coordinates);
  return [minX, minY, maxX, maxY];
}

function polygonsOf(feature: GeoFeature): PolygonRings[] {
  const geometry = feature.geometry;
  if (geometry.type === 'Polygon') return [ringsOf(geometry.coordinates)].filter((rings) => rings.length > 0);
  if (geometry.type !== 'MultiPolygon' || !Array.isArray(geometry.coordinates)) return [];
  return geometry.coordinates.map((poly) => ringsOf(poly)).filter((rings) => rings.length > 0);
}

function ringsOf(raw: unknown): PolygonRings {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((ring) => {
      if (!Array.isArray(ring)) return [];
      return ring.filter(isGeoPoint).map((p) => [p[0], p[1]] as GeoPoint);
    })
    .filter((ring) => ring.length >= 3);
}

function isGeoPoint(value: unknown): value is GeoPoint {
  return Array.isArray(value) && typeof value[0] === 'number' && typeof value[1] === 'number';
}

function bestLabelAnchor(polygons: PolygonRings[]): GeoPoint {
  const polygon = largestPolygon(polygons);
  const outer = polygon[0];
  const [minX, minY, maxX, maxY] = bboxOfRings(polygon);
  const centroid = ringCentroid(outer);
  let best = pointInPolygon(centroid, polygon) ? centroid : firstInsidePoint(polygon) ?? [(minX + maxX) / 2, (minY + maxY) / 2];
  let bestScore = anchorScore(best, polygon);

  const search = (fromX: number, fromY: number, toX: number, toY: number, steps: number) => {
    const dx = (toX - fromX) / steps;
    const dy = (toY - fromY) / steps;
    for (let ix = 0; ix <= steps; ix += 1) {
      for (let iy = 0; iy <= steps; iy += 1) {
        const point: GeoPoint = [fromX + dx * ix, fromY + dy * iy];
        const score = anchorScore(point, polygon);
        if (score > bestScore) {
          best = point;
          bestScore = score;
        }
      }
    }
  };

  search(minX, minY, maxX, maxY, 14);
  let spanX = (maxX - minX) / 6;
  let spanY = (maxY - minY) / 6;
  for (let i = 0; i < 2; i += 1) {
    search(best[0] - spanX, best[1] - spanY, best[0] + spanX, best[1] + spanY, 10);
    spanX /= 3;
    spanY /= 3;
  }
  return best;
}

function largestPolygon(polygons: PolygonRings[]): PolygonRings {
  return polygons.reduce((best, current) => (Math.abs(ringArea(current[0])) > Math.abs(ringArea(best[0])) ? current : best));
}

function bboxOfRings(rings: PolygonRings): [number, number, number, number] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const ring of rings) {
    for (const [x, y] of ring) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  return [minX, minY, maxX, maxY];
}

function firstInsidePoint(polygon: PolygonRings): GeoPoint | null {
  for (const ring of polygon) {
    for (const point of ring) {
      if (pointInPolygon(point, polygon)) return point;
    }
  }
  return null;
}

function anchorScore(point: GeoPoint, polygon: PolygonRings): number {
  if (!pointInPolygon(point, polygon)) return -Infinity;
  let minDistance = Infinity;
  for (const ring of polygon) {
    for (let i = 0; i < ring.length; i += 1) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      minDistance = Math.min(minDistance, distanceToSegment(point, a, b));
    }
  }
  return minDistance;
}

function ringCentroid(ring: GeoPoint[]): GeoPoint {
  let area2 = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[(i + 1) % ring.length];
    const cross = x0 * y1 - x1 * y0;
    area2 += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }
  if (Math.abs(area2) < 1e-9) return averagePoint(ring);
  return [cx / (3 * area2), cy / (3 * area2)];
}

function averagePoint(points: GeoPoint[]): GeoPoint {
  const sum = points.reduce((acc, [x, y]) => [acc[0] + x, acc[1] + y] as GeoPoint, [0, 0]);
  return [sum[0] / points.length, sum[1] / points.length];
}

function ringArea(ring: GeoPoint[]): number {
  let area = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[(i + 1) % ring.length];
    area += x0 * y1 - x1 * y0;
  }
  return area / 2;
}

function pointInPolygon(point: GeoPoint, polygon: PolygonRings): boolean {
  if (!pointInRing(point, polygon[0])) return false;
  return polygon.slice(1).every((hole) => !pointInRing(point, hole));
}

function pointInRing([x, y]: GeoPoint, ring: GeoPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function distanceToSegment(point: GeoPoint, a: GeoPoint, b: GeoPoint): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  if (dx === 0 && dy === 0) return Math.hypot(point[0] - a[0], point[1] - a[1]);
  const t = Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / (dx * dx + dy * dy)));
  const x = a[0] + t * dx;
  const y = a[1] + t * dy;
  return Math.hypot(point[0] - x, point[1] - y);
}
