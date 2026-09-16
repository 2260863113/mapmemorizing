import { describe, it, expect } from 'vitest';
import {
  buildStatsPoints,
  DEFAULT_STATS_RANGE,
  normalizeStatsRange,
  SITE_TZ_OFFSET_MINUTES,
  SITE_TZ_OFFSET_SECONDS,
  siteDayLabel,
  siteHourLabel,
  STATS_RANGE_SPECS,
  statsWindow,
} from './statsWindow';

/**
 * 流量看板的窗口与分桶。
 *
 * 为什么必须测：这些是本轮唯一「错了也看不出来」的地方 —— GROUP BY 只返回有记录的桶，
 * 补 0 与窗口边界一旦写错，折线整体偏移一格，图上照样"有数据"。
 *
 * **时区无关性（本轮修的那处缺陷）**：用例一律用 `site(...)` 构造瞬时 —— 它把"北京时间的
 * 某个日历时刻"换算成绝对瞬时，断言也用北京时间的日历字符串。因此：
 *   · 换时区跑（CI 常为 UTC、本机为 +08）结果不变；
 *   · 若实现退化成用宿主时区的 `getFullYear()/getHours()`，在 +08 的机器上会整体偏 8 小时，
 *     `跨日` 与 `跨小时` 两组用例立刻红 —— 这正是 `'localtime'` 那版真出过的错。
 */

/** 北京时间的某个时刻 → 绝对瞬时（毫秒）。 */
const site = (y: number, mo: number, d: number, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi, 0, 0) - SITE_TZ_OFFSET_MINUTES * 60_000;

describe('STATS_RANGE_SPECS / normalizeStatsRange', () => {
  it('三个范围的粒度与桶数：近一天 24 点按小时、近七天 7 点按天、近一月 30 点按天', () => {
    expect(STATS_RANGE_SPECS.day).toEqual({ unit: 'hour', points: 24 });
    expect(STATS_RANGE_SPECS.week).toEqual({ unit: 'day', points: 7 });
    expect(STATS_RANGE_SPECS.month).toEqual({ unit: 'day', points: 30 });
  });

  it('非法值一律回落到默认范围（不报错、不 500）', () => {
    expect(normalizeStatsRange('day')).toBe('day');
    expect(normalizeStatsRange('week')).toBe('week');
    expect(normalizeStatsRange('month')).toBe('month');
    for (const bad of [null, undefined, '', 'DAY', 'Day', 'year', '2', 7, {}, []]) {
      expect(normalizeStatsRange(bad)).toBe(DEFAULT_STATS_RANGE);
    }
    expect(DEFAULT_STATS_RANGE).toBe('week');
  });
});

describe('站点时区偏移', () => {
  it('站点时区是北京时间 UTC+8，且秒/分两种表达一致（SQL 直接绑秒）', () => {
    expect(SITE_TZ_OFFSET_MINUTES).toBe(480);
    expect(SITE_TZ_OFFSET_SECONDS).toBe(SITE_TZ_OFFSET_MINUTES * 60);
  });

  it('标签用偏移后的 UTC 字段渲染：UTC 16:30 在北京时间已是次日 00:30', () => {
    const utc1630 = Date.UTC(2026, 8, 16, 16, 30);
    expect(siteHourLabel(utc1630)).toBe('2026-09-17 00:00');
    expect(siteDayLabel(utc1630)).toBe('2026-09-17');
    // 与 SQLite 用同一个变换：`strftime(..., created_at/1000 + 28800, 'unixepoch')`
    expect(siteHourLabel(utc1630)).toBe(new Date(utc1630 + SITE_TZ_OFFSET_SECONDS * 1000).toISOString().slice(0, 10) + ' 00:00');
  });
});

