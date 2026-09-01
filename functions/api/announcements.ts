import { json, handle } from '../_lib/http';

interface AnnouncementRow {
  id: number;
  title: string;
  content: string;
  pinned: number;
  created_at: number;
  updated_at: number;
}

export interface AnnouncementDto {
  id: number;
  title: string;
  content: string;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
}

/** 公开公告列表：置顶优先 + 时间倒序，全部返回不折叠。 */
export const onRequestGet = handle(async (context) => {
  const env = context.env as { DB: import('@cloudflare/workers-types').D1Database };
  const rows = await env.DB.prepare(
    `SELECT id, title, content, pinned, created_at, updated_at
     FROM announcements
     ORDER BY pinned DESC, created_at DESC`,
  ).all<AnnouncementRow>();
  const announcements: AnnouncementDto[] = (rows.results ?? []).map((r) => ({
    id: r.id,
    title: r.title,
    content: r.content,
    pinned: r.pinned === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
  return json({ announcements });
});
