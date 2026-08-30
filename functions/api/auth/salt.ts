import { json, readJson, handle } from '../../_lib/http';
import { cleanUsername } from '../../_lib/validate';

interface SaltBody {
  username?: unknown;
}

export const onRequestPost = handle(async (context) => {
  const env = context.env as { DB: import('@cloudflare/workers-types').D1Database };
  const body = await readJson<SaltBody>(context.request);

  const username = cleanUsername(body.username);
  if (!username) return json({ error: { code: 'invalid_username', message: '请输入用户名' } }, 400);

  const row = await env.DB.prepare('SELECT password_salt, password_iterations FROM users WHERE username = ?')
    .bind(username)
    .first<{ password_salt: string; password_iterations: number }>();

  // 用户不存在：返回固定假盐，避免用户名枚举
  if (!row) {
    return json({ salt: 'MDEyMzQ1Njc4OWFiY2RlZg==', iterations: 120000 });
  }
  return json({ salt: row.password_salt, iterations: row.password_iterations });
});
