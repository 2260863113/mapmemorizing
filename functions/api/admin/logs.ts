import { json, handle } from '../../_lib/http';
import { requireAdmin } from '../../_lib/guard';

interface LogRow {
  id: number;
  username: string | null;
  ua: string | null;
  created_at: number;
}

interface DayStatRow {
  day: string;
  count: number;
}

interface HourStatRow {
  hour: string;
  count: number;
}

const PAGE_SIZE = 50;

/** 管理员：访问日志明细（分页） + 按天/小时统计。 */
export const onRequestGet = handle(
  requireAdmin(async (context) => {
    const env = context.env;
    const url = new URL(context.request.url);
    const view = url.searchParams.get('view') ?? 'logs';

    if (view === 'stats') {
      // 按天统计（最近 14 天）
      const dayRows = await env.DB.prepare(
        `SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch', 'localtime') AS day, COUNT(*) AS count
         FROM access_logs
         WHERE created_at >= ?1
         GROUP BY day
         ORDER BY day DESC
         LIMIT 14`,
      )
        .bind(Date.now() - 14 * 86_400_000)
        .all<DayStatRow>();

      // 按小时统计（最近 24 小时）
      const hourRows = await env.DB.prepare(
        `SELECT strftime('%Y-%m-%d %H:00', created_at / 1000, 'unixepoch', 'localtime') AS hour, COUNT(*) AS count
         FROM access_logs
         WHERE created_at >= ?1
         GROUP BY hour
         ORDER BY hour DESC
         LIMIT 24`,
      )
        .bind(Date.now() - 24 * 3_600_000)
        .all<HourStatRow>();

      return json({
        days: (dayRows.results ?? []).map((r) => ({ day: r.day, count: r.count })),
        hours: (hourRows.results ?? []).map((r) => ({ hour: r.hour, count: r.count })),
      });
    }

    // 日志明细：分页（before 为日志 id，倒序）
    const beforeParam = url.searchParams.get('before');
    const before = beforeParam && Number(beforeParam) > 0 ? Number(beforeParam) : 0;
    const rows = await env.DB.prepare(
      `SELECT l.id, l.ua, l.created_at, u.username
       FROM access_logs l LEFT JOIN users u ON u.id = l.user_id
       WHERE ? = 0 OR l.id < ?
       ORDER BY l.id DESC
       LIMIT ?`,
    )
      .bind(before, before, PAGE_SIZE)
      .all<LogRow>();

    const logs = (rows.results ?? []).map((r) => ({
      id: r.id,
      username: r.username ?? null,
      ua: r.ua ?? '',
      createdAt: r.created_at,
    }));
    return json({ logs });
  }),
);
