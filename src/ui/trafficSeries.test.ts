import { describe, it, expect } from 'vitest';
import { MAP_THEMES } from '../map/theme';
import {
  buildTrafficOption,
  bucketStepMs,
  DEFAULT_TRAFFIC_RANGE,
  formatAxisLabel,
  formatBucketLabel,
  formatPointLabel,
  formatTooltipText,
  isEmptyTraffic,
  MAX_TRAFFIC_POINTS,
  niceMax,
  normalizeTrafficPoints,
  normalizeTrafficRange,
  normalizeTrafficUnit,
  parseBucketLabel,
  peakTraffic,
  totalTraffic,
  trafficPalette,
  trafficRangeSpec,
  trafficUnitKey,
  TRAFFIC_RANGES,
  TRAFFIC_RANGE_SPECS,
  withAlpha,
  type TrafficPoint,
} from './trafficSeries';

/**
 * 流量看板的纯逻辑。
 *
 * 为什么必须测：这些都是「错了也看不出来」的换算 —— 桶顺序/补桶错一格，折线整体偏移
 * 但图上照样"有数据"；tooltip 文案拿错粒度，只有把鼠标挪上去才发现。ECharts 实例与 DOM
 * 都不参与，故可以对着 option 与文案直接断言。
 */

const palette = trafficPalette(false, () => '');
const noVar = () => '';

describe('范围 → 粒度 / 桶数', () => {
  it('三个范围：近一天按小时 24 点，近七天 / 近一月按天 7 / 30 点', () => {
    expect(trafficRangeSpec('day')).toMatchObject({ unit: 'hour', points: 24 });
    expect(trafficRangeSpec('week')).toMatchObject({ unit: 'day', points: 7 });
    expect(trafficRangeSpec('month')).toMatchObject({ unit: 'day', points: 30 });
    expect(TRAFFIC_RANGES).toEqual(['day', 'week', 'month']);
  });

  it('按钮文案键与后端统计口径互指（三个范围都有自己的文案）', () => {
    const keys = TRAFFIC_RANGES.map((r) => TRAFFIC_RANGE_SPECS[r].labelKey);
    expect(new Set(keys).size).toBe(3);
  });

  it('非法范围回落到默认值（按钮/本地脏值不该让看板空掉）', () => {
    expect(DEFAULT_TRAFFIC_RANGE).toBe('week');
    for (const bad of [null, undefined, '', 'DAY', 'year', 0, {}]) {
      expect(normalizeTrafficRange(bad)).toBe(DEFAULT_TRAFFIC_RANGE);
    }
    expect(normalizeTrafficRange('month')).toBe('month');
  });

  it('服务端粒度归一：只有 hour 是 hour，其余按天', () => {
    expect(normalizeTrafficUnit('hour')).toBe('hour');
    expect(normalizeTrafficUnit('day')).toBe('day');
    expect(normalizeTrafficUnit('HOUR')).toBe('day');
    expect(normalizeTrafficUnit(undefined)).toBe('day');
    expect(trafficUnitKey('hour')).toBe('admin.hoursTitle');
    expect(trafficUnitKey('day')).toBe('admin.daysTitle');
  });
});

describe('桶标签解析 / 格式化', () => {
  it('按天标签：格式互逆，排序键递增', () => {
    const a = parseBucketLabel('2026-09-16');
    const b = parseBucketLabel('2026-09-17');
    expect(a?.unit).toBe('day');
    expect(b!.at - a!.at).toBe(86_400_000);
    expect(formatBucketLabel(a!.at, 'day')).toBe('2026-09-16');
  });

  it('按小时标签：格式互逆，步长为 1 小时', () => {
    const a = parseBucketLabel('2026-09-16 14:00');
    const b = parseBucketLabel('2026-09-16 15:00');
    expect(a?.unit).toBe('hour');
    expect(b!.at - a!.at).toBe(3_600_000);
    expect(formatBucketLabel(a!.at, 'hour')).toBe('2026-09-16 14:00');
  });

  it('非本格式的标签一律 null（脏数据不进折线）', () => {
    for (const bad of ['', '2026-9-16', '2026-09-16 14', '2026/09/16', 'yesterday', '2026-09-16 14:30']) {
      expect(parseBucketLabel(bad)).toBeNull();
    }
  });

  it('步长常量与粒度一致', () => {
    expect(bucketStepMs('hour')).toBe(3_600_000);
    expect(bucketStepMs('day')).toBe(86_400_000);
  });
});

