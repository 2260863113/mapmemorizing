/**
 * 管理端「流量看板」的**纯逻辑**：范围 → 粒度/桶数、缺桶补 0、标签与 tooltip 文案、
 * y 轴上限、ECharts option 构造。
 *
 * 为什么单独成模块：这些全是「错了也看不出来」的换算（桶顺序错一格、缺桶画成等距、
 * tooltip 文案拿错粒度），而它们不需要 DOM、不需要 ECharts 实例、不需要 fetch —— 正是
 * 最该单测的那一类。ECharts 实例的生命周期在 `./trafficChart.ts`，面板装配在 `./adminPanel.ts`。
 *
 * 与后端 `functions/_lib/statsWindow.ts` 是**同一口径的两半**（`src/` 与 `functions/` 两套
 * tsconfig，跨目录 import 会把前端代码打进 Worker）：桶数与粒度由两侧注释互指，
 * `trafficSeries.test.ts` 锁住这一半。
 */
import type * as echarts from 'echarts';
import { t, type MessagesKey } from '../i18n';
import { MAP_THEMES } from '../map/theme';

/** 时间范围：近一天 / 近七天 / 近一个月。 */
export type TrafficRange = 'day' | 'week' | 'month';
/** 粒度：按小时（近一天）或按天（近七天 / 近一个月）。 */
export type TrafficUnit = 'hour' | 'day';

/** 折线上的一个点（`label` 是服务端给的桶标签，如 `2026-09-16` / `2026-09-16 14:00`）。 */
export interface TrafficPoint {
  label: string;
  count: number;
}

export interface TrafficRangeSpec {
  range: TrafficRange;
  unit: TrafficUnit;
  /** 该范围的桶数（近一天 24 / 近七天 7 / 近一月 30）。 */
  points: number;
  /** 段按钮文案键。 */
  labelKey: MessagesKey;
}

/** 三个范围（顺序即按钮顺序）。 */
export const TRAFFIC_RANGES: readonly TrafficRange[] = ['day', 'week', 'month'];

/** 范围 → 粒度/桶数/文案键（与后端 `STATS_RANGE_SPECS` 逐字对应）。 */
export const TRAFFIC_RANGE_SPECS: Record<TrafficRange, TrafficRangeSpec> = {
  day: { range: 'day', unit: 'hour', points: 24, labelKey: 'admin.rangeDay' },
  week: { range: 'week', unit: 'day', points: 7, labelKey: 'admin.rangeWeek' },
  month: { range: 'month', unit: 'day', points: 30, labelKey: 'admin.rangeMonth' },
};

/** 默认范围（与后端同一取值：稳定、且信息量比「近一天」更能看出趋势）。 */
export const DEFAULT_TRAFFIC_RANGE: TrafficRange = 'week';

/** 非法值 → 默认范围（按钮/本地存储里的脏值不该让看板空掉）。 */
export function normalizeTrafficRange(value: unknown): TrafficRange {
  return value === 'day' || value === 'week' || value === 'month' ? value : DEFAULT_TRAFFIC_RANGE;
}

export function trafficRangeSpec(range: TrafficRange): TrafficRangeSpec {
  return TRAFFIC_RANGE_SPECS[range];
}

/** 服务端返回的粒度 → 本模块的粒度（非法/缺省按「按天」处理，与后端默认范围一致）。 */
export function normalizeTrafficUnit(value: unknown): TrafficUnit {
  return value === 'hour' ? 'hour' : 'day';
}

/** 粒度 → 提示文案键（复用既有的「按天」/「按小时」）。 */
export function trafficUnitKey(unit: TrafficUnit): MessagesKey {
  return unit === 'hour' ? 'admin.hoursTitle' : 'admin.daysTitle';
}

// ==================== 桶标签的解析与格式化 ====================

const DAY_LABEL = /^(\d{4})-(\d{2})-(\d{2})$/;
const HOUR_LABEL = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):00$/;

/**
 * 桶标签 → 时间戳（**按 UTC 解析**）与粒度；非法标签返回 null。
 *
 * 为什么要解析：只为了两件事 —— 排序、以及补桶时按粒度步进。
 * 刻意用 UTC 空间做算术（`Date.UTC` / `getUTC*`）：桶标签是服务端生成的**站点时区**
 * （北京时间，见 `functions/_lib/statsWindow.ts` 与 ADR 0008）的日历字符串，不含时区信息；
 * 用本地时区解析再格式化的话，跨夏令时的地区会多出/少掉一小时，排序也会跟着漂。
 * 这里只做"日历算术"，不改写标签含义 —— 展示用的标签始终是服务端给的那个字符串。
 */
