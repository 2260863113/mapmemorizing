import * as echarts from 'echarts';
import type { RenderState, UnitColor } from '../types';
import type { MapTheme } from './theme';
import type { GeoFeature } from './geometry';
import type { MapHandlers } from './renderer';

type GeoRegion = NonNullable<echarts.GeoComponentOption['regions']>[number];

export interface InsetDeps {
  /** 当前主题（随明暗/边界色调切换）。 */
  theme(): MapTheme;
  /** 当前渲染状态（着色函数）。 */
  state(): RenderState | null;
  /** 省界边界色调。 */
  boundaryTone(): 'light' | 'mid' | 'dark';
  /** 主图交互回调（点击/悬浮港澳省面时回传 adcode）。 */
  handlers: MapHandlers;
  /** 省界 GeoJSON（用于抽取港澳 + 广东沿海）。 */
  provincesGeoJson: unknown;
}

/**
 * 港澳放大框：香港 + 澳门 + 广东沿海的独立 ECharts 子图。
 * 主图保持港澳两省；放大框提供大目标便捷点击。封装子图的初始化/显示/隐藏/渲染/事件。
 */
export class InsetMap {
  private el: HTMLElement | null = null;
  private chart: echarts.ECharts | null = null;
  private nameToAdcode = new Map<string, string>(); // 省全名 → 省 adcode（港澳）

  constructor(private deps: InsetDeps) {}

  /** 注册港澳放大框地图（香港+澳门+广东沿海）。 */
  registerMap() {
    echarts.registerMap('hkmac', this.buildHkmacGeo() as never);
  }

  show() {
    if (!this.el) this.el = document.getElementById('hkmac-inset');
    if (!this.el) return;
    this.el.classList.remove('hidden');
    if (!this.chart) {
      this.chart = echarts.init(this.el);
      this.chart.on('click', (p) => this.onClick(p));
      this.chart.on('mouseover', (p) => this.onHover(p));
      this.chart.on('mouseout', () => this.deps.handlers.onUnitHoverEnd?.());
    } else {
      // 容器曾隐藏（display:none）时 ECharts 画布可能残留 0 尺寸/旧尺寸，恢复可见后强制重算
      this.chart.resize();
    }
    this.render();
  }

  hide() {
    if (!this.el) this.el = document.getElementById('hkmac-inset');
    this.el?.classList.add('hidden');
  }

  resize() {
    this.chart?.resize();
  }

  /** 主图每次重绘后同步刷新放大框着色。 */
  render() {
    const chart = this.chart;
    if (!chart) return;
    const state = this.deps.state();
    if (!state) return;
    const theme = this.deps.theme();
    const regionOf = (adcode: string, short: string): GeoRegion => {
      const color: UnitColor = state.colorOf(adcode);
      return {
        name: this.provinceFeatureName(adcode),
        itemStyle: { areaColor: theme.fill[color], borderColor: theme.boundary[this.deps.boundaryTone()], borderWidth: 1 },
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
      itemStyle: { areaColor: theme.fill.gray, borderColor: theme.boundary[this.deps.boundaryTone()], borderWidth: 1 },
      emphasis: { itemStyle: { areaColor: theme.fill.gray }, label: { show: false } },
      label: { show: false },
    };
    chart.setOption({
      backgroundColor: 'transparent',
      geo: {
        map: 'hkmac',
        roam: false,
        silent: false,
        zoom: 11,
        center: [113.85, 22.3],
        itemStyle: { borderColor: 'rgba(0,0,0,0)', borderWidth: 0 },
        regions: [gd, hk, mo],
      },
    } as never);
  }

  dispose() {
    this.chart?.dispose();
    this.chart = null;
    this.el = null;
  }

  private buildHkmacGeo(): unknown {
    const src = this.deps.provincesGeoJson as { type: string; features?: GeoFeature[] };
    const keep = new Set(['440000', '810000', '820000']);
    return {
      type: src.type,
      features: (src.features ?? []).filter((f) => keep.has(f.properties.adcode ?? '')),
    };
  }

  private provinceFeatureName(adcode: string): string {
    const geo = this.deps.provincesGeoJson as { features?: GeoFeature[] };
    const f = (geo.features ?? []).find((x) => x.properties.adcode === adcode);
    return f?.properties.name ?? '';
  }

  private onClick(p: unknown) {
    const params = p as { name?: string };
    const adcode = this.insetNameToAdcode(params.name);
    if (adcode) this.deps.handlers.onUnitClick(adcode);
  }

  private onHover(p: unknown) {
    const params = p as { name?: string };
    const adcode = this.insetNameToAdcode(params.name);
    if (adcode) this.deps.handlers.onUnitHover?.(adcode);
  }

  private insetNameToAdcode(name: string | undefined): string | null {
    if (!name) return null;
    if (name === this.provinceFeatureName('810000')) return '810000';
    if (name === this.provinceFeatureName('820000')) return '820000';
    return null;
  }
}