import { json, readJson, handle } from '../../_lib/http';
import { requireSession } from '../../_lib/guard';
import { MAX_POST_LEN, cleanBoardText, parseBefore, parseLimit, parsePositiveInt } from '../../_lib/board';
import { parseJson } from '../../_lib/rows';

interface ReplyRow {
  id: number;
  post_id: number;
  content: string;
  created_at: number;
  username: string;
  avatar: string | null;
}

interface PostRow {
  id: number;
  content: string;
  created_at: number;
  username: string;
  avatar: string | null;
}

export interface BoardReplyDto {
  id: number;
  postId: number;
  content: string;
  createdAt: number;
  username: string;
  avatar: string | null;
}

export interface BoardPostDto {
  id: number;
  content: string;
  createdAt: number;
  username: string;
  avatar: string | null;
  replyCount: number;
  replies: BoardReplyDto[];
}

const PREVIEW_REPLIES = 3;

/** 按 reply id 倒序分页拉取某帖的更多回复（before=0 表示从最新开始）。 */
async function fetchReplies(env: { DB: import('@cloudflare/workers-types').D1Database }, postId: number, before: number, limit: number): Promise<BoardReplyDto[]> {
  const rows = await env.DB.prepare(
    `SELECT r.id, r.post_id, r.content, r.created_at, u.username, u.avatar
     FROM board_replies r JOIN users u ON u.id = r.user_id
     WHERE r.post_id = ? AND (? = 0 OR r.id < ?)
     ORDER BY r.id DESC
     LIMIT ?`,
  )
    .bind(postId, before, before, limit)
    .all<ReplyRow>();
  // 倒序取出 → 转正序返回
  return (rows.results ?? []).reverse().map(toReply);
}

/** 批量取多帖的预览回复（每帖最多 preview 条），按 postId 分组，避免逐帖查询（N+1）。 */
async function fetchPreviewReplies(env: { DB: import('@cloudflare/workers-types').D1Database }, postIds: number[], preview: number): Promise<Map<number, BoardReplyDto[]>> {
  const out = new Map<number, BoardReplyDto[]>();
  if (!postIds.length) return out;
  const placeholders = postIds.map(() => '?').join(',');
  const rows = await env.DB.prepare(
    `SELECT r.id, r.post_id, r.content, r.created_at, u.username, u.avatar
     FROM board_replies r JOIN users u ON u.id = r.user_id
     WHERE r.post_id IN (${placeholders})
     ORDER BY r.id DESC`,
  )
    .bind(...postIds)
    .all<ReplyRow>();
  const byPost = new Map<number, BoardReplyDto[]>();
  for (const row of rows.results ?? []) {
    const list = byPost.get(row.post_id) ?? [];
    list.push(toReply(row));
    byPost.set(row.post_id, list);
  }
  // 倒序取回，截断到 preview 条后转正序返回
  for (const [postId, list] of byPost) {
    out.set(postId, list.slice(0, preview).reverse());
  }
  return out;
}

/** 批量统计多帖的回复数，避免逐帖 COUNT(*)（N+1）。 */
async function fetchReplyCounts(env: { DB: import('@cloudflare/workers-types').D1Database }, postIds: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (!postIds.length) return out;
  const placeholders = postIds.map(() => '?').join(',');
  const rows = await env.DB.prepare(
    `SELECT post_id, COUNT(*) AS c FROM board_replies WHERE post_id IN (${placeholders}) GROUP BY post_id`,
  )
    .bind(...postIds)
    .all<{ post_id: number; c: number }>();
  for (const row of rows.results ?? []) out.set(row.post_id, row.c);
  return out;
}

function toReply(row: ReplyRow): BoardReplyDto {
  return { id: row.id, postId: row.post_id, content: row.content, createdAt: row.created_at, username: row.username, avatar: avatarOf(row.avatar) };
}

function avatarOf(json: string | null): string | null {
  return parseJson<{ dataUrl: string }>(json)?.dataUrl ?? null;
}

export const onRequestGet = handle(async (context) => {
  const env = context.env as { DB: import('@cloudflare/workers-types').D1Database };
  const url = new URL(context.request.url);
  const postParam = url.searchParams.get('post');
  const beforeParam = url.searchParams.get('before');
  const limit = parseLimit(url.searchParams.get('limit'));

  // 某帖的更多回复（按回复 id 倒序分页）
  if (postParam) {
    const postId = parsePositiveInt(postParam, '帖子ID');
    const before = parseBefore(beforeParam);
    const replies = await fetchReplies(env, postId, before, limit);
    return json({ replies });
  }

  // 帖子列表（按 id 倒序分页，每帖带预览回复）
  const before = parseBefore(beforeParam);
  const postRows = await env.DB.prepare(
    `SELECT p.id, p.content, p.created_at, u.username, u.avatar
     FROM board_posts p JOIN users u ON u.id = p.user_id
     WHERE ? = 0 OR p.id < ?
     ORDER BY p.id DESC
     LIMIT ?`,
  )
    .bind(before, before, limit)
    .all<PostRow>();

  const rows = postRows.results ?? [];
  // 批量取预览回复与回复数，替代逐帖 2 次查询（消除 N+1）。
  const postIds = rows.map((r) => r.id);
  const [previews, counts] = await Promise.all([
    fetchPreviewReplies(env, postIds, PREVIEW_REPLIES),
    fetchReplyCounts(env, postIds),
  ]);
  const posts: BoardPostDto[] = rows.map((row) => ({
    id: row.id,
    content: row.content,
    createdAt: row.created_at,
    username: row.username,
    avatar: avatarOf(row.avatar),
    replyCount: counts.get(row.id) ?? 0,
    replies: previews.get(row.id) ?? [],
  }));
  return json({ posts });
});

export const onRequestPost = handle(
  requireSession(async (context) => {
    const env = context.env;
    const session = context.session;

    const body = await readJson<{ content?: unknown }>(context.request);
    const content = cleanBoardText(body.content, MAX_POST_LEN);
    if (!content) return json({ error: { code: 'invalid_content', message: `内容不能为空且不超过 ${MAX_POST_LEN} 字` } }, 400);

    const now = Date.now();
    const result = await env.DB.prepare('INSERT INTO board_posts (user_id, content, created_at) VALUES (?, ?, ?)')
      .bind(session.user.id, content, now)
      .run();
    const id = Number(result.meta.last_row_id);

    const post: BoardPostDto = {
      id,
      content,
      createdAt: now,
      username: session.user.username,
      avatar: parseJson<{ dataUrl: string }>(session.user.avatar)?.dataUrl ?? null,
      replyCount: 0,
      replies: [],
    };
    return json({ post }, 201);
  }),
);
