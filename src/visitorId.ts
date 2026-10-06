/**
 * 游客编号（4 位数字，如 `1234`）—— 2026-10 需求 3。
 *
 * ## 口径
 *
 * 未登录的访问在管理端显示成「游客1234」/「爬虫1234」，用于**区分不同游客**；
 * 「同一个浏览器，每次访问时后面的四位数字保持不变」。
 *
 * ## 为什么用 localStorage 而不是服务端生成
 *
 * 「同一个浏览器保持不变」这条要求决定了号必须**存在这个浏览器里**：
 *   · 服务端每次请求时随机生成 → 同一个游客会被记成几十个不同的人，完全失去区分作用；
 *   · 按 IP/UA 派生 → 同一办公室/同一运营商出口的人会撞成一个号，换网络又变成另一个人；
 *   · localStorage 是唯一能表达"这台浏览器"的地方，也是口令之外唯一被"用户自己"持有的状态。
 *
 * ## 已知边界（都是刻意的取舍）
 *
 * · **无痕模式 / 禁用存储 / 每次清缓存** → 每次得到新号（那就真是"看起来像个新游客"）；
 *   `localStorage` 抛错时本模块返回 `null`，管理端退化成显示「游客」而不显示编号，不抛错、不重试。
 * · **爬虫**通常不执行 JS、也没有 localStorage → 不上报编号，同样退化成「爬虫」/「游客」。
 * · 9000 个可能值（1000–9999）**会碰撞**：两个人可能拿到同一个号。这是刻意的 ——
 *   它只是给人眼看的区分标签，不是身份标识（真正的身份是登录账号），不值得为它引入指纹或哈希。
 */

/** 存储键（带前缀，避免与项目其它 localStorage 键冲突）。 */
export const VISITOR_ID_KEY = 'china-admin-visitor-v1';

/** 合法编号：恰好 4 位数字，与后端 `sanitizeVisitorId` 的白名单**逐字一致**。 */
const VISITOR_ID_RE = /^\d{4}$/;

/** 进程内缓存：同一次页面生命周期内只在首次调用时读一次存储。 */
let cached: string | null | undefined;

/** 生成一个 1000–9999 的编号（不出现前导零，永远是 4 位）。 */
function randomVisitorId(): string {
  return String(1000 + Math.floor(Math.random() * 9000));
}

/**
 * 取当前浏览器的游客编号；存储不可用时返回 `null`（调用方按"没有编号"处理）。
 *
 * 首次调用会生成并写入；之后（含刷新）读到的是同一个号。
 */
export function visitorId(): string | null {
  if (cached !== undefined) return cached;
  try {
    const saved = localStorage.getItem(VISITOR_ID_KEY);
    if (saved && VISITOR_ID_RE.test(saved)) {
      cached = saved;
      return cached;
    }
    const created = randomVisitorId();
    localStorage.setItem(VISITOR_ID_KEY, created);
    cached = created;
    return cached;
  } catch {
    // 无痕/禁用存储：不写、不抛，之后每次调用都走这条分支（cached 保持 undefined 会反复尝试，
    // 故这里明确记成 null，避免每次上报都做一次必然失败的存储访问）
    cached = null;
    return null;
  }
}

/** 测试用：注入/清空缓存与存储（生产路径不调用）。 */
export function setVisitorIdForTest(value: string | null | undefined): void {
  cached = value;
}
