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
  visitor: string | null;
}

/**
 * 管理员：用户列表（一个用户一行）。
 *
 * 排序（2026-09 调整）：管理员置顶，其余**越晚注册越靠前** —— 面板的日常用途是"看看刚注册的是谁"，
 * 升序要翻到最后才能看到新用户，页数一多就等于看不到。
 *
 * 游客号（2026-10 需求）：显示这个账号**登录之前**的游客编号，好把"某个注册用户"和"之前那个
 * 匿名访客"对上号。
 *
 * 数据来源是**该账号自己的访问记录里携带的 visitor**，而不是去猜"哪个匿名行后来变成了他"：
 * 匿名行没有 user_id，无法归属；而游客编号由浏览器本地生成、**登录前后不变**（见 src/visitorId.ts），
 * 所以他自己行上的编号就是"登录前那个号"。取**最早**一条非空记录：他换过浏览器就会有多个编号，
 * 最早的那个才是"登录前"的身份。
 *
 * 为什么用相关子查询而不是 JOIN + GROUP BY：用户数量级很小（几十行），而每行只需要一个编号，
 * 子查询在有 `idx_access_logs_user` 的情况下是索引点查；JOIN 聚合会把日志表整个拉进来分组，
 * 读的行数反而多得多（D1 按读行数计费）。
 */
export const onRequestGet = handle(
  requireAdmin(async (context) => {
    const env = context.env;

    const rows = await env.DB.prepare(
      `SELECT u.id, u.username, u.hometown, u.avatar, u.is_admin, u.created_at,
              (SELECT l.visitor FROM access_logs l
                WHERE l.user_id = u.id AND l.visitor IS NOT NULL
                ORDER BY l.created_at ASC
                LIMIT 1) AS visitor
       FROM users u
       ORDER BY u.is_admin DESC, u.created_at DESC`,
    ).all<AdminUserRow>();

    const users = (rows.results ?? []).map((r) => ({
      id: r.id,
      username: r.username,
      hometown: parseJson<{ provinceAdcode: string; cityAdcode: string }>(r.hometown),
      avatar: parseJson<{ dataUrl: string }>(r.avatar)?.dataUrl ?? null,
      isAdmin: r.is_admin === 1,
      createdAt: r.created_at,
      /** 登录前用的游客编号（4 位数字串）；查不到（老账号/没有可归属的日志）时为 null。 */
      visitor: r.visitor,
    }));
    return json({ users });
  }),
);
