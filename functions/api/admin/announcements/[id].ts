import { adminDenied, verifyAdmin } from '../../../_lib/admin';
import { json, readJson, handle } from '../../../_lib/http';
import { parsePositiveInt } from '../../../_lib/board';

const MAX_TITLE = 60;
const MAX_CONTENT = 2000;

interface AnnouncementBody {
  title?: unknown;
  content?: unknown;
  pinned?: unknown;
}

function cleanText(value: unknown, maxLen: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  if (Array.from(text).length > maxLen) return null;
  return text;
}

/** 管理员：修改公告。 */
export const onRequestPut = handle(async (context) => {
  const env = context.env as { DB: import('@cloudflare/workers-types').D1Database };
  const admin = await verifyAdmin(context.request, env);
  if (!admin) return adminDenied();

  const id = parsePositiveInt(context.params.id, '公告ID');
  const existing = await env.DB.prepare('SELECT id FROM announcements WHERE id = ?').bind(id).first<{ id: number }>();
  if (!existing) return json({ error: { code: 'not_found', message: '公告不存在' } }, 404);

  const body = await readJson<AnnouncementBody>(context.request);
  const title = cleanText(body.title, MAX_TITLE);
  const content = cleanText(body.content, MAX_CONTENT);
  if (!title || !content) return json({ error: { code: 'invalid_announcement', message: `标题(≤${MAX_TITLE}字)与内容(≤${MAX_CONTENT}字)不能为空` } }, 400);
  const pinned = body.pinned === true ? 1 : 0;
  const now = Date.now();

  await env.DB.prepare('UPDATE announcements SET title = ?, content = ?, pinned = ?, updated_at = ? WHERE id = ?')
    .bind(title, content, pinned, now, id)
    .run();

  return json({ announcement: { id, title, content, pinned: pinned === 1, updatedAt: now } });
});

/** 管理员：删除公告。 */
export const onRequestDelete = handle(async (context) => {
  const env = context.env as { DB: import('@cloudflare/workers-types').D1Database };
  const admin = await verifyAdmin(context.request, env);
  if (!admin) return adminDenied();

  const id = parsePositiveInt(context.params.id, '公告ID');
  const result = await env.DB.prepare('DELETE FROM announcements WHERE id = ?').bind(id).run();
  if (result.meta.changes === 0) return json({ error: { code: 'not_found', message: '公告不存在' } }, 404);
  return json({ ok: true });
});
