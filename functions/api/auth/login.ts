import { createSession } from '../../_lib/auth';
import { json, readJson, handle } from '../../_lib/http';
import { toPublicUser } from '../../_lib/rows';
import { cleanUsername, normalizePasswordHash } from '../../_lib/validate';

interface LoginBody {
  username?: unknown;
  passwordHash?: unknown;
}

export const onRequestPost = handle(async (context) => {
  const env = context.env as { DB: import('@cloudflare/workers-types').D1Database };
  const body = await readJson<LoginBody>(context.request);

  const username = cleanUsername(body.username);
  if (!username) return json({ error: { code: 'invalid_username', message: '请输入用户名' } }, 400);

  let pwd;
  try {
    pwd = normalizePasswordHash(body.passwordHash);
  } catch {
    return json({ error: { code: 'invalid_password_hash', message: '密码哈希格式错误' } }, 400);
  }

  const row = await env.DB.prepare(
    `SELECT id, username, password_salt, password_hash, password_iterations, hometown, avatar, created_at, updated_at
     FROM users WHERE username = ?`,
  )
    .bind(username)
    .first();

  // 统一回 401，不区分"用户不存在/密码错误"，防枚举
  if (!row || row.password_hash !== pwd.hash || row.password_salt !== pwd.salt) {
    return json({ error: { code: 'wrong_password', message: '用户名或密码错误' } }, 401);
  }

  const now = Date.now();
  const token = await createSession(env, row.id as number, now);
  return json({ token, user: toPublicUser(row as never) });
});
