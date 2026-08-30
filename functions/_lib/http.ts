/** 统一 JSON 响应与错误处理工具。 */

export interface Env {
  DB: import('@cloudflare/workers-types').D1Database;
}

export interface Ctx {
  request: Request;
  env: Env;
  params: Record<string, string>;
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export function apiError(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status);
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/** 从请求体解析 JSON；失败抛 ApiError 400。 */
export async function readJson<T>(request: Request): Promise<T> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new ApiError(400, 'invalid_json', '请求体不是合法 JSON');
  }
  return body as T;
}

/** 取 Authorization: Bearer <token>，无则返回 null。 */
export function bearer(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1] : null;
}

/** 包一层 onRequest：内部抛 ApiError → 统一转成 JSON 错误响应。 */
export function handle(handler: (context: Ctx) => Promise<Response>) {
  return async (context: Ctx) => {
    try {
      return await handler(context);
    } catch (err) {
      if (err instanceof ApiError) return apiError(err.status, err.code, err.message);
      console.error(err);
      return apiError(500, 'internal', '服务器内部错误');
    }
  };
}
