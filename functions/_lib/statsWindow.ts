/**
 * 管理端「流量看板」的时间窗口与分桶（**纯函数**：不碰 DB、不碰请求对象，可单测）。
 *
 * 为什么抽出来：这是本轮唯一"错了也看不出来"的地方 —— SQL 的 `GROUP BY` 只返回**有记录的**
 * 桶，缺的那些小时/天必须补 0；而窗口边界（今天 0 点 / 当前整点）一旦算错，整条折线会整体
 * 偏移一格，图上看着仍然"有数据"。故把「窗口 → 标签序列」与「SQL 行 → 连续序列」两段
 * 都做成纯函数并单测。
 *
 * 与前端 `src/ui/trafficSeries.ts` 是**同一口径的两半**（`src/` 与 `functions/` 是两套
 * tsconfig，跨目录 import 会把前端代码打进 Worker，故各写一份、由两侧的注释互指）。
 *
 * ⚠ **时区（2026-09 修正的一处真实缺陷）**：桶标签与 SQL 分桶必须用**同一个显式时区**，
 * 绝不能各自依赖"环境时区"：
 *   · SQLite 的 `'localtime'` 在 D1 里按 **UTC** 解析（实测 `'localtime'` 与 `'utc'` 的分桶
 *     逐桶相同），因为 D1 没有 tzdata、只认固定偏移；
 *   · 而 Worker 的 `Date` 在本地 `wrangler pages dev` 下跟着**宿主时区**（本机 +08）。
 *   两者相差整整 8 个小时桶：标签写 14:00、计数却来自 UTC 14:00（= 北京时间 22:00），
 *   折线整条错位却"看着有数据"。故这里钉死**站点时区 = 北京时间（UTC+8）**：
 *   SQL 侧把 epoch 秒加 `SITE_TZ_OFFSET_SECONDS` 再用 `'unixepoch'` 渲染，
 *   JS 侧把瞬时加同样偏移后用 `getUTC*` 渲染 —— 两边是同一个变换，与宿主/D1 时区无关。
 *   站点是面向中文用户的 mapmemory.cn，看板只有站长看，北京时间就是他要的口径。
 */

/** 流量看板的时间范围。 */
export type StatsRange = 'day' | 'week' | 'month';
/** 统计粒度：`hour` = 按小时（近一天），`day` = 按天（近七天 / 近一个月）。 */
export type StatsUnit = 'hour' | 'day';

/**
 * 站点时区偏移（分钟，东为正）= 北京时间 UTC+8。
 * 改这一个数就同时改掉 JS 标签与 SQL 分桶（后者由 `SITE_TZ_OFFSET_SECONDS` 绑定进 SQL）。
 */
export const SITE_TZ_OFFSET_MINUTES = 480;
/** 同一个偏移的"秒"表达：SQL 里直接加在 `created_at / 1000` 上（SQLite 没有 tzdata）。 */
export const SITE_TZ_OFFSET_SECONDS = SITE_TZ_OFFSET_MINUTES * 60;
const SITE_TZ_OFFSET_MS = SITE_TZ_OFFSET_MINUTES * 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** 范围 → 粒度与桶数（与前端 `TRAFFIC_RANGE_SPECS` 逐字对应）。 */
export const STATS_RANGE_SPECS: Record<StatsRange, { unit: StatsUnit; points: number }> = {
  day: { unit: 'hour', points: 24 }, // 近一天：当前小时 + 之前 23 小时
  week: { unit: 'day', points: 7 }, // 近七天：今天 + 之前 6 天
  month: { unit: 'day', points: 30 }, // 近一个月：今天 + 之前 29 天
};

/** 缺省范围：稳定值（非法 range 一律回落到它，而不是报错）。 */
export const DEFAULT_STATS_RANGE: StatsRange = 'week';

/** 非法/缺省 → 默认范围；绝不为非法参数返回 4xx/500（参数可能被手工篡改或过期）。 */
export function normalizeStatsRange(value: unknown): StatsRange {
  return value === 'day' || value === 'week' || value === 'month' ? value : DEFAULT_STATS_RANGE;
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/** 把"站点空间"的毫秒（= 瞬时 + 偏移）渲染成 `YYYY-MM-DD`。用 `getUTC*` 读，故与宿主时区无关。 */
export function siteDayLabel(timeMs: number): string {
  const d = new Date(timeMs + SITE_TZ_OFFSET_MS);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** 把"站点空间"的毫秒渲染成 `YYYY-MM-DD HH:00`（与 SQL 的 `strftime('%Y-%m-%d %H:00', ...)` 同形）。 */
export function siteHourLabel(timeMs: number): string {
  const d = new Date(timeMs + SITE_TZ_OFFSET_MS);
  return `${siteDayLabel(timeMs)} ${pad2(d.getUTCHours())}:00`;
}

/**
 * 统计窗口的**桶标签（升序，最后一项 = 当前小时 / 今天）**与窗口起点（毫秒，绝对瞬时）。
 *
 * 标签只在服务端生成（见文件头：前端自己推窗口会与服务端时区错开），前端只做展示与
 * （防御性的）补桶。`start` 是**第一个桶的绝对起点**，直接绑进 SQL 的 `created_at >= ?`。
 */
export function statsWindow(unit: StatsUnit, points: number, now: number): { labels: string[]; start: number } {
  const labels: string[] = [];
  if (unit === 'hour') {
    // 站点空间里按整点对齐，再换回绝对瞬时
    const siteSlot = Math.floor((now + SITE_TZ_OFFSET_MS) / HOUR_MS) * HOUR_MS;
    const start = siteSlot - SITE_TZ_OFFSET_MS - (points - 1) * HOUR_MS;
    for (let i = 0; i < points; i++) labels.push(siteHourLabel(start + i * HOUR_MS));
    return { labels, start };
  }
  // 按天：在站点空间里对齐到当日 0 点，再逐日步进（UTC 空间没有夏令时，日历日恒为 24h）
  const siteDayStart = Math.floor((now + SITE_TZ_OFFSET_MS) / DAY_MS) * DAY_MS;
  const start = siteDayStart - SITE_TZ_OFFSET_MS - (points - 1) * DAY_MS;
  for (let i = 0; i < points; i++) labels.push(siteDayLabel(start + i * DAY_MS));
  return { labels, start };
}

/** SQL 分桶行（`label` 为 stftime 出来的桶标签，`count` 为该桶记录数）。 */
export interface StatsBucketRow {
  label: string;
  count: number;
}

/**
 * SQL 行 → **连续**的时间序列：以窗口标签为准逐个取值，缺桶补 0，窗口外的行丢弃。
 *
 * 注意是「以窗口为准」而不是「以 SQL 结果为准」：SQL 只有有记录的桶，直接返回会画出一条
 * 时间不等距的折线（把 3 天前的记录画在昨天的位置上）。
 */
export function buildStatsPoints(labels: readonly string[], rows: readonly StatsBucketRow[]): { label: string; count: number }[] {
  const byLabel = new Map<string, number>();
  for (const row of rows) {
    if (!row || typeof row.label !== 'string') continue;
    const count = typeof row.count === 'number' && Number.isFinite(row.count) ? Math.max(0, Math.floor(row.count)) : 0;
    byLabel.set(row.label, count);
  }
  return labels.map((label) => ({ label, count: byLabel.get(label) ?? 0 }));
}
