/** 鉴权装饰器：把「登录 / 管理员」检查从各路由的重复样板中抽出。 */

import { verifySession, type SessionResult } from './auth';
import { json, type Ctx } from './http';

/** 登录会话上下文：verifySession 通过后传给 handler。 */
export interface AuthedCtx extends Ctx {
  session: SessionResult;
}

/**
 * 包裹 onRequest handler：先验证登录，失败统一返回 401。
 * 不再需要每个路由手写 `if (!session) return json({ error: ... }, 401)`。
 */
export function requireSession(handler: (context: AuthedCtx) => Promise<Response>) {
  return async (context: Ctx) => {
    const session = await verifySession(context.request, context.env, Date.now());
    if (!session) return json({ error: { code: 'unauthorized', message: '未登录' } }, 401);
    return handler({ ...context, session });
  };
}

/** 包裹 onRequest handler：先验证管理员，失败统一返回 403。 */
export function requireAdmin(handler: (context: AuthedCtx) => Promise<Response>) {
  return async (context: Ctx) => {
    const session = await verifySession(context.request, context.env, Date.now());
    if (!session || session.user.is_admin !== 1) {
      return json({ error: { code: 'forbidden', message: '需要管理员权限' } }, 403);
    }
    return handler({ ...context, session });
  };
}
