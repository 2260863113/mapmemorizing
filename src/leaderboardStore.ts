import type { Mode, RoundResult } from './types';
import { api } from './api';

export type LeaderboardMode = Extract<Mode, 'self' | 'click' | 'endless' | 'daily'>;

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

/** 云端排行榜：数据由 Pages Functions + D1 提供，前端只做内存缓存避免高频刷新打爆 API。 */
export class LeaderboardStore {
  private cache = new Map<string, Promise<LeaderboardEntry[]>>();

  private key(mode: LeaderboardMode, scopeProvince: string | null) {
    return `${mode}:${scopeProvince ?? ''}`;
  }

  /** 取榜单；命中缓存不重复请求，失败不入缓存以便下次重试。 */
  ensure(mode: LeaderboardMode, scopeProvince: string | null): Promise<LeaderboardEntry[]> {
    const k = this.key(mode, scopeProvince);
    const hit = this.cache.get(k);
    if (hit) return hit;
    const promise = api
      .leaderboard(mode, scopeProvince)
      .then((r) => r.entries)
      .catch((err) => {
        this.cache.delete(k);
        throw err;
      });
    this.cache.set(k, promise);
    return promise;
  }

  /** 提交成绩到云端；成功使该组缓存失效（下次 refresh 拉新）。 */
  async submit(result: RoundResult, token: string): Promise<SubmitResult> {
    const res = await api.submitScore(token, result);
    this.cache.delete(this.key(result.mode, result.scopeProvince));
    return res.status;
  }
}
