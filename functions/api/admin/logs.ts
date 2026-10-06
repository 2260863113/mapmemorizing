import { json, handle } from '../../_lib/http';
import { requireAdmin } from '../../_lib/guard';
import { parseJson } from '../../_lib/rows';
import { sanitizeClientEnv, type ClientEnv } from '../../_lib/clientEnv';
import {
  buildStatsPoints,
  normalizeStatsRange,
  SITE_TZ_OFFSET_SECONDS,
  STATS_RANGE_SPECS,
  statsWindow,
  type StatsBucketRow,
  type StatsUnit,
} from '../../_lib/statsWindow';

interface LogRow {
  id: number;
  username: string | null;
  ua: string | null;
  ip: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  env: string | null;
  bot: number | null;
  bot_reason: string | null;
  created_at: number;
}

const PAGE_SIZE = 50;

/**
 * 从 `bot_reason` 列解析理由标签。
 *
 * 该列存的是 JSON 数组字符串（写入端 = `JSON.stringify(classifyClient().reasons)`），但**读取端不做
 * 假定**：手工执行过 SQL、或以后改了写入格式，坏值都只能退化成空数组 —— 解析失败不该让整个日志面板
 * 打不开（这是管理端唯一能看到"到底发生了什么"的地方）。
 */
function parseBotReasons(raw: string | null): string[] {
  const parsed = parseJson<unknown>(raw);
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
}

/**
 * 把 `env` 列读回 `ClientEnv`。
 *
 * 读出来也过一遍 `sanitizeClientEnv`（而不是只 `parseJson`）：库里可能有旧版本写入的行或手工 INSERT
 * 的行，形状不保证；白名单函数保证"给前端的永远是契约里的形状，且绝不抛错"。
 */
function parseClientEnv(raw: string | null): ClientEnv | null {
  return sanitizeClientEnv(parseJson<unknown>(raw));
}

/**
 * 分桶统计 SQL。两条**常量**语句而不是拼接格式串：格式化串虽然来自 `statsWindow` 的字面量
 * 表，但「SQL 里出现模板字符串」本身就该避免，读的人不该去追它到底安不安全。
 *
 * ⚠ 桶标签**不用** SQLite 的 `'localtime'`：D1 没有 tzdata，`'localtime'` 一律按 UTC 解析，
 * 而 Worker 的 `Date` 在本地 dev 下跟宿主时区 —— 两边会差整整 8 个小时桶（标签写 14:00、
 * 计数却来自 UTC 14:00）。这里统一用**站点时区偏移**：`created_at / 1000 + ?2` 再用
 * `'unixepoch'` 渲染，`?2` 绑定 `SITE_TZ_OFFSET_SECONDS`，与 JS 侧 `statsWindow` 的标签
 * 是同一个变换（详见 `_lib/statsWindow.ts` 文件头）。
 */
const STAT_SQL: Record<StatsUnit, string> = {
  hour: `SELECT strftime('%Y-%m-%d %H:00', created_at / 1000 + ?2, 'unixepoch') AS label, COUNT(*) AS count
         FROM access_logs
         WHERE created_at >= ?1
         GROUP BY label`,
  day: `SELECT strftime('%Y-%m-%d', created_at / 1000 + ?2, 'unixepoch') AS label, COUNT(*) AS count
        FROM access_logs
        WHERE created_at >= ?1
        GROUP BY label`,
};

/** 管理员：访问日志明细（分页） + 流量看板（按范围内的粒度分桶、缺桶补 0 的连续序列）。 */
export const onRequestGet = handle(
  requireAdmin(async (context) => {
    const env = context.env;
    const url = new URL(context.request.url);
    const view = url.searchParams.get('view') ?? 'logs';

    if (view === 'stats') {
      const range = normalizeStatsRange(url.searchParams.get('range'));
      const spec = STATS_RANGE_SPECS[range];
      const { labels, start } = statsWindow(spec.unit, spec.points, Date.now());

      const rows = await env.DB.prepare(STAT_SQL[spec.unit]).bind(start, SITE_TZ_OFFSET_SECONDS).all<StatsBucketRow>();
      // 服务端补齐零桶（见 _lib/statsWindow.ts 的说明）：前端拿到的永远是 spec.points 个点
      const points = buildStatsPoints(labels, rows.results ?? []);

      return json({ range, unit: spec.unit, points });
    }

    // 日志明细：分页（before 为日志 id，倒序）
    const beforeParam = url.searchParams.get('before');
    const before = beforeParam && Number(beforeParam) > 0 ? Number(beforeParam) : 0;
    const rows = await env.DB.prepare(
      `SELECT l.id, l.ua, l.ip, l.country, l.region, l.city, l.env, l.bot, l.bot_reason, l.created_at, u.username
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
      // UA 原样返回（**不截断**）：管理端要显示完整浏览器环境，截断会让"到底哪个版本"看不出答案
      ua: r.ua ?? '',
      ip: r.ip ?? null,
      country: r.country ?? null,
      region: r.region ?? null,
      city: r.city ?? null,
      env: parseClientEnv(r.env),
      bot: r.bot === 1,
      botReasons: parseBotReasons(r.bot_reason),
      createdAt: r.created_at,
    }));
    return json({ logs });
  }),
);
