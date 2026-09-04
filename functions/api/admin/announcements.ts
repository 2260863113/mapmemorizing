import { json, readJson, handle } from '../../_lib/http';
import { requireAdmin } from '../../_lib/guard';
import { cleanPlainText } from '../../_lib/board';

const MAX_TITLE = 60;
const MAX_CONTENT = 2000;

interface AnnouncementBody {
  title?: unknown;
  content?: unknown;
  pinned?: unknown;
}

/** 管理员：发布公告。 */
export const onRequestPost = handle(
  requireAdmin(async (context) => {
    const env = context.env;

    const body = await readJson<AnnouncementBody>(context.request);
    const title = cleanPlainText(body.title, MAX_TITLE);
    const content = cleanPlainText(body.content, MAX_CONTENT);
    if (!title || !content) return json({ error: { code: 'invalid_announcement', message: `标题(≤${MAX_TITLE}字)与内容(≤${MAX_CONTENT}字)不能为空` } }, 400);
    const pinned = body.pinned === true ? 1 : 0;

    const now = Date.now();
    const result = await env.DB.prepare(
      'INSERT INTO announcements (title, content, pinned, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    )
      .bind(title, content, pinned, now, now)
      .run();
    return json({ announcement: { id: Number(result.meta.last_row_id), title, content, pinned: pinned === 1, createdAt: now, updatedAt: now } }, 201);
  }),
);
