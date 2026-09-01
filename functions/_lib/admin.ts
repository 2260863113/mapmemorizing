/** 管理员接口共享鉴权：校验登录 + is_admin。 */

import { verifySession } from './auth';
import { json, type Env } from './http';

export interface AdminSession {
  userId: number;
  username: string;
}

/** 校验管理员会话；非管理员返回 null（调用方需自行返回 403）。 */
export async function verifyAdmin(request: Request, env: Env): Promise<AdminSession | null> {
  const session = await verifySession(request, env, Date.now());
  if (!session) return null;
  if (session.user.is_admin !== 1) return null;
  return { userId: session.user.id, username: session.user.username };
}

/** 管理员鉴权失败的标准响应。 */
export function adminDenied(): Response {
  return json({ error: { code: 'forbidden', message: '需要管理员权限' } }, 403);
}
