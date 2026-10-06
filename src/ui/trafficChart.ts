/**
 * 流量看板的 ECharts 子图：**只负责实例生命周期**（建 / 更新 / 尺寸 / 读回 / 销毁），
 * option 的构造全在纯模块 `./trafficSeries.ts`。
 *
 * 为什么单独一层（与 `../map/inset.ts` 的港澳放大框同一手法）：面板每次切子视图都会重建
 * `#admin-body` 的 innerHTML，容器元素因此被换掉 —— 谁建实例必须由谁负责销毁，否则反复
 * 切 tab 会留下越来越多没有 DOM 归属的 canvas（ECharts 实例还会继续监听 resize）。
 * 这个类把「建/销」成对地放在一起，面板只需在重建 DOM 前调一次 `dispose()`。
 */
import * as echarts from 'echarts';
import { buildTrafficOption, trafficPalette, type TooltipTextFn, type TrafficPoint, type TrafficUnit } from './trafficSeries';

/** option 的**读回**结果（探针用：断言真正画出来的点数、x 轴刻度与主题色，而不是"我们以为写进去的"）。 */
export interface TrafficOptionReadback {
  type: string;
  xAxis: string[];
  counts: number[];
  /** 折线颜色（应跟随 `--accent`：明暗主题各一档）。 */
  lineColor: string;
  /** tooltip 底色（取自 `MAP_THEMES`：浅色主题白底、暗色主题深底）。 */
  tooltipBg: string;
}

export class TrafficChart {
  private chart: echarts.ECharts | null = null;
  private observer: ResizeObserver | null = null;

  constructor(private el: HTMLElement) {}

  /**
   * 读当前生效的 CSS 变量（`--accent` / `--muted` / `--panel-border` / `--panel-bg`）。
   * 每次渲染现取一遍：`getComputedStyle` 反映的是**此刻**的 `body.theme-dark` 状态，
   * 因此明暗主题切换后重画一次即可跟随，不需要维护第二份颜色表。
   */
  private readVar = (name: string): string => {
    try {
      return window.getComputedStyle(this.el).getPropertyValue(name);
    } catch {
      return '';
    }
  };

  /**
   * 是否已建实例（离开面板/重建 DOM 时该为 false）。
   * 面板探针用它配合"当前是否在本子视图"判断看板是否真的挂着（见 `AdminPanel.diagnostics()`）。
   */
  get mounted(): boolean {
    return this.chart !== null;
  }

  /**
   * 容器内的画布数量。
   * 面板探针改按**容器**数 canvas（`container.querySelectorAll('canvas')`）：那样连"实例已销毁但
   * DOM 残留"也能发现；这两个实例级读数留给需要区分实例与容器的调用方。
   */
  canvasCount(): number {
    return this.el.querySelectorAll('canvas').length;
  }

  /** 图表高度（像素）：容器塌成 0 高时 ECharts 会画成 0×0。 */
  height(): number {
    return this.el.clientHeight;
  }

  /**
   * 建实例（幂等）。ECharts 在容器 0 尺寸时初始化会画成 0×0，故这里无条件挂一个
   * ResizeObserver：容器从隐藏转显示 / 窗口缩放 / 面板宽度变化都会触发一次 resize。
   */
  private ensure(): echarts.ECharts {
    if (this.chart) return this.chart;
    const chart = echarts.init(this.el);
    this.chart = chart;
    if (typeof ResizeObserver !== 'undefined') {
      this.observer = new ResizeObserver(() => chart.resize());
      this.observer.observe(this.el);
    }
    return chart;
  }

  /**
   * 按当前数据重绘（`notMerge`：切范围时整条 series 换掉，不做增量合并）。
   *
   * `tooltipText` 透传给 option 构造（唯一的口径差异）：日志看板用访问量、游玩看板用游玩量，
   * 两个看板共用这一个类与同一套几何，只有量词不同。
   */
  render(points: readonly TrafficPoint[], unit: TrafficUnit, dark: boolean, tooltipText?: TooltipTextFn) {
    const chart = this.ensure();
    chart.setOption(
      buildTrafficOption({ points, unit, palette: trafficPalette(dark, this.readVar), tooltipText }),
      true,
    );
    chart.resize();
  }

  /** 读回真正生效的 option（点数 / x 轴刻度 / 系列类型 / 主题色）。 */
  readback(): TrafficOptionReadback | null {
    if (!this.chart) return null;
    const option = this.chart.getOption() as {
      xAxis?: { data?: unknown[] }[] | { data?: unknown[] };
      series?: { type?: string; data?: unknown[]; lineStyle?: { color?: unknown } }[] | { type?: string; data?: unknown[]; lineStyle?: { color?: unknown } };
      tooltip?: { backgroundColor?: unknown }[] | { backgroundColor?: unknown };
    };
    const xAxis = Array.isArray(option.xAxis) ? option.xAxis[0] : option.xAxis;
    const series = Array.isArray(option.series) ? option.series[0] : option.series;
    const tooltip = Array.isArray(option.tooltip) ? option.tooltip[0] : option.tooltip;
    return {
      type: String(series?.type ?? ''),
      xAxis: (xAxis?.data ?? []).map((v) => String(v)),
      counts: (series?.data ?? []).map((v) => Number(v)),
      lineColor: String(series?.lineStyle?.color ?? ''),
      tooltipBg: String(tooltip?.backgroundColor ?? ''),
    };
  }

  /**
   * 数据点的画布像素坐标（相对图表容器左上角）。验收脚本据此把**真实鼠标事件**打到标记点上
   * —— 只验"tooltip 配置存在"证明不了"鼠标挪上去真的会弹访问量"。
   */
  pointPixel(index: number, value: number): [number, number] | null {
    if (!this.chart) return null;
    try {
      const pixel = this.chart.convertToPixel({ seriesIndex: 0 }, [index, value]);
      if (!pixel || !Number.isFinite(pixel[0]) || !Number.isFinite(pixel[1])) return null;
      return [pixel[0], pixel[1]];
    } catch {
      return null;
    }
  }

  dispose() {
    this.observer?.disconnect();
    this.observer = null;
    this.chart?.dispose();
    this.chart = null;
  }
}
