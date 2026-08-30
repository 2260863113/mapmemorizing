import { verifySession } from '../../_lib/auth';
import { json, handle } from '../../_lib/http';
import { toPublicUser } from '../../_lib/rows';

export const onRequestGet = handle(async (context) => {
  const env = context.env as { DB: import('@cloudflare/workers-types').D1Database };
  const session = await verifySession(context.request, env, Date.now());
  if (!session) return json({ error: { code: 'unauthorized', message: '未登录' } }, 401);
  return json({ user: toPublicUser(session.user) });
});
