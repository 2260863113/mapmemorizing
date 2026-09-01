import { adminDenied, verifyAdmin } from '../../_lib/admin';
import { json, handle } from '../../_lib/http';
import { parseJson } from '../../_lib/rows';

interface AdminUserRow {
  id: number;
  username: string;
  hometown: string | null;
  avatar: string | null;
  is_admin: number;
  created_at: number;
}

/** 管理员：用户列表（一个用户一行）。 */
export const onRequestGet = handle(async (context) => {
  const env = context.env as { DB: import('@cloudflare/workers-types').D1Database };
  const admin = await verifyAdmin(context.request, env);
  if (!admin) return adminDenied();

  const rows = await env.DB.prepare(
    `SELECT id, username, hometown, avatar, is_admin, created_at
     FROM users
     ORDER BY is_admin DESC, created_at ASC`,
  ).all<AdminUserRow>();

  const users = (rows.results ?? []).map((r) => ({
    id: r.id,
    username: r.username,
    hometown: parseJson<{ provinceAdcode: string; cityAdcode: string }>(r.hometown),
    avatar: parseJson<{ dataUrl: string }>(r.avatar)?.dataUrl ?? null,
    isAdmin: r.is_admin === 1,
    createdAt: r.created_at,
  }));
  return json({ users });
});
