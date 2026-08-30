import { json, handle } from '../_lib/http';
import { toLeaderboardEntry, type LeaderboardRow } from '../_lib/rows';
import { validMode } from '../_lib/validate';

export const onRequestGet = handle(async (context) => {
  const env = context.env as { DB: import('@cloudflare/workers-types').D1Database };
  const url = new URL(context.request.url);
  const modeParam = url.searchParams.get('mode');
  const scopeParam = url.searchParams.get('scope');

  if (!validMode(modeParam)) return json({ error: { code: 'invalid_mode', message: '无效的模式' } }, 400);
  const scope = scopeParam && scopeParam.length > 0 ? scopeParam : '';

  let orderBy: string;
  if (modeParam === 'endless') {
    orderBy = 'l.coins DESC, l.level DESC, l.submitted_at ASC, u.username ASC';
  } else if (scope === '') {
    orderBy = 'l.correct DESC, l.elapsed_ms ASC, l.submitted_at ASC, u.username ASC';
  } else {
    orderBy = 'l.elapsed_ms ASC, l.submitted_at ASC, u.username ASC';
  }

  const rows = await env.DB.prepare(
    `SELECT l.id, l.mode, l.scope_province, l.scope_label, l.total_units, l.correct, l.elapsed_ms,
            l.submitted_at, l.coins, l.level, u.username
     FROM leaderboard l JOIN users u ON u.id = l.user_id
     WHERE l.mode = ? AND l.scope_province = ?
     ORDER BY ${orderBy}
     LIMIT 10`,
  )
    .bind(modeParam, scope)
    .all<LeaderboardRow>();

  return json({ entries: (rows.results ?? []).map(toLeaderboardEntry) });
});
