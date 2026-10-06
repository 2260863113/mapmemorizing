/**
 * 游玩上报（`POST /api/play`）：用户**开始一局**时记一条，供管理端「游玩统计」按来源计数。
 *
 * ## 为什么单独成模块
 *
 * 上报点有两个（点「开始」与按 Tab 快速重开），且都要满足三条约束：
 *   1. **永不抛错**：网络/接口故障不能影响玩法（用户按了开始就该开始）；
 *   2. **不产生未处理的 Promise 拒绝**：`api.play` 是异步的，调用点若忘了 `.catch`
 *      会在控制台刷红字（甚至被测试/监控当成故障）；
 *   3. **带浏览器环境**：管理端要展示完整设备环境并据此判爬虫，而环境只有前端能采
 *      （`collectClientEnv` 本身也永不抛错）。
 *
 * 这三点在每个调用点各写一遍 try/catch + catch 就会重复；收在这里之后 `AppController`
 * 只需一行 `reportPlay(mode, 'start')` —— 上报失败的影响面被限制在这一个文件里。
 *
 * ## 为什么不 `await`
 *
 * 上报是**旁路**：它不该拖慢开局（等一个网络往返再出题会让 Tab 看起来卡住），
 * 故发出请求即返回，失败只 `console.warn`。管理端统计丢一两条是可以接受的，
 * 而"按了开始没反应"不可接受。
 */
import { api } from './api';
import type { PlaySource } from './api';
import { collectClientEnv } from './clientEnv';
import { visitorId } from './visitorId';

/**
 * 上报一次游玩。
 *
 * @param mode   当前模式 id（服务端白名单：self/click/endless/puzzle）。
 * @param source `start` = 点「开始」按钮；`tab` = 按 Tab 快速重开。
 * @param token  会话 token（未登录时 undefined，服务端按匿名记录）。
 * @param scope  出题范围（2026-10 需求 5）：标识 + 展示名，供管理端按范围统计。
 *               没有范围概念的模式（无尽闯关）传 `null`，服务端存 NULL、前端显示占位。
 */
export function reportPlay(
  mode: string,
  source: PlaySource,
  token?: string,
  scope?: { scopeProvince: string | null; scopeLabel: string | null },
): void {
  try {
    void api
      .play(
        {
          mode,
          source,
          env: collectClientEnv(),
          visitor: visitorId() ?? undefined,
          scopeProvince: scope?.scopeProvince ?? null,
          scopeLabel: scope?.scopeLabel ?? null,
        },
        token,
      )
      .catch((err: unknown) => console.warn('[play] 游玩上报失败（不影响玩法）', err));
  } catch (err) {
    // api.play 本身在极端情况下也可能同步抛（例如请求参数序列化失败）：同样不能影响玩法
    console.warn('[play] 游玩上报异常（不影响玩法）', err);
  }
}
