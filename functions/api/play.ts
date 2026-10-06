import { json, readJson, handle } from '../_lib/http';
import { verifySession } from '../_lib/auth';
import { validMode } from '../_lib/validate';
import { classifyClient } from '../_lib/botDetect';
import { clientIp, requestGeo, sanitizeClientEnv } from '../_lib/clientEnv';

/** 游玩上报的来源（与 `src/api.ts` 的 `PlaySource` 逐字对应）。 */
type PlaySource = 'start' | 'tab';

/** 来源白名单：`start` = 点「开始」，`tab` = 按 Tab 快速重置后立刻开始。两者都要计入游玩统计。 */
const PLAY_SOURCES: ReadonlySet<string> = new Set(['start', 'tab']);

function isPlaySource(value: unknown): value is PlaySource {
  return typeof value === 'string' && PLAY_SOURCES.has(value);
}

/**
 * 游玩上报：用户开始一局时调用（点「开始」或按 Tab 快速重置），同时带浏览器环境供管理端判定。
 *
 * 为什么单独一张 play_logs 而不是复用 access_logs：访问与游玩是**两个口径**（进站次数 vs 开始局数），
 * 混在一张表里任何一侧加字段都会污染另一侧的统计。
 *
 * 与 `/api/visit` 的区别：这里的 body 是**必需**的（mode/source 必须在白名单内），坏 body 返回 400；
 * 但**入库失败不外抛**（迁移未执行、D1 抖动）——上报失败不该让玩家点了「开始」却弹一个错误。
 */
export const onRequestPost = handle(async (context) => {
  const env = context.env;
  const body = await readJson<{ mode?: unknown; source?: unknown; env?: unknown }>(context.request);

  // 复用成绩提交的白名单（`_lib/validate.ts`），避免模式名单在仓库里出现第二份
  if (!validMode(body.mode)) return json({ error: { code: 'invalid_mode', message: '无效的模式' } }, 400);
  if (!isPlaySource(body.source)) return json({ error: { code: 'invalid_source', message: '无效的来源' } }, 400);

  const now = Date.now();
  const ua = context.request.headers.get('user-agent') ?? null;

  let userId: number | null = null;
  try {
    const session = await verifySession(context.request, env, now);
    userId = session?.user.id ?? null;
  } catch {
    userId = null; // token 无效/会话表异常按匿名记录
  }

  const clientEnv = sanitizeClientEnv(body.env);
  const geo = requestGeo(context.request);
  const verdict = classifyClient({ ua, country: geo.country, env: clientEnv });

  try {
    await env.DB.prepare(
      `INSERT INTO play_logs (user_id, mode, source, ua, ip, country, region, city, env, bot, bot_reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        userId,
        body.mode,
        body.source,
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
    // 统计少一条好过玩家点「开始」看到报错（2026-09 上线时最容易踩的正是"迁移没跑"）
    console.warn('play log insert failed', err);
  }

  return json({ ok: true });
});