export function parseBucketLabel(label: string): { at: number; unit: TrafficUnit } | null {
  const day = DAY_LABEL.exec(label);
  if (day) return { at: Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3])), unit: 'day' };
  const hour = HOUR_LABEL.exec(label);
  if (hour) return { at: Date.UTC(Number(hour[1]), Number(hour[2]) - 1, Number(hour[3]), Number(hour[4])), unit: 'hour' };
  return null;
}

/** 时间戳 + 粒度 → 桶标签（与 `parseBucketLabel` 互逆，同样是 UTC 空间）。 */
export function formatBucketLabel(at: number, unit: TrafficUnit): string {
  const d = new Date(at);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const date = `${y}-${mo}-${day}`;
  return unit === 'hour' ? `${date} ${String(d.getUTCHours()).padStart(2, '0')}:00` : date;
}

/** 补桶的步长（毫秒）。 */
export function bucketStepMs(unit: TrafficUnit): number {
  return unit === 'hour' ? 3_600_000 : 86_400_000;
}

/** 客户端补桶的数量上限：防御"服务端给了跨度荒谬的两行"时把页面卡死（31 天 × 24 小时）。 */
export const MAX_TRAFFIC_POINTS = 24 * 31;

/**
 * 服务端行 → 折线用的点序列：**去非法、升序、相邻缺桶补 0**。
 *
 * 服务端已经按窗口补满 0（`buildStatsPoints`），这一步是**防御性**的：
 *   1. 只补**服务端给的行之间**的空洞，**不**自行推导窗口边界 —— 浏览器时区与服务端
 *      `'localtime'` 未必一致（UTC vs UTC+8 差整整 8 个小时桶），自己推窗口会整条错位；
 *   2. 计数归一为非负整数，脏数据不至于在折线上形成尖刺或负值。
 */
export function normalizeTrafficPoints(rows: readonly { label?: unknown; count?: unknown }[]): TrafficPoint[] {
  const parsed: { at: number; unit: TrafficUnit; label: string; count: number }[] = [];
  for (const row of rows ?? []) {
    const label = typeof row?.label === 'string' ? row.label : '';
    const bucket = parseBucketLabel(label);
    if (!bucket) continue;
    const raw = row?.count;
    const count = typeof raw === 'number' && Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 0;
    parsed.push({ ...bucket, label, count });
  }
  parsed.sort((a, b) => a.at - b.at);

  const out: TrafficPoint[] = [];
  const seen = new Set<number>();
  for (const item of parsed) {
    if (seen.has(item.at)) continue; // 同桶重复时保留先出现的那条（升序后即最早的那条）
    seen.add(item.at);
    out.push({ label: item.label, count: item.count });
  }

  const filled: TrafficPoint[] = [];
  for (let i = 0; i < out.length; i++) {
    filled.push(out[i]);
    const next = out[i + 1];
    if (!next) break;
    const step = bucketStepMs(parseBucketLabel(out[i].label)!.unit);
    const at = parseBucketLabel(out[i].label)!.at;
    for (let cursor = at + step; cursor < parseBucketLabel(next.label)!.at; cursor += step) {
      if (filled.length >= MAX_TRAFFIC_POINTS) return filled;
      filled.push({ label: formatBucketLabel(cursor, step === 3_600_000 ? 'hour' : 'day'), count: 0 });
    }
  }
  return filled;
}

// ==================== 文案 ====================

/** 点标签 → 中文：按天 `9月16日`，按小时 `9月16日 14:00`。 */
export function formatPointLabel(unit: TrafficUnit, label: string): string {
  const parsed = parseBucketLabel(label);
  if (!parsed) return label;
  const d = new Date(parsed.at);
  const md = `${d.getUTCMonth() + 1}月${d.getUTCDate()}日`;
  return unit === 'hour' ? `${md} ${String(d.getUTCHours()).padStart(2, '0')}:00` : md;
}

