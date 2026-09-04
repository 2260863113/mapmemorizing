import { json, readJson, handle } from '../_lib/http';
import { requireSession } from '../_lib/guard';
import { isBetter, validateScore, WORLD_NATION_SCOPE } from '../_lib/validate';

type ScoreMode = 'self' | 'click' | 'endless';

interface ExistingRow {
  id: number;
  coins: number | null;
  level: number | null;
  correct: number;
  elapsed_ms: number;
}

/** upsert 并发安全：ON CONFLICT 的 WHERE 复刻 isBetter，防止更差分覆盖更优分。统一 10 个占位符。
 *  冲突目标含 scope_province，因此冲突行 scope 恒等于本次插入 scope：全国语义（''=市级全国、
 *  __world_nation__=世界全国）比答对题数再比用时；省级语义（省级全国哨兵/6 位省 adcode）仅比用时。 */
function upsertSql(mode: ScoreMode, scope: string): string {
  const nationLike = scope === '' || scope === WORLD_NATION_SCOPE;
  const conflict =
    mode === 'endless'
      ? `WHERE excluded.coins > leaderboard.coins
         OR (excluded.coins = leaderboard.coins AND COALESCE(excluded.level,1) > COALESCE(leaderboard.level,1))`
      : nationLike
        ? `WHERE excluded.correct > leaderboard.correct
           OR (excluded.correct = leaderboard.correct AND excluded.elapsed_ms < leaderboard.elapsed_ms)`
        : `WHERE excluded.elapsed_ms < leaderboard.elapsed_ms`;
  return `INSERT INTO leaderboard
      (user_id, mode, scope_province, scope_label, total_units, correct, elapsed_ms, coins, level, submitted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, mode, scope_province) DO UPDATE SET
        scope_label = excluded.scope_label,
        total_units = excluded.total_units,
        correct     = excluded.correct,
        elapsed_ms  = excluded.elapsed_ms,
        coins       = excluded.coins,
        level       = excluded.level,
        submitted_at= excluded.submitted_at
      ${conflict}`;
}

export const onRequestPost = handle(
  requireSession(async (context) => {
    const env = context.env;
    const session = context.session;

    const body = await readJson<unknown>(context.request);
    const score = validateScore(body);

    const scope = score.scopeProvince ?? '';
    const userId = session.user.id;

    const existing = await env.DB.prepare(
      'SELECT id, coins, level, correct, elapsed_ms FROM leaderboard WHERE user_id = ? AND mode = ? AND scope_province = ?',
    )
      .bind(userId, score.mode, scope)
      .first<ExistingRow>();

    if (existing && !isBetter(score, existing)) {
      return json({ status: 'kept' });
    }

    const sql = upsertSql(score.mode, scope);
    await env.DB.prepare(sql)
      .bind(
        userId,
        score.mode,
        scope,
        score.scopeLabel,
        score.totalUnits,
        score.correct,
        score.elapsedMs,
        score.mode === 'endless' ? (score.coins ?? 0) : null,
        score.mode === 'endless' ? (score.level ?? 1) : null,
        score.finishedAt,
      )
      .run();

    return json({ status: existing ? 'improved' : 'added' });
  }),
);
