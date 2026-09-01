import { verifySession } from '../../../_lib/auth';
import { json, handle } from '../../../_lib/http';
import { parsePositiveInt } from '../../../_lib/board';

export const onRequestDelete = handle(async (context) => {
  const env = context.env as { DB: import('@cloudflare/workers-types').D1Database };
  const session = await verifySession(context.request, env, Date.now());
  if (!session) return json({ error: { code: 'unauthorized', message: '未登录' } }, 401);

  const id = parsePositiveInt(context.params.id, '回复ID');
  const reply = await env.DB.prepare('SELECT id, post_id, user_id FROM board_replies WHERE id = ?').bind(id).first<{ id: number; post_id: number; user_id: number }>();
  if (!reply) return json({ error: { code: 'not_found', message: '回复不存在' } }, 404);
  if (reply.user_id !== session.user.id) return json({ error: { code: 'forbidden', message: '只能删除自己的回复' } }, 403);

  await env.DB.prepare('DELETE FROM board_replies WHERE id = ?').bind(id).run();
  return json({ ok: true });
});
