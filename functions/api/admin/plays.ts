import { json, handle } from '../../_lib/http';
import { requireAdmin } from '../../_lib/guard';
import {
  buildStatsPoints,
  normalizeStatsRange,
  SITE_TZ_OFFSET_SECONDS,
  STATS_RANGE_SPECS,
  statsWindow,
  type StatsBucketRow,
  type StatsUnit,
} from '../../_lib/statsWindow';

interface PlayRow {
  id: number;
  username: string | null;
  mode: string;
  source: string;
  created_at: number;
}

const PAGE_SIZE = 50;

/**
 * 游玩统计的分桶 SQL。与 `admin/logs.ts` 的 `STAT_SQL` 同形（两条**常量**语句，不拼接格式串），
 * 只是表换成 `play_logs`、粒度与窗口仍由 `_lib/statsWindow.ts` 决定 —— 两侧口径必须一致，
 * 否则「访问」与「游玩」两张折线会在同一个时间轴上错开一小时/一天。
 *
 * ⚠ 桶标签不能用 SQLite 的 `'localtime'`（D1 没有 tzdata，一律按 UTC 解析），必须像访问统计那样
 * 用站点时区偏移：`created_at / 1000 + ?2` 再 `'unixepoch'`，`?2` 绑定 `SITE_TZ_OFFSET_SECONDS`。
 * 完整原因见 `_lib/statsWindow.ts` 文件头。
 */
const PLAY_STAT_SQL: Record<StatsUnit, string> = {
  hour: `SELECT strftime('%Y-%m-%d %H:00', created_at / 1000 + ?2, 'unixepoch') AS label, COUNT(*) AS count
         FROM play_logs
         WHERE created_at >= ?1
         GROUP BY label`,
  day: `SELECT strftime('%Y-%m-%d', created_at / 1000 + ?2, 'unixepoch') AS label, COUNT(*) AS count
        FROM play_logs
        WHERE created_at >= ?1
        GROUP BY label`,
};

/**
 * 管理员：游玩统计（`view=stats`：按范围内的粒度分桶、缺桶补 0 的连续序列）+ 游玩明细（分页）。
 *
 * 统计口径是**所有 play_logs 行**：点「开始」与 Tab 快速重置各记一条，故这里就是需求里的
 * 「点击开始的总次数（含 Tab 重置）」，不需要再按 source 过滤。
 */
export const onRequestGet = handle(
  requireAdmin(async (context) => {
    const env = context.env;
    const url = new URL(context.request.url);
    const view = url.searchParams.get('view') ?? 'plays';

    if (view === 'stats') {
      const range = normalizeStatsRange(url.searchParams.get('range'));
      const spec = STATS_RANGE_SPECS[range];
      const { labels, start } = statsWindow(spec.unit, spec.points, Date.now());

      const rows = await env.DB.prepare(PLAY_STAT_SQL[spec.unit]).bind(start, SITE_TZ_OFFSET_SECONDS).all<StatsBucketRow>();
      // 服务端补齐零桶：前端拿到的永远是 spec.points 个点（与访问统计逐字同形，可直接复用图表组件）
      const points = buildStatsPoints(labels, rows.results ?? []);

      return json({ range, unit: spec.unit, points });
    }

    // 明细：分页（before 为 play_logs 的 id，倒序）。非法 before 一律当"从最新开始"，
    // 与 admin/logs.ts 一样不回 400 —— 管理端翻页时参数被改坏也不该把整个面板打空。
    const beforeParam = url.searchParams.get('before');
    const before = beforeParam && Number(beforeParam) > 0 ? Number(beforeParam) : 0;
    const rows = await env.DB.prepare(
      `SELECT p.id, p.mode, p.source, p.created_at, u.username
       FROM play_logs p LEFT JOIN users u ON u.id = p.user_id
       WHERE ? = 0 OR p.id < ?
       ORDER BY p.id DESC
       LIMIT ?`,
    )
      .bind(before, before, PAGE_SIZE)
      .all<PlayRow>();

    const plays = (rows.results ?? []).map((r) => ({
      id: r.id,
      username: r.username ?? null,
      mode: r.mode,
      // 库里只有白名单内的两个值（写入时已校验）；未知值按 start 兜底，避免前端拿到空标签
      source: r.source === 'tab' ? ('tab' as const) : ('start' as const),
      createdAt: r.created_at,
    }));
    return json({ plays });
  }),
);