describe('normalizeTrafficPoints · 防御性补桶', () => {
  it('乱序输入 → 升序输出', () => {
    const points = normalizeTrafficPoints([
      { label: '2026-09-16', count: 3 },
      { label: '2026-09-14', count: 1 },
      { label: '2026-09-15', count: 2 },
    ]);
    expect(points.map((p) => p.label)).toEqual(['2026-09-14', '2026-09-15', '2026-09-16']);
    expect(points.map((p) => p.count)).toEqual([1, 2, 3]);
  });

  it('服务端漏桶时按天补 0（缺的那天不会把后一天顶到前一天的 x 位置）', () => {
    const points = normalizeTrafficPoints([
      { label: '2026-09-14', count: 5 },
      { label: '2026-09-17', count: 9 },
    ]);
    expect(points.map((p) => p.label)).toEqual(['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17']);
    expect(points.map((p) => p.count)).toEqual([5, 0, 0, 9]);
  });

  it('按小时同理：跨天补桶的标签仍然是整点', () => {
    const points = normalizeTrafficPoints([
      { label: '2026-09-16 22:00', count: 1 },
      { label: '2026-09-17 01:00', count: 4 },
    ]);
    expect(points.map((p) => p.label)).toEqual([
      '2026-09-16 22:00',
      '2026-09-16 23:00',
      '2026-09-17 00:00',
      '2026-09-17 01:00',
    ]);
  });

  it('非法标签被丢弃、计数被归一为非负整数', () => {
    const points = normalizeTrafficPoints([
      { label: '2026-09-16', count: -2 },
      { label: '不是标签', count: 99 },
      { label: '2026-09-17', count: 2.9 },
      { label: '2026-09-18', count: Number.POSITIVE_INFINITY },
    ]);
    expect(points.map((p) => p.label)).toEqual(['2026-09-16', '2026-09-17', '2026-09-18']);
    expect(points.map((p) => p.count)).toEqual([0, 2, 0]);
  });

  it('同一桶重复出现只保留一条', () => {
    const points = normalizeTrafficPoints([
      { label: '2026-09-16', count: 1 },
      { label: '2026-09-16', count: 7 },
    ]);
    expect(points).toEqual([{ label: '2026-09-16', count: 1 }]);
  });

  it('空输入 / 非数组输入不抛错', () => {
    expect(normalizeTrafficPoints([])).toEqual([]);
    expect(normalizeTrafficPoints(null as unknown as [])).toEqual([]);
  });

  it('补桶数量有上限（跨度过大的两行不会把页面卡死）', () => {
    const points = normalizeTrafficPoints([
      { label: '2026-09-16 00:00', count: 1 },
      { label: '2030-09-16 00:00', count: 2 },
    ]);
    expect(points.length).toBe(MAX_TRAFFIC_POINTS);
  });
});

describe('文案', () => {
  it('按天 / 按小时的点标签', () => {
    expect(formatPointLabel('day', '2026-09-16')).toBe('9月16日');
    expect(formatPointLabel('hour', '2026-09-16 14:00')).toBe('9月16日 14:00');
    expect(formatPointLabel('hour', '2026-09-16 09:00')).toBe('9月16日 09:00'); // 补零
  });

  it('x 轴刻度：按天 9/16、按小时 14:00', () => {
    expect(formatAxisLabel('day', '2026-09-16')).toBe('9/16');
    expect(formatAxisLabel('hour', '2026-09-16 14:00')).toBe('14:00');
    expect(formatAxisLabel('day', '2026-12-01')).toBe('12/1');
  });

  it('tooltip 文案区分粒度（本轮需求原话的两个样例）', () => {
    expect(formatTooltipText('day', '2026-09-16', 34)).toBe('9月16日 · 34 次访问');
    expect(formatTooltipText('hour', '2026-09-16 14:00', 12)).toBe('9月16日 14:00 · 12 次访问');
    expect(formatTooltipText('day', '2026-09-16', 0)).toBe('9月16日 · 0 次访问');
  });

  it('非法标签原样带出（不显示成 undefined）', () => {
    expect(formatPointLabel('day', 'deprecated')).toBe('deprecated');
    expect(formatAxisLabel('day', 'deprecated')).toBe('deprecated');
  });
});

