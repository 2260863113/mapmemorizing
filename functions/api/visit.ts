import { verifySession } from '../_lib/auth';
import { json, handle } from '../_lib/http';
import { classifyClient } from '../_lib/botDetect';
import { clientIp, requestGeo, sanitizeClientEnv } from '../_lib/clientEnv';

/** 页面访问上报：前端每次进入站点时调用（带 token 则记录登录用户，否则记匿名——游客/爬虫由判定区分）。 */
export const onRequestPost = handle(async (context) => {
  const env = context.env as { DB: import('@cloudflare/workers-types').D1Database };
  const now = Date.now();
  const ua = context.request.headers.get('user-agent') ?? null;

  let userId: number | null = null;
  try {
    const session = await verifySession(context.request, env, now);
    userId = session?.user.id ?? null;
  } catch {
    userId = null; // token 无效按匿名记录
  }

  const clientEnv = sanitizeClientEnv(await readReportedEnv(context.request));
  const geo = requestGeo(context.request);
  const verdict = classifyClient({ ua, country: geo.country, env: clientEnv });

  try {
    await env.DB.prepare(
      `INSERT INTO access_logs (user_id, ua, ip, country, region, city, env, bot, bot_reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        userId,
        ua,
        clientIp(context.request),
        geo.country,
        geo.region,
        geo.city,
        clientEnv ? JSON.stringify(clientEnv) : null,
        verdict.bot ? 1 : 0,
        verdict.reasons.length ? JSON.stringify(verdict.reasons) : null,
        now,
      )
      .run();
  } catch (err) {
    // 日志是旁路：迁移未执行（缺列）或 D1 抖动时，丢一条日志远好过让访客看到一个 500。
    console.warn('access log insert failed', err);
  }

  return json({ ok: true });
});

/**
 * 读请求体里的 env 字段。
 *
 * 不能用 `readJson()`：前端采集不到环境时**不发 body**（见 `src/api.ts` 的 `visit`），
 * 而 `readJson` 会把空 body 当成 400。上报是尽力而为，坏 JSON 一律当"没有环境"处理。
 */
async function readReportedEnv(request: Request): Promise<unknown> {
  try {
    const text = await request.text();
    if (!text) return null;
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? (parsed as { env?: unknown }).env : null;
  } catch {
    return null;
  }
}
