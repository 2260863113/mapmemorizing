import { verifySession } from '../../_lib/auth';
import { json, readJson, handle } from '../../_lib/http';
import { toPublicUser } from '../../_lib/rows';
import { cleanUsername, normalizePasswordHash } from '../../_lib/validate';

interface Hometown {
  provinceAdcode: string;
  cityAdcode: string;
}
interface Avatar {
  dataUrl: string;
  name: string;
  size: number;
  type: string;
}

interface ProfileBody {
  username?: unknown;
  hometown?: Hometown | null;
  avatar?: Avatar | null;
  oldPasswordHash?: unknown;
  newPasswordHash?: unknown;
}

const MAX_AVATAR_SIZE = 20 * 1024;

export const onRequestPost = handle(async (context) => {
  const env = context.env as { DB: import('@cloudflare/workers-types').D1Database };
  const session = await verifySession(context.request, env, Date.now());
  if (!session) return json({ error: { code: 'unauthorized', message: '未登录' } }, 401);

  const user = session.user;
  const body = await readJson<ProfileBody>(context.request);

  const username = cleanUsername(body.username);
  if (!username) return json({ error: { code: 'invalid_username', message: '请输入用户名' } }, 400);

  // 改用户名唯一性（排除自己）
  if (username.toLowerCase() !== user.username.toLowerCase()) {
    const clash = await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(username).first();
    if (clash) return json({ error: { code: 'username_exists', message: '用户名已存在' } }, 409);
  }

  // 头像校验：dataUrl 长度与 size 上限
  let avatarJson: string | null = user.avatar;
  if (body.avatar !== undefined) {
    if (body.avatar === null) {
      avatarJson = null;
    } else {
      const av = body.avatar;
      if (typeof av.dataUrl !== 'string' || !av.dataUrl.startsWith('data:image/')) {
        return json({ error: { code: 'invalid_avatar', message: '头像格式错误' } }, 400);
      }
      if (typeof av.size !== 'number' || av.size < 0 || av.size > MAX_AVATAR_SIZE) {
        return json({ error: { code: 'invalid_avatar', message: '头像不能超过 20KB' } }, 400);
      }
      avatarJson = JSON.stringify({ dataUrl: av.dataUrl, name: av.name ?? '', size: av.size, type: av.type ?? '' });
    }
  }

  let hometownJson: string | null = user.hometown;
  if (body.hometown !== undefined) {
    if (body.hometown === null) {
      hometownJson = null;
    } else {
      const ht = body.hometown;
      if (typeof ht.provinceAdcode !== 'string' || typeof ht.cityAdcode !== 'string' || !/^\d{6}$/.test(ht.provinceAdcode) || !/^\d{6}$/.test(ht.cityAdcode)) {
        return json({ error: { code: 'invalid_hometown', message: '家乡信息无效' } }, 400);
      }
      hometownJson = JSON.stringify({ provinceAdcode: ht.provinceAdcode, cityAdcode: ht.cityAdcode });
    }
  }

  // 改密码：需要旧密码哈希一致 + 新密码哈希
  let passwordSalt = user.password_salt;
  let passwordHash = user.password_hash;
  let passwordIterations = user.password_iterations;
  const wantsPassword = body.oldPasswordHash || body.newPasswordHash;
  if (wantsPassword) {
    if (!body.oldPasswordHash || !body.newPasswordHash) {
      return json({ error: { code: 'old_password_required', message: '请输入旧密码和新密码' } }, 400);
    }
    let oldPwd;
    let newPwd;
    try {
      oldPwd = normalizePasswordHash(body.oldPasswordHash);
      newPwd = normalizePasswordHash(body.newPasswordHash);
    } catch {
      return json({ error: { code: 'invalid_password_hash', message: '密码哈希格式错误' } }, 400);
    }
    if (oldPwd.hash !== user.password_hash || oldPwd.salt !== user.password_salt) {
      return json({ error: { code: 'old_password_wrong', message: '旧密码不正确' } }, 400);
    }
    passwordSalt = newPwd.salt;
    passwordHash = newPwd.hash;
    passwordIterations = newPwd.iterations;
  }

  const now = Date.now();
  await env.DB.prepare(
    `UPDATE users SET username = ?, password_salt = ?, password_hash = ?, password_iterations = ?, hometown = ?, avatar = ?, updated_at = ?
     WHERE id = ?`,
  )
    .bind(username, passwordSalt, passwordHash, passwordIterations, hometownJson, avatarJson, now, user.id)
    .run();

  const row = await env.DB.prepare(
    `SELECT id, username, password_salt, password_hash, password_iterations, hometown, avatar, is_admin, created_at, updated_at
     FROM users WHERE id = ?`,
  )
    .bind(user.id)
    .first();
  if (!row) return json({ error: { code: 'internal', message: '保存失败' } }, 500);

  return json({ user: toPublicUser(row as never) });
});
