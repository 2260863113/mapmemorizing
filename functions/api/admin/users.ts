import { json, handle } from '../../_lib/http';
import { requireAdmin } from '../../_lib/guard';
import { parseJson } from '../../_lib/rows';

interface AdminUserRow {
  id: number;
  username: string;
  hometown: string | null;
  avatar: string | null;
  is_admin: number;
  created_at: number;
}

/**
 * 管理员：用户列表（一个用户一行）。
 *
 * 排序（2026-09 调整）：管理员置顶，其余**越晚注册越靠前** —— 面板的日常用途是"看看刚注册的是谁"，
 * 升序要翻到最后才能看到新用户，页数一多就等于看不到。
 */
export const onRequestGet = handle(
  requireAdmin(async (context) => {
    const env = context.env;

    const rows = await env.DB.prepare(
      `SELECT id, username, hometown, avatar, is_admin, created_at
       FROM users
       ORDER BY is_admin DESC, created_at DESC`,
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
  }),
);
