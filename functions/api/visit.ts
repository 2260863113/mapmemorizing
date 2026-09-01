import { verifySession } from '../_lib/auth';
import { json, handle } from '../_lib/http';

/** 页面访问上报：前端每次进入站点时调用（带 token 则记录登录用户，否则记游客）。不含 IP。 */
export const onRequestPost = handle(async (context) => {
  const env = context.env as { DB: import('@cloudflare/workers-types').D1Database };
  const now = Date.now();
  const ua = context.request.headers.get('user-agent') ?? null;

  let userId: number | null = null;
  try {
    const session = await verifySession(context.request, env, now);
    userId = session?.user.id ?? null;
  } catch {
    userId = null; // token 无效按游客记录
  }

  await env.DB.prepare('INSERT INTO access_logs (user_id, ua, created_at) VALUES (?, ?, ?)')
    .bind(userId, ua, now)
    .run();
  return json({ ok: true });
});
