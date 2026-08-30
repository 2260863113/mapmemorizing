import { revokeSession } from '../../_lib/auth';
import { json, handle } from '../../_lib/http';

export const onRequestPost = handle(async (context) => {
  const env = context.env as { DB: import('@cloudflare/workers-types').D1Database };
  await revokeSession(context.request, env);
  return json({ ok: true });
});
