import type { RoundResult } from './types';
import { api } from './api';
import type { LeaderboardMode } from './modes/capabilities';

// 排行榜模式集的定义在 modes/capabilities.ts（与「哪些模式有排行榜」的判定同一处），
// 这里只是转出，供排行榜相关模块沿用既有导入路径。
export type { LeaderboardMode };

export interface LeaderboardEntry {
  id: string;
  username: string;
  mode: LeaderboardMode;
  scopeProvince: string | null;
  scopeLabel: string;
  totalUnits: number;
  correct: number;
  elapsedMs: number;
  submittedAt: number;
  /** 无尽闯关：累计收集金币 */
  coins?: number;
  /** 无尽闯关：到达关卡 */
  level?: number;
  /** 用户所在地 adcode 对（个人资料填写），未填写为 null */
  hometown: { provinceAdcode: string; cityAdcode: string } | null;
  /** 用户头像 dataUrl，未填写为 null */
  avatar: string | null;
}

export type SubmitResult = 'added' | 'improved' | 'kept';

/** 单次榜单请求的超时（毫秒）。 */
export const LEADERBOARD_TIMEOUT_MS = 8000;

/**
 * 快照的「新鲜期」（毫秒）：期内重复刷新直接复用快照，不再打一次接口。
 *
 * 存在的理由：侧栏刷新有五个触发点（切模式、视图变化、范围按钮、侧栏开关、提交成功），
 * 一次用户操作常常同时命中两三个，没有这个窗口就会在同一瞬间发出多条等价请求。
 */
export const LEADERBOARD_FRESH_MS = 2000;

/**
 * 云端排行榜：数据由 Pages Functions + D1 提供。
 *
 * **职责边界**：这里只管「拿到数据」，不管怎么画——`LeaderboardPanel` 负责渲染。
 *
 * 与旧实现的区别（旧实现把 Promise 当缓存永久存着，命中就再也不会重取）：
 *   1. 快照只服务于**显示**（用户口径：看过的范围切回去要"秒显"），不再阻止重新请求，
 *      所以别人新提交的成绩这次也能看到，不必刷新整个页面；
 *   2. 同一 (mode, scope) 的**并发**刷新仍合并成一次网络请求；
 *   3. 请求带超时：旧实现里一个卡住的请求会让这个范围**整个会话**再也刷不出来
 *      （Promise 挂在缓存里既不 resolve 也不 reject，也就永远不被清掉）。
 */
export class LeaderboardStore {
  /** 已取回的榜单快照：面板用它实现「切回看过的范围立刻显示」。 */
  private snapshots = new Map<string, { rows: LeaderboardEntry[]; at: number }>();
  /** 进行中的请求：同一 (mode, scope) 的并发刷新合并成一次。 */
  private inflight = new Map<string, Promise<LeaderboardEntry[]>>();

  /** 三个依赖都可注入，便于单测控制超时与时钟。 */
  constructor(
    private readonly timeoutMs: number = LEADERBOARD_TIMEOUT_MS,
    private readonly freshMs: number = LEADERBOARD_FRESH_MS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private key(mode: LeaderboardMode, scopeProvince: string | null) {
    return `${mode}:${scopeProvince ?? ''}`;
  }

  /**
   * 已有快照（**同步**返回）。面板先用它渲染，未命中才显示「加载中」——
   * 这样切换范围时屏幕上绝不会继续留着上一个范围的名单。
   */
  peek(mode: LeaderboardMode, scopeProvince: string | null): LeaderboardEntry[] | null {
    return this.snapshots.get(this.key(mode, scopeProvince))?.rows ?? null;
  }

  /** 取榜单并发（供自动刷新调用）。 */
  ensure(mode: LeaderboardMode, scopeProvince: string | null): Promise<LeaderboardEntry[]> {
    const k = this.key(mode, scopeProvince);
    const running = this.inflight.get(k);
    if (running) return running;
    const cached = this.snapshots.get(k);
    if (cached && this.now() - cached.at < this.freshMs) return Promise.resolve(cached.rows);

    // 无条件删除是安全的：同一 key 在飞的时候 `ensure()` 只会返回那一个 Promise，不会起第二个请求；
    // 而 `.finally` 的回调排在**调用方 continuation 之前**执行，所以迟到的删除不会误删新请求的槽位。
    const promise = this.request(mode, scopeProvince, k).finally(() => {
      this.inflight.delete(k);
    });
    this.inflight.set(k, promise);
    return promise;
  }

  /** 带超时的单次请求：超时即释放并发槽，且**迟到**的响应一律丢弃（绝不写进快照）。 */
  private request(
    mode: LeaderboardMode,
    scopeProvince: string | null,
    k: string,
  ): Promise<LeaderboardEntry[]> {
    return new Promise<LeaderboardEntry[]>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('leaderboard request timeout'));
      }, this.timeoutMs);
      api.leaderboard(mode, scopeProvince).then(
        (r) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.snapshots.set(k, { rows: r.entries, at: this.now() });
          resolve(r.entries);
        },
        (err: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        },
      );
    });
  }

  /** 提交成绩到云端；成功即作废该范围的快照，让紧随其后的刷新真正拉到新数据。 */
  async submit(result: RoundResult, token: string): Promise<SubmitResult> {
    const res = await api.submitScore(token, result);
    this.snapshots.delete(this.key(result.mode, result.scopeProvince));
    return res.status;
  }
}