/** 点标签 → x 轴刻度：按天 `9/16`，按小时 `14:00`（完整日期在 tooltip 里给）。 */
export function formatAxisLabel(unit: TrafficUnit, label: string): string {
  const parsed = parseBucketLabel(label);
  if (!parsed) return label;
  const d = new Date(parsed.at);
  if (unit === 'hour') return `${String(d.getUTCHours()).padStart(2, '0')}:00`;
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

/** tooltip 文案：按天 `9月16日 · 34 次访问`，按小时 `9月16日 14:00 · 12 次访问`。 */
export function formatTooltipText(unit: TrafficUnit, label: string, count: number): string {
  return t('admin.trafficTooltip', { label: formatPointLabel(unit, label), count });
}

/**
 * tooltip 文案的可替换口径：`(已格式化的点标签, 计数) => 文本`。
 *
 * 为什么把「访问量」这一步做成可注入：同一张折线图要同时服务两个看板 —— 日志记录的
 * 「访问量统计」和游玩统计的「游玩量统计」。两者的**图形完全一致**，只有 tooltip 的量词不同
 * （`次访问` / `次游玩`）。若为此复制一份 option 构造，两边的桶解析/补 0/整齐上界就会各自演化，
 * 迟早出现"图上点数一样但 tooltip 说错"的静默不一致。
 */
export type TooltipTextFn = (label: string, count: number) => string;

/** 默认口径：访问量（`admin.trafficTooltip`）。 */
export const defaultTooltipText: TooltipTextFn = (label, count) => t('admin.trafficTooltip', { label, count });

// ==================== 数值 ====================

/** 合计访问量。 */
export function totalTraffic(points: readonly TrafficPoint[]): number {
  return points.reduce((sum, p) => sum + p.count, 0);
}

/** 峰值（y 轴与"空态"判定都用得到）。 */
export function peakTraffic(points: readonly TrafficPoint[]): number {
  return points.reduce((max, p) => Math.max(max, p.count), 0);
}

/** 整段窗口内一次访问都没有 → 面板显示空态文案。 */
export function isEmptyTraffic(points: readonly TrafficPoint[]): boolean {
  return totalTraffic(points) === 0;
}

/**
 * y 轴上限的"整齐"化：1 / 2 / 5 × 10ⁿ 的最近上界（全 0 时给 1）。
 *
 * 为什么不让 ECharts 自己算：默认刻度会随每个范围的数据抖动（近七天 3 次 → 轴顶 3，
 * 切到近一月 120 次 → 轴顶 120），同一个数字在不同范围下的视觉高度不一致。取整齐上界后
 * 刻度线也是整数（配合 `minInterval: 1`）。
 */
export function niceMax(max: number): number {
  if (!Number.isFinite(max) || max <= 0) return 1;
  const exponent = Math.floor(Math.log10(max));
  const base = 10 ** exponent;
  const normalized = max / base;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * base;
}

// ==================== 配色 ====================

export interface TrafficPalette {
  line: string;
  areaTop: string;
  areaBottom: string;
  markerBorder: string;
  axis: string;
  split: string;
  tooltipBg: string;
  tooltipText: string;
  tooltipBorder: string;
}

/** 读 CSS 变量（调用方传 `getComputedStyle(el).getPropertyValue`）；取不到返回空串/空值。 */
export type CssVarReader = (name: string) => string;

/** `#rgb` / `#rrggbb` → `rgba(r,g,b,alpha)`；其它写法（`rgb()`、变量名）原样返回。 */
export function withAlpha(color: string, alpha: number): string {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!hex) return color;
  const raw = hex[1].length === 3 ? hex[1].split('').map((c) => c + c).join('') : hex[1];
  const n = parseInt(raw, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/**
 * 折线配色：**只用项目既有色**，不新造一套 ——
 * 品牌绿取 CSS 变量 `--accent`（随 `body.theme-dark` 自动切换），轴线取 `--muted`、
 * 网格线取 `--panel-border`、标记点描边取 `--panel-bg`；tooltip 三色直接取 `MAP_THEMES`
 * 的既有令牌（浅色主题白底深字、暗色主题深底浅字），故暗色模式不需要另写一份颜色表。
 */
export function trafficPalette(dark: boolean, readVar: CssVarReader): TrafficPalette {
  const theme = MAP_THEMES[dark ? 'dark' : 'light'];
  const varOf = (name: string) => {
    try {
      return (readVar(name) ?? '').trim();
    } catch {
      return '';
    }
  };
  const accent = varOf('--accent') || theme.fill.green;
  const axis = varOf('--muted') || theme.labelNeutral;
  const split = varOf('--panel-border') || theme.boundary.light;
  const panel = varOf('--panel-bg') || theme.labelBg;
  return {
    line: accent,
    areaTop: withAlpha(accent, 0.3),
    areaBottom: withAlpha(accent, 0.02),
    markerBorder: panel,
    axis,
    split,
    tooltipBg: theme.tooltipBg,
    tooltipText: theme.tooltipText,
    tooltipBorder: theme.tooltipBorder,
  };
}

// ==================== ECharts option ====================

export interface TrafficOptionInput {
  points: readonly TrafficPoint[];
  unit: TrafficUnit;
  palette: TrafficPalette;
  /**
   * tooltip 文案口径；缺省为访问量（`admin.trafficTooltip`）。
   * 游玩统计传 `admin.playTooltip` 口径（见 `TooltipTextFn` 的说明）。
   */
  tooltipText?: TooltipTextFn;
}

/**
 * tooltip：鼠标悬停在标记点（或该点的 x 位置）时给出**那一桶**的访问量文案。
 * `trigger: 'axis'` 让"挪到附近"也能命中，标记点本身画得清楚（见下面的 symbol）。
 */
export function trafficTooltipOption(input: TrafficOptionInput): echarts.EChartsOption['tooltip'] {
  const { points, unit, palette } = input;
  const text = input.tooltipText ?? defaultTooltipText;
  return {
    trigger: 'axis',
    // 挂到 body：面板容器本身可滚动，默认挂在容器里会被裁掉
    appendToBody: true,
    backgroundColor: palette.tooltipBg,
    borderColor: palette.tooltipBorder,
    textStyle: { color: palette.tooltipText, fontSize: 12 },
    axisPointer: { type: 'line', lineStyle: { color: palette.split } },
    formatter: (params: unknown) => {
      const list = Array.isArray(params) ? (params as { dataIndex?: number }[]) : [params as { dataIndex?: number }];
      const index = typeof list[0]?.dataIndex === 'number' ? list[0].dataIndex : -1;
      const point = index >= 0 ? points[index] : undefined;
      // 传出去的 label 是**格式化后**的点标签（`9月16日`）：调用方拿到的就是最终要显示的那一段，
      // 不必再知道粒度怎么拼 —— 这也是把格式化留在本模块的理由。
      return point ? text(formatPointLabel(unit, point.label), point.count) : '';
    },
  };
}

/** x 轴：类目轴，刻度按粒度给短标签（按天 `9/16`、按小时 `14:00`），标签自动抽稀防重叠。 */
function trafficXAxisOption(input: TrafficOptionInput): echarts.EChartsOption['xAxis'] {
  const { points, unit, palette } = input;
  return {
    type: 'category',
    data: points.map((p) => formatAxisLabel(unit, p.label)),
    boundaryGap: false,
    axisTick: { show: false },
    axisLine: { lineStyle: { color: palette.split } },
    axisLabel: { color: palette.axis, fontSize: 11, interval: 'auto', hideOverlap: true },
  };
}

/** y 轴：从 0 起、整数刻度、上限取整齐上界（见 `niceMax` 的说明）。 */
function trafficYAxisOption(input: TrafficOptionInput): echarts.EChartsOption['yAxis'] {
  const { palette } = input;
  return {
    type: 'value',
    min: 0,
    minInterval: 1, // 访问量是整数：不出现 0.5 这种刻度
    max: (value: { min: number; max: number }) => niceMax(value.max),
    axisLine: { show: false },
    axisTick: { show: false },
    axisLabel: { color: palette.axis, fontSize: 11 },
    splitLine: { lineStyle: { color: palette.split, type: 'dashed' } },
  };
}

/** 折线本身：带标记点（"鼠标挪到标记点"的前提）与向下的面积渐变。 */
function trafficLineSeries(input: TrafficOptionInput): echarts.EChartsOption['series'] {
  const { points, palette } = input;
  return [
    {
      type: 'line',
      name: t('admin.statsTitle'),
      data: points.map((p) => p.count),
      smooth: true,
      symbol: 'circle',
      symbolSize: 6,
      showSymbol: true,
      lineStyle: { width: 2, color: palette.line },
      itemStyle: { color: palette.line, borderColor: palette.markerBorder, borderWidth: 1 },
      areaStyle: {
        color: {
          type: 'linear',
          x: 0,
          y: 0,
          x2: 0,
          y2: 1,
          global: false,
          colorStops: [
            { offset: 0, color: palette.areaTop },
            { offset: 1, color: palette.areaBottom },
          ],
        },
      },
      emphasis: { scale: 1.8 },
    },
  ];
}

/**
 * 折线图 option。**只吃数据与配色**，不读实例、不读 DOM —— 因此可以对着 option 断言
 * （`trafficSeries.test.ts` 直接调 tooltip 的 formatter 与 x 轴的 data）。
 *
 * `animation: false`：与地图渲染器一致 —— 流量看板是"看一眼就走"的只读图表，
 * 关掉动画还能让验收脚本的像素/交互断言不受过渡帧影响。
 */
export function buildTrafficOption(input: TrafficOptionInput): echarts.EChartsOption {
  return {
    animation: false,
    grid: { left: 46, right: 16, top: 16, bottom: 26 },
    tooltip: trafficTooltipOption(input),
    xAxis: trafficXAxisOption(input),
    yAxis: trafficYAxisOption(input),
    series: trafficLineSeries(input),
  };
}
