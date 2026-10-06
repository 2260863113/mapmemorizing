import { json, readJson, handle } from '../_lib/http';
import { requireSession } from '../_lib/guard';
import { isBetter, validateScore } from '../_lib/validate';

type ScoreMode = 'self' | 'click' | 'endless' | 'puzzle';

interface ExistingRow {
  id: number;
  coins: number | null;
  level: number | null;
  correct: number;
  elapsed_ms: number;
}

/** upsert 并发安全：ON CONFLICT 的 WHERE 复刻 isBetter，防止更差分覆盖更优分。统一 10 个占位符。
 *  冲突目标含 scope_province，因此冲突行的 mode/scope 与本次插入完全一致，分支只需看 mode：
 *  endless 比金币 → 比关卡；**其余一律**「correct 降序、同数比用时」
 *  （拼图的 correct 列存已拼个数，自然落在同一条规则里）。
 *
 *  历史口径里这里还按 scope 分「全国语义 / 省级语义」两支，省级只比用时；本轮用户口径统一为
 *  「先看正确个数、再看时间快慢」，且 `leaderboard.ts` 的 orderBy 同步统一 ——
 *  两处必须同口径，否则会出现「榜按 correct 排序、写入却只比用时」的错乱。 */
function upsertSql(mode: ScoreMode): string {
  const conflict =
    mode === 'endless'
      ? `WHERE excluded.coins > leaderboard.coins
         OR (excluded.coins = leaderboard.coins AND COALESCE(excluded.level,1) > COALESCE(leaderboard.level,1))`
      : `WHERE excluded.correct > leaderboard.correct
         OR (excluded.correct = leaderboard.correct AND excluded.elapsed_ms < leaderboard.elapsed_ms)`;
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

    const sql = upsertSql(score.mode);
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
