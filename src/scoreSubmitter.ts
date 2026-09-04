import type { AuthStore } from './authStore';
import type { LeaderboardStore } from './leaderboardStore';
import type { AuthPanel } from './ui/authPanel';
import type { RoundResult } from './types';
import { ApiError } from './api';
import { t } from './i18n';

/**
 * 成绩提交编排：登录门控（未登录先挂起结果、登录后补交）+ 云端异步提交 + 结果提示。
 * 从 main.ts 抽出，消除 boot 内联的提交/重试状态机。
 */
export class ScoreSubmitter {
  private pendingResult: RoundResult | null = null;
  private pendingOnDone: (() => void) | null = null;

  constructor(
    private authStore: AuthStore,
    private leaderboardStore: LeaderboardStore,
    private authPanel: AuthPanel,
    private toast: (msg: string) => void,
    private onSubmitted: () => void,
    private rejectToast: (result: RoundResult) => string,
    private canSubmit: (result: RoundResult) => boolean,
  ) {}

  /** 提交成绩；未登录先请求登录，登录成功后自动补交。 */
  submit(result: RoundResult, onDone?: () => void) {
    if (!this.canSubmit(result)) {
      this.toast(this.rejectToast(result));
      return;
    }
    if (!this.authStore.currentUser()) {
      this.pendingResult = result;
      this.pendingOnDone = onDone ?? null;
      this.authPanel.requestLogin(() => this.submitPending());
      this.toast(t('main.loginFirst'));
      return;
    }
    this.submitLeaderboard(result);
    onDone?.();
  }

  /** 登录成功后补交挂起的成绩。 */
  private submitPending() {
    const result = this.pendingResult;
    this.pendingResult = null;
    const onDone = this.pendingOnDone;
    this.pendingOnDone = null;
    if (!result) return;
    if (!this.canSubmit(result)) {
      this.toast(this.rejectToast(result));
      return;
    }
    if (!this.authStore.currentUser()) return;
    this.submitLeaderboard(result);
    onDone?.();
  }

  /** 云端提交：内部异步，对外同步返回（回合立刻重置，提交后台进行）。 */
  private submitLeaderboard(result: RoundResult) {
    const token = this.authStore.sessionToken();
    if (!token) return;
    void (async () => {
      try {
        const status = await this.leaderboardStore.submit(result, token);
        this.onSubmitted();
        this.toast(status === 'kept' ? t('main.keptScore') : t('main.submitted'));
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          this.authStore.clearSession();
          this.toast(t('main.loginExpired'));
          return;
        }
        console.error(err);
        this.toast(t('main.submitFailed'));
      }
    })();
  }
}