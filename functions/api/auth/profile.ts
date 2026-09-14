import { json, readJson, handle, ApiError, type Env } from '../../_lib/http';
import { requireSession } from '../../_lib/guard';
import { toPublicUser } from '../../_lib/rows';
import { cleanUsername } from '../../_lib/validate';
import { resolveAvatar, resolveHometown, resolvePassword, type ProfileBody } from '../../_lib/profile';

/**
 * 校验并归一化新用户名；改名时查唯一性（排除自己）。
 *
 * 它是本路由**唯一**留在原地的校验 —— 因为它要查库。其余三条（头像 / 家乡 / 密码）都在
 * `_lib/profile.ts`，无 DB 依赖、可当纯函数单测（见 `profile.test.ts`）。
 *
 * 校验失败一律 `throw ApiError`：`handle()` 会把它转成与原先手写
 * `json({ error: { code, message } }, 4xx)` **逐字相同**的响应体。
 */
async function resolveUsername(env: Env, currentUsername: string, raw: unknown): Promise<string> {
  const username = cleanUsername(raw);
  if (!username) throw new ApiError(400, 'invalid_username', '请输入用户名');
  if (username.toLowerCase() !== currentUsername.toLowerCase()) {
    const clash = await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(username).first();
    if (clash) throw new ApiError(409, 'username_exists', '用户名已存在');
  }
  return username;
}

export const onRequestPost = handle(
  requireSession(async (context) => {
    const env = context.env;
    const user = context.session.user;
    const body = await readJson<ProfileBody>(context.request);

    const username = await resolveUsername(env, user.username, body.username);
    const avatarJson = resolveAvatar(body, user.avatar);
    const hometownJson = resolveHometown(body, user.hometown);
    const pwd = resolvePassword(user, body);

    const now = Date.now();
    await env.DB.prepare(
      `UPDATE users SET username = ?, password_salt = ?, password_hash = ?, password_iterations = ?, hometown = ?, avatar = ?, updated_at = ?
       WHERE id = ?`,
    )
      .bind(username, pwd.salt, pwd.hash, pwd.iterations, hometownJson, avatarJson, now, user.id)
      .run();

    const row = await env.DB.prepare(
      `SELECT id, username, password_salt, password_hash, password_iterations, hometown, avatar, is_admin, created_at, updated_at
       FROM users WHERE id = ?`,
    )
      .bind(user.id)
      .first();
    if (!row) throw new ApiError(500, 'internal', '保存失败');

    return json({ user: toPublicUser(row as never) });
  }),
);
