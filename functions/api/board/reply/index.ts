import { json, readJson, handle } from '../../../_lib/http';
import { requireSession } from '../../../_lib/guard';
import { MAX_REPLY_LEN, cleanBoardText, parsePositiveInt } from '../../../_lib/board';
import { parseJson } from '../../../_lib/rows';
import type { BoardReplyDto } from '../index';

export const onRequestPost = handle(
  requireSession(async (context) => {
    const env = context.env;
    const session = context.session;

    const body = await readJson<{ postId?: unknown; content?: unknown }>(context.request);
    const postId = parsePositiveInt(typeof body.postId === 'string' ? body.postId : String(body.postId ?? ''), '帖子ID');
    const content = cleanBoardText(body.content, MAX_REPLY_LEN);
    if (!content) return json({ error: { code: 'invalid_content', message: `回复不能为空且不超过 ${MAX_REPLY_LEN} 字` } }, 400);

    const post = await env.DB.prepare('SELECT id FROM board_posts WHERE id = ?').bind(postId).first<{ id: number }>();
    if (!post) return json({ error: { code: 'not_found', message: '帖子不存在' } }, 404);

    const now = Date.now();
    const result = await env.DB.prepare('INSERT INTO board_replies (post_id, user_id, content, created_at) VALUES (?, ?, ?, ?)')
      .bind(postId, session.user.id, content, now)
      .run();
    const id = Number(result.meta.last_row_id);

    const reply: BoardReplyDto = {
      id,
      postId,
      content,
      createdAt: now,
      username: session.user.username,
      avatar: parseJson<{ dataUrl: string }>(session.user.avatar)?.dataUrl ?? null,
    };
    return json({ reply }, 201);
  }),
);
