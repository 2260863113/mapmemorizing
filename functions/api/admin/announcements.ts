import { adminDenied, verifyAdmin } from '../../_lib/admin';
import { json, readJson, handle } from '../../_lib/http';

const MAX_TITLE = 60;
const MAX_CONTENT = 2000;

interface AnnouncementBody {
  title?: unknown;
  content?: unknown;
  pinned?: unknown;
}

function cleanText(value: unknown, maxLen: number, label: string): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  if (Array.from(text).length > maxLen) return null;
  return text;
}

/** 管理员：发布公告。 */
export const onRequestPost = handle(async (context) => {
  const env = context.env as { DB: import('@cloudflare/workers-types').D1Database };
  const admin = await verifyAdmin(context.request, env);
  if (!admin) return adminDenied();

  const body = await readJson<AnnouncementBody>(context.request);
  const title = cleanText(body.title, MAX_TITLE, '标题');
  const content = cleanText(body.content, MAX_CONTENT, '内容');
  if (!title || !content) return json({ error: { code: 'invalid_announcement', message: `标题(≤${MAX_TITLE}字)与内容(≤${MAX_CONTENT}字)不能为空` } }, 400);
  const pinned = body.pinned === true ? 1 : 0;

  const now = Date.now();
  const result = await env.DB.prepare(
    'INSERT INTO announcements (title, content, pinned, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  )
    .bind(title, content, pinned, now, now)
    .run();
  return json({ announcement: { id: Number(result.meta.last_row_id), title, content, pinned: pinned === 1, createdAt: now, updatedAt: now } }, 201);
});
