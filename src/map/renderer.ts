import * as echarts from 'echarts';
import type { AppData, RenderState, Unit, UnitColor } from '../types';

type GeoRegion = NonNullable<echarts.GeoComponentOption['regions']>[number];

const FILL: Record<UnitColor, string> = {
  green: '#2fae4e',
  blue: '#2196f3', // 当前题目
  red: '#e53935', // 答错标记
  gray: '#e6e6e6',
};
const EMPH: Record<UnitColor, string> = {
  green: '#5cc97e',
  blue: '#5fb4f8',
  red: '#f26060',
  gray: '#f2f2f2',
};
const BORDER = '#9aa0a6'; // 地级边界（细线）
const PROV_BORDER = '#4b5563'; // 省界（粗线）
const NATION_W = 61.6; // 全国经度跨度（约 73.5 ~ 135.1）
const NATION_H = 49.8; // 全国纬度跨度（约 3.8 ~ 53.6）
const LABEL_ZOOM = 2.5; // 缩放阈值：低于不显示任何标签，高于显示地级标签（防扎堆）
const CITY_LABEL_SIZE = 12;

const STATUS_TXT: Record<UnitColor, string> = {
  green: '已记忆',
  blue: '当前题目',
  red: '答错',
  gray: '未涉及',
};

export interface MapHandlers {
  onUnitClick: (adcode: string) => void;
  onUnitDblClick: (adcode: string) => void;
}

