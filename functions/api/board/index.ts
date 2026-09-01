import { verifySession } from '../../_lib/auth';
import { json, readJson, handle } from '../../_lib/http';
import { MAX_POST_LEN, cleanBoardText, parseBefore, parseLimit, parsePositiveInt } from '../../_lib/board';

interface ReplyRow {
  id: number;
  post_id: number;
  content: string;
  created_at: number;
  username: string;
}

interface PostRow {
  id: number;
  content: string;
  created_at: number;
  username: string;
}

export interface BoardReplyDto {
  id: number;
  postId: number;
  content: string;
  createdAt: number;
  username: string;
}

export interface BoardPostDto {
  id: number;
  content: string;
  createdAt: number;
  username: string;
  replyCount: number;
  replies: BoardReplyDto[];
}

const PREVIEW_REPLIES = 3;

/** 按 reply id 倒序分页拉取某帖的更多回复（before=0 表示从最新开始）。 */
async function fetchReplies(env: { DB: import('@cloudflare/workers-types').D1Database }, postId: number, before: number, limit: number): Promise<BoardReplyDto[]> {
  const rows = await env.DB.prepare(
    `SELECT r.id, r.post_id, r.content, r.created_at, u.username
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

function toReply(row: ReplyRow): BoardReplyDto {
  return { id: row.id, postId: row.post_id, content: row.content, createdAt: row.created_at, username: row.username };
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
    `SELECT p.id, p.content, p.created_at, u.username
     FROM board_posts p JOIN users u ON u.id = p.user_id
     WHERE ? = 0 OR p.id < ?
     ORDER BY p.id DESC
     LIMIT ?`,
  )
    .bind(before, before, limit)
    .all<PostRow>();

  const posts: BoardPostDto[] = [];
  for (const row of postRows.results ?? []) {
    const preview = await fetchReplies(env, row.id, 0, PREVIEW_REPLIES);
    const countRow = await env.DB.prepare('SELECT COUNT(*) AS c FROM board_replies WHERE post_id = ?').bind(row.id).first<{ c: number }>();
    posts.push({
      id: row.id,
      content: row.content,
      createdAt: row.created_at,
      username: row.username,
      replyCount: countRow?.c ?? 0,
      replies: preview,
    });
  }
  return json({ posts });
});

export const onRequestPost = handle(async (context) => {
  const env = context.env as { DB: import('@cloudflare/workers-types').D1Database };
  const session = await verifySession(context.request, env, Date.now());
  if (!session) return json({ error: { code: 'unauthorized', message: '未登录' } }, 401);

  const body = await readJson<{ content?: unknown }>(context.request);
  const content = cleanBoardText(body.content, MAX_POST_LEN);
  if (!content) return json({ error: { code: 'invalid_content', message: `内容不能为空且不超过 ${MAX_POST_LEN} 字` } }, 400);

  const now = Date.now();
  const result = await env.DB.prepare('INSERT INTO board_posts (user_id, content, created_at) VALUES (?, ?, ?)')
    .bind(session.user.id, content, now)
    .run();
  const id = Number(result.meta.last_row_id);

  const post: BoardPostDto = { id, content, createdAt: now, username: session.user.username, replyCount: 0, replies: [] };
  return json({ post }, 201);
});
