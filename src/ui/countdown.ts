/** 每题倒计时（基于截止时间戳，避免 setInterval 漂移），支持暂停/恢复。 */
export class Countdown {
  private deadline = 0;
  private remainingMs = 0;
  private timer: number | null = null;
  private onTick: ((remainingMs: number) => void) | null = null;
  private onExpire: (() => void) | null = null;

  start(seconds: number, onTick: (remainingMs: number) => void, onExpire: () => void) {
    this.stop();
    this.remainingMs = seconds * 1000;
    this.onTick = onTick;
    this.onExpire = onExpire;
    this.resume();
  }

  pause() {
    if (this.timer === null) return;
    this.remainingMs = Math.max(0, this.deadline - Date.now());
    window.clearInterval(this.timer);
    this.timer = null;
    this.onTick?.(this.remainingMs);
  }

  resume() {
    if (this.timer !== null || !this.onTick || !this.onExpire || this.remainingMs <= 0) return;
    this.deadline = Date.now() + this.remainingMs;
    const tick = () => {
      this.remainingMs = Math.max(0, this.deadline - Date.now());
      const remain = Math.ceil(this.remainingMs / 1000);
      this.onTick?.(this.remainingMs);
      if (remain <= 0) {
        const expire = this.onExpire;
        this.stop();
        expire?.();
      }
    };
    tick();
    this.timer = window.setInterval(tick, 10);
  }

  remaining() {
    return this.timer === null ? this.remainingMs : Math.max(0, this.deadline - Date.now());
  }

  /** 惩罚扣减：从剩余时间中减去指定毫秒数（到达 0 后由下一次 tick 触发到期）。 */
  penalize(ms: number) {
    if (this.timer === null || ms <= 0) return;
    const remain = Math.max(0, this.deadline - Date.now());
    this.remainingMs = Math.max(0, remain - ms);
    this.deadline = Date.now() + this.remainingMs;
    this.onTick?.(this.remainingMs);
  }

  /** 奖励增加：往剩余时间中追加指定毫秒数（时间沙漏）。 */
  add(ms: number) {
    if (this.timer === null || ms <= 0) return;
    const remain = Math.max(0, this.deadline - Date.now());
    this.remainingMs = remain + ms;
    this.deadline = Date.now() + this.remainingMs;
    this.onTick?.(this.remainingMs);
  }

  stop() {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    this.deadline = 0;
    this.remainingMs = 0;
    this.onTick = null;
    this.onExpire = null;
  }
}