/** 白底标签（边框/字体颜色 = 状态色） */
function labelStyle(color: string, fontSize: number, show = true) {
  return {
    show,
    color,
    fontSize,
    backgroundColor: '#ffffff',
    borderColor: color,
    borderWidth: 1.5,
    borderRadius: 4,
    padding: [2, 6],
  };
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
  private provinceLines: { adcode: string; coords: number[][] }[] = [];
  private viewProvince: string | null = null;
  private zoom = 1;
  private labelMode: 'none' | 'city' = 'none'; // 缩放低于阈值 → 无标签
  private lastState: RenderState | null = null;
  private flashAdcode: string | null = null;
  private flashTimer: number | null = null;
  onViewChange: (() => void) | null = null;

  constructor(private el: HTMLElement, private data: AppData, private handlers: MapHandlers) {
    echarts.registerMap('china', data.geoJson as never);
    this.chart = echarts.init(el);
    this.units = data.allUnits;
    for (const u of this.units) this.nameToUnit.set(u.name, u);
    this.provinceLines = this.buildProvinceLines();

    this.chart.on('click', (p) => {
        this.clearFlash(); // 点击任何位置先清除黄色高亮，避免点空白处不消失
      const params = p as { componentType?: string; seriesType?: string; name?: string };
      if (params.componentType !== 'series' || params.seriesType !== 'map') return;
      const u = this.nameToUnit.get(params.name ?? '');
      if (!u || u.decorative) return;
      if (this.viewProvince && u.provinceAdcode !== this.viewProvince) return;
      this.handlers.onUnitClick(u.adcode);
    });

    this.chart.on('dblclick', (p) => {
      const params = p as { componentType?: string; seriesType?: string; name?: string };
      if (this.viewProvince) {
        this.backToNation();
        return;
      }
      if (params.componentType === 'series' && params.seriesType === 'map') {
        const u = this.nameToUnit.get(params.name ?? '');
        if (!u || u.decorative) return;
        this.handlers.onUnitDblClick(u.adcode);
        return;
      }
      // geo 兜底：空白/边界附近点击命中的地级 region
      if (params.componentType === 'geo') {
        const u = this.nameToUnit.get(params.name ?? '');
        if (!u || u.decorative) return;
        this.handlers.onUnitDblClick(u.adcode);
      }
    });

    // 缩放（geo 组件 roam）时按阈值切换标签模式
    this.chart.on('georoam', (p) => {
      const params = p as { zoom?: number; totalZoom?: number };
      if (typeof params.totalZoom === 'number') {
        this.zoom = params.totalZoom;
        this.applyLabelMode();
      }
        else if (typeof params.zoom === 'number') {
          this.zoom = Math.max(0.5, this.zoom * params.zoom);
          this.applyLabelMode();
        }
        this.syncProvinceLines();
    });

    // 兜底：渲染后从 option 读回实际缩放
    this.chart.on('rendered', () => {
      const opt = this.chart.getOption() as { geo?: { zoom?: number }[] | { zoom?: number } };
      const z = Array.isArray(opt.geo) ? opt.geo[0]?.zoom : opt.geo?.zoom;
      if (typeof z === 'number' && Math.abs(z - this.zoom) > 0.001) {
        this.zoom = z;
        this.applyLabelMode();
      }
    });

    window.addEventListener('resize', () => this.chart.resize());
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

    /** 强制 lines 系列按当前 geo 视图重算布局，防止缩放/平移时省界与市界错位 */
    private syncProvinceLines() {
      if (!this.lastState) return;
      this.chart.setOption({
          series: [{
            id: 'province-lines', coordinateSystem: 'geo', geoIndex: 0, polyline: true,
            data: this.buildLineData(),
          }],
        } as never);
    }

  private applyLabelMode() {
    const mode = this.zoom < LABEL_ZOOM ? 'none' : 'city';
    if (mode === this.labelMode) return;
    this.labelMode = mode;
    if (this.lastState) this.render(this.lastState);
  }

  /** 按当前模式状态重绘（保留用户缩放/平移） */
  render(state: RenderState) {
    this.lastState = state;
    const showCityLabels = this.labelMode === 'city';

    // 地级面样式：必须放在 geo.regions 上。绑定 geoIndex 的 map series 不会绘制
      // 自己的 itemStyle/label，若像旧实现那样放在 series.data 里，整张地图会变透明。
      // 自己的 itemStyle/label，若像旧实现那样放在 series.data 里，整张地图会变透明。
    const regionData: GeoRegion[] = this.units.map((u) => {
      const inView = !this.viewProvince || u.provinceAdcode === this.viewProvince;
      const color: UnitColor = u.decorative ? 'gray' : state.colorOf(u.adcode);
      let label: GeoRegion['label'];
      if (u.decorative) {
        label = { show: false }; // 县级填充面/南海诸岛不显示标签
      } else if (showCityLabels) {
        if (color === 'green') label = labelStyle('#15803d', CITY_LABEL_SIZE);
        else if (color === 'red') label = labelStyle('#b91c1c', CITY_LABEL_SIZE);
        else if (state.showAllLabels) label = labelStyle('#374151', CITY_LABEL_SIZE); // 记忆模式中性色
        else label = { show: false }; // 蓝色题目（防答案泄漏）与灰色不显示
      } else {
        label = { show: false }; // 缩得太小 → 全部不显示，防扎堆
      }
      return {
        name: u.name,
          silent: !inView,
        itemStyle: {
          areaColor: inView ? FILL[color] : 'rgba(0,0,0,0)',
          borderColor: inView ? BORDER : 'rgba(0,0,0,0)',
          borderWidth: inView ? 0.6 : 0,
        },
        label,
      };
    });

      // map series 只提供 data 用于 tooltip/事件；区域样式由 geo.regions 负责。
      const cityData = this.units.map((u) => ({ name: u.name }));

    // 省界粗线（lines 系列，跟随同一 geo 坐标系；下钻时只保留当前省）
    const lineData = this.provinceLines
      .filter((l) => !this.viewProvince || l.adcode === this.viewProvince || (l.adcode === '100000_JD' && this.viewProvince === '460000'))
      .map((l) => ({ coords: l.coords }));

    const option: echarts.EChartsOption = {
      tooltip: state.disableTooltip
        ? { show: false }
        : {
            trigger: 'item',
            formatter: (p) => {
              const params = p as { name?: string };
              const u = this.nameToUnit.get(params.name ?? '');
              if (!u) return String(params.name ?? '');
              const color: UnitColor = u.decorative ? 'gray' : state.colorOf(u.adcode);
              const status = u.decorative ? '' : `<br/>状态：${STATUS_TXT[color]}`;
              return `<b>${u.name}</b><br/>所属：${u.province}${status}`;
            },
          },
      geo: {
        map: 'china', // 坐标系 = 地级数据（series 绑定后使用同一地图，地级名才能匹配上）
        roam: true,
          selectedMode: false,
        tooltip: { show: false },
        label: { show: false },
        emphasis: {
          label: { show: false },
          itemStyle: { areaColor: 'rgba(255,255,255,0.22)' }, // 悬停高亮（半透明遮罩）
        },
          select: { label: { show: false } },
        itemStyle: {
          areaColor: 'rgba(0,0,0,0)',
          borderColor: 'rgba(0,0,0,0)',
          borderWidth: 0, // geo 自身透明；地级边界由 geo.regions 绘制
        },
          regions: regionData,
      },
      series: [
        {
          type: 'map',
          map: 'china',
          geoIndex: 0,
            selectedMode: false,
          label: { show: false },
          emphasis: { label: { show: false } },
            select: { label: { show: false } },
          data: cityData,
        },
        {
          type: 'lines',
            id: 'province-lines',
          coordinateSystem: 'geo',
          geoIndex: 0,
          z: 3, // 画在地级面之上
          silent: true,
          tooltip: { show: false },
          polyline: true, // 必须开启：false 时每个省界环只取前两个点，边界基本不可见
            lineStyle: { color: PROV_BORDER, width: 2.4, opacity: 1 },
          data: lineData,
        },
      ],
    };
    this.chart.setOption(option);
  }

    /** 清除临时黄色高亮（点击空白/其他区域时立即恢复） */
    private clearFlash() {
      if (this.flashTimer !== null) {
        window.clearTimeout(this.flashTimer);
        this.flashTimer = null;
      }
      if (this.flashAdcode) {
        this.flashAdcode = null;
        if (this.lastState) {
          this.flashAdcode = null;
          this.flashTimer = null;
          if (this.lastState) {
          this.flashAdcode = null;
          this.flashTimer = null;
          if (this.lastState) this.render(this.lastState);
        }
        }
          this.flashAdcode = null;
          this.flashTimer = null;
          if (this.lastState) {
        }
      }
    }

  /** 标记成功时的高亮动画（临时改色后恢复，不依赖 emphasis 机制） */
  flash(adcode: string) {
    const u = this.nameToUnit.get(adcode);
    if (!u) return;
      this.clearFlash();
    const opt = this.chart.getOption() as {
      geo?: { regions?: GeoRegion[] }[] | { regions?: GeoRegion[] };
    };
    const geos = Array.isArray(opt.geo) ? opt.geo : [opt.geo];
      const regions = geos[0]?.regions;
    if (Array.isArray(regions)) {
      for (const item of regions) {
        if (item.name === u.name) {
          item.itemStyle = { ...item.itemStyle, areaColor: '#ffe066', borderColor: '#f59e0b', borderWidth: 1.5 };
        }
      }
      this.chart.setOption({ geo: [{ regions }] } as never);
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

  /** 下钻到某省：其他区域消失，自动缩放居中（必然进入地级标签模式） */
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
    const zoom = Math.min(60, Math.max(1.05, (1 / Math.max(bw / NATION_W, bh / NATION_H)) * 0.9));
    this.viewProvince = adcode;
    this.zoom = zoom;
    this.labelMode = 'city';
    if (this.lastState) this.render(this.lastState);
    // 必须带上 map：首次渲染前调用时 geo 组件尚未初始化，缺 map 会加载空地图导致崩溃
    this.chart.setOption({ geo: { map: 'china', center: [(minX + maxX) / 2, (minY + maxY) / 2], zoom } });
    this.onViewChange?.();
  }

  backToNation() {
    this.viewProvince = null;
    this.zoom = 1;
    this.labelMode = 'none';
    if (this.lastState) this.render(this.lastState);
    this.chart.setOption({ geo: { map: 'china', center: [104.5, 35], zoom: 1 } });
    this.onViewChange?.();
  }

  currentProvince(): string | null {
    return this.viewProvince;
  }

  dispose() {
    this.chart.dispose();
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
