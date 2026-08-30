/** 会话 token 签发与校验。token 明文只出现在响应体/前端；库中只存 SHA-256 摘要。 */

import { bearer, type Env } from './http';

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 天

export interface UserRow {
  id: number;
  username: string;
  password_salt: string;
  password_hash: string;
  password_iterations: number;
  hometown: string | null;
  avatar: string | null;
  created_at: number;
  updated_at: number;
}

/** 32 字节随机 token（hex）。 */
export function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** 生成会话并返回明文 token。 */
export async function createSession(env: Env, userId: number, now: number): Promise<string> {
  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .bind(tokenHash, userId, now, now + SESSION_TTL_MS)
    .run();
  return token;
}

export interface SessionResult {
  user: UserRow;
}

/** 校验 Authorization 头；有效返回用户行，无效返回 null。 */
export async function verifySession(request: Request, env: Env, now: number): Promise<SessionResult | null> {
  const token = bearer(request);
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const res = await env.DB.prepare(
    `SELECT u.id, u.username, u.password_salt, u.password_hash, u.password_iterations,
            u.hometown, u.avatar, u.created_at, u.updated_at
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`,
  )
    .bind(tokenHash, now)
    .first<UserRow>();
  return res ? { user: res } : null;
}

/** 撤销一个会话（登出）。 */
export async function revokeSession(request: Request, env: Env): Promise<void> {
  const token = bearer(request);
  if (!token) return;
  const tokenHash = await sha256Hex(token);
  await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
}