describe('数值', () => {
  it('合计 / 峰值 / 空态', () => {
    const points: TrafficPoint[] = [
      { label: '2026-09-15', count: 2 },
      { label: '2026-09-16', count: 5 },
    ];
    expect(totalTraffic(points)).toBe(7);
    expect(peakTraffic(points)).toBe(5);
    expect(isEmptyTraffic(points)).toBe(false);
    expect(isEmptyTraffic([{ label: '2026-09-16', count: 0 }])).toBe(true);
    expect(isEmptyTraffic([])).toBe(true);
  });

  it('y 轴上限取 1/2/5×10ⁿ 的整齐上界（全 0 时给 1）', () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(-3)).toBe(1);
    expect(niceMax(1)).toBe(1);
    expect(niceMax(1.5)).toBe(2);
    expect(niceMax(3)).toBe(5);
    expect(niceMax(7)).toBe(10);
    expect(niceMax(12)).toBe(20);
    expect(niceMax(120)).toBe(200);
    expect(niceMax(100)).toBe(100);
    expect(niceMax(Number.NaN)).toBe(1);
  });
});

describe('配色', () => {
  it('优先取 CSS 变量（跟随暗色模式），缺项回落到 MAP_THEMES 的既有令牌', () => {
    const withVars = trafficPalette(false, (name) =>
      name === '--accent' ? '#10b981' : name === '--muted' ? '#6b7280' : name === '--panel-border' ? '#e5e7eb' : name === '--panel-bg' ? '#ffffff' : '',
    );
    expect(withVars.line).toBe('#10b981');
    expect(withVars.axis).toBe('#6b7280');
    expect(withVars.split).toBe('#e5e7eb');
    expect(withVars.markerBorder).toBe('#ffffff');
    // 取不到变量时回落到主题令牌（而不是硬编码一套新颜色）
    expect(trafficPalette(false, noVar).line).toBe(MAP_THEMES.light.fill.green);
    expect(trafficPalette(true, noVar).line).toBe(MAP_THEMES.dark.fill.green);
    expect(trafficPalette(true, noVar).axis).toBe(MAP_THEMES.dark.labelNeutral);
  });

  it('tooltip 三色取自 MAP_THEMES（暗色模式深底浅字，不需要另写一份颜色表）', () => {
    const light = trafficPalette(false, noVar);
    const dark = trafficPalette(true, noVar);
    expect(light.tooltipBg).toBe(MAP_THEMES.light.tooltipBg);
    expect(light.tooltipText).toBe(MAP_THEMES.light.tooltipText);
    expect(dark.tooltipBg).toBe(MAP_THEMES.dark.tooltipBg);
    expect(dark.tooltipText).toBe(MAP_THEMES.dark.tooltipText);
    expect(dark.tooltipBg).not.toBe(light.tooltipBg);
  });

  it('渐变用 rgba 派生（非 hex 输入原样返回，不至于画不出图）', () => {
    expect(withAlpha('#10b981', 0.3)).toBe('rgba(16, 185, 129, 0.3)');
    expect(withAlpha('#fff', 0.5)).toBe('rgba(255, 255, 255, 0.5)');
    expect(withAlpha('rgb(1,2,3)', 0.5)).toBe('rgb(1,2,3)');
  });

  it('读取 CSS 变量抛错时不炸（回落到主题令牌）', () => {
    const palette = trafficPalette(false, () => {
      throw new Error('blocked');
    });
    expect(palette.line).toBe(MAP_THEMES.light.fill.green);
  });
});