describe('statsWindow · 按天', () => {
  it('近七天的桶 = 今天 + 之前 6 天，升序，最后一项是今天', () => {
    const now = site(2026, 1, 15, 23, 30);
    const { labels, start } = statsWindow('day', 7, now);
    expect(labels).toEqual(['2026-01-09', '2026-01-10', '2026-01-11', '2026-01-12', '2026-01-13', '2026-01-14', '2026-01-15']);
    // 窗口起点 = 最早那天在北京时间的 0 点（SQL 过滤用），不是 now - 7×24h
    expect(start).toBe(site(2026, 1, 9));
  });

  it('近一个月 30 个桶，跨月正确', () => {
    const { labels } = statsWindow('day', 30, site(2026, 3, 1, 9, 5));
    expect(labels).toHaveLength(30);
    expect(labels[0]).toBe('2026-01-31'); // 2026 年 2 月 28 天
    expect(labels[29]).toBe('2026-03-01');
  });

  it('按天的窗口起点是当天 0 点，与「现在几点」无关', () => {
    expect(statsWindow('day', 1, site(2026, 1, 15, 0, 0)).start).toBe(site(2026, 1, 15));
    expect(statsWindow('day', 1, site(2026, 1, 15, 23, 59)).start).toBe(site(2026, 1, 15));
  });

  it('跨日按**北京时间**切：UTC 15:59 还是 16 日，UTC 16:01 已是 17 日', () => {
    expect(statsWindow('day', 1, Date.UTC(2026, 8, 16, 15, 59)).labels).toEqual(['2026-09-16']);
    expect(statsWindow('day', 1, Date.UTC(2026, 8, 16, 16, 1)).labels).toEqual(['2026-09-17']);
  });
});

describe('statsWindow · 按小时', () => {
  it('近一天的桶 = 当前整点 + 之前 23 小时，升序，最后一项是当前整点', () => {
    const now = site(2026, 1, 15, 23, 30);
    const { labels, start } = statsWindow('hour', 24, now);
    expect(labels).toHaveLength(24);
    expect(labels[0]).toBe('2026-01-15 00:00');
    expect(labels[23]).toBe('2026-01-15 23:00');
    expect(start).toBe(site(2026, 1, 15, 0, 0));
    // 分桶必须整点、且逐小时连续
    for (const label of labels) expect(label).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:00$/);
  });

  it('跨天：以 00:20 为基准时，最早的那个桶落在前一天', () => {
    const { labels } = statsWindow('hour', 24, site(2026, 1, 15, 0, 20));
    expect(labels[0]).toBe('2026-01-14 01:00');
    expect(labels[23]).toBe('2026-01-15 00:00');
  });

  it('小时桶按北京时间整点对齐（UTC 16:30 落在北京 00:00 这一桶）', () => {
    const { labels, start } = statsWindow('hour', 3, Date.UTC(2026, 8, 16, 16, 30));
    expect(labels).toEqual(['2026-09-16 22:00', '2026-09-16 23:00', '2026-09-17 00:00']);
    expect(start).toBe(site(2026, 9, 16, 22));
  });

  it('窗口起点是"第一个桶的绝对起点"，即标签对应时刻减 8 小时', () => {
    const now = site(2026, 9, 16, 14, 37);
    const { labels, start } = statsWindow('hour', 24, now);
    expect(labels[23]).toBe('2026-09-16 14:00');
    expect(start).toBe(site(2026, 9, 15, 15));
  });
});

describe('buildStatsPoints · 缺桶补 0', () => {
  const labels = ['2026-01-13', '2026-01-14', '2026-01-15'];

  it('SQL 只给有记录的桶时，缺的桶补 0，且顺序与窗口一致', () => {
    const points = buildStatsPoints(labels, [{ label: '2026-01-15', count: 34 }]);
    expect(points).toEqual([
      { label: '2026-01-13', count: 0 },
      { label: '2026-01-14', count: 0 },
      { label: '2026-01-15', count: 34 },
    ]);
  });

  it('窗口外的行被丢弃（不能把窗口外的记录画进窗口里）', () => {
    const points = buildStatsPoints(labels, [
      { label: '2025-12-31', count: 999 },
      { label: '2026-01-14', count: 5 },
    ]);
    expect(points.map((p) => p.count)).toEqual([0, 5, 0]);
  });

  it('计数被归一为非负整数（脏数据不产生折线上的尖刺或负值）', () => {
    const points = buildStatsPoints(labels, [
      { label: '2026-01-13', count: -3 },
      { label: '2026-01-14', count: 2.7 },
      { label: '2026-01-15', count: Number.NaN },
    ]);
    expect(points.map((p) => p.count)).toEqual([0, 2, 0]);
  });

  it('空结果 = 全 0 的完整序列（前端因此永远能画出等距的 x 轴）', () => {
    const points = buildStatsPoints(labels, []);
    expect(points).toEqual([
      { label: '2026-01-13', count: 0 },
      { label: '2026-01-14', count: 0 },
      { label: '2026-01-15', count: 0 },
    ]);
  });

  it('窗口标签为空时不凭空造点', () => {
    expect(buildStatsPoints([], [{ label: '2026-01-15', count: 3 }])).toEqual([]);
  });
});
