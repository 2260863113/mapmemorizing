import { json, handle } from '../../../_lib/http';
import { requireSession } from '../../../_lib/guard';
import { parsePositiveInt } from '../../../_lib/board';

export const onRequestDelete = handle(
  requireSession(async (context) => {
    const env = context.env;
    const session = context.session;

    const id = parsePositiveInt(context.params.id, '回复ID');
    const reply = await env.DB.prepare('SELECT id, post_id, user_id FROM board_replies WHERE id = ?').bind(id).first<{ id: number; post_id: number; user_id: number }>();
    if (!reply) return json({ error: { code: 'not_found', message: '回复不存在' } }, 404);
    if (reply.user_id !== session.user.id) return json({ error: { code: 'forbidden', message: '只能删除自己的回复' } }, 403);

    await env.DB.prepare('DELETE FROM board_replies WHERE id = ?').bind(id).run();
    return json({ ok: true });
  }),
);