describe('buildTrafficOption', () => {
  const points: TrafficPoint[] = [
    { label: '2026-09-14', count: 3 },
    { label: '2026-09-15', count: 0 },
    { label: '2026-09-16', count: 34 },
  ];

  it('数据与 x 轴刻度按点序列一一对应（点数 = 桶数）', () => {
    const option = buildTrafficOption({ points, unit: 'day', palette });
    const xAxis = option.xAxis as { type: string; data: string[]; boundaryGap: boolean };
    const series = option.series as { type: string; data: number[]; symbol: string; showSymbol: boolean }[];
    expect(xAxis.type).toBe('category');
    expect(xAxis.boundaryGap).toBe(false);
    expect(xAxis.data).toEqual(['9/14', '9/15', '9/16']);
    expect(series).toHaveLength(1);
    expect(series[0].type).toBe('line');
    expect(series[0].data).toEqual([3, 0, 34]);
    // 标记点必须画出来（"鼠标挪到标记点显示访问量"的前提）
    expect(series[0].symbol).toBe('circle');
    expect(series[0].showSymbol).toBe(true);
  });

  it('按小时的 x 轴刻度是整点', () => {
    const option = buildTrafficOption({
      points: [
        { label: '2026-09-16 13:00', count: 1 },
        { label: '2026-09-16 14:00', count: 2 },
      ],
      unit: 'hour',
      palette,
    });
    expect((option.xAxis as { data: string[] }).data).toEqual(['13:00', '14:00']);
  });

  it('tooltip：鼠标悬停时给出该桶的「日期 · N 次访问」（按天与按小时分别验）', () => {
    const formatterOf = (unit: 'day' | 'hour', pts: TrafficPoint[]) => {
      const option = buildTrafficOption({ points: pts, unit, palette });
      const tooltip = option.tooltip as { trigger: string; formatter: (params: unknown) => string };
      expect(tooltip.trigger).toBe('axis');
      return tooltip.formatter;
    };
    const dayFormatter = formatterOf('day', points);
    expect(dayFormatter([{ dataIndex: 2 }])).toBe('9月16日 · 34 次访问');
    expect(dayFormatter([{ dataIndex: 1 }])).toBe('9月15日 · 0 次访问');

    const hourFormatter = formatterOf('hour', [
      { label: '2026-09-16 13:00', count: 5 },
      { label: '2026-09-16 14:00', count: 12 },
    ]);
    expect(hourFormatter([{ dataIndex: 1 }])).toBe('9月16日 14:00 · 12 次访问');
    // 越界索引不产出文案（ECharts 在数据刷新瞬间可能给出旧索引）
    expect(dayFormatter([{ dataIndex: 99 }])).toBe('');
    expect(dayFormatter(undefined)).toBe('');
  });

  it('y 轴：从 0 起、整数刻度、上限取整齐上界', () => {
    const option = buildTrafficOption({ points, unit: 'day', palette });
    const yAxis = option.yAxis as { min: number; minInterval: number; max: (v: { min: number; max: number }) => number };
    expect(yAxis.min).toBe(0);
    expect(yAxis.minInterval).toBe(1);
    expect(yAxis.max({ min: 0, max: 34 })).toBe(50);
    expect(yAxis.max({ min: 0, max: 0 })).toBe(1);
  });

  it('关掉动画（只读图表：少一次过渡帧，验收脚本的像素/交互断言也更稳）', () => {
    expect(buildTrafficOption({ points, unit: 'day', palette }).animation).toBe(false);
  });

  it('空序列也能构造出合法 option（不与空态互斥：x 轴保留时间窗口）', () => {
    const option = buildTrafficOption({ points: [], unit: 'day', palette });
    expect((option.series as { data: number[] }[])[0].data).toEqual([]);
    expect((option.xAxis as { data: string[] }).data).toEqual([]);
  });
});
