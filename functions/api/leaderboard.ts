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
  } else {
    // 除 endless（比金币 → 比关卡）外**所有** mode/scope 都用同一条排序：
    // 先比答对个数（拼图榜的 correct 列存「已拼」个数）、同数比用时、再按提交时间与用户名定并列。
    //
    // 历史口径里省级榜（省级全国哨兵 / 单省 adcode）只按用时排序，本轮用户口径统一为
    // 「先看正确个数，然后看时间快慢」；此处必须与 score.ts 的 ON CONFLICT ... WHERE、
    // validate.ts 的 isBetter 同口径，否则榜上排名与「新成绩是否更优」会互相打架。
    orderBy = 'l.correct DESC, l.elapsed_ms ASC, l.submitted_at ASC, u.username ASC';
  }

  const rows = await env.DB.prepare(
    `SELECT l.id, l.mode, l.scope_province, l.scope_label, l.total_units, l.correct, l.elapsed_ms,
            l.submitted_at, l.coins, l.level, u.username, u.hometown, u.avatar
     FROM leaderboard l JOIN users u ON u.id = l.user_id
     WHERE l.mode = ? AND l.scope_province = ?
     ORDER BY ${orderBy}
     LIMIT 10`,
  )
    .bind(modeParam, scope)
    .all<LeaderboardRow>();

  return json({ entries: (rows.results ?? []).map(toLeaderboardEntry) });
});
