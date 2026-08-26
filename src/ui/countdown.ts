/** 每题倒计时（基于截止时间戳，避免 setInterval 漂移），支持暂停/恢复。 */
export class Countdown {
  private deadline = 0;
  private remainingMs = 0;
  private timer: number | null = null;
  private onTick: ((remain: number) => void) | null = null;
  private onExpire: (() => void) | null = null;

  start(seconds: number, onTick: (remain: number) => void, onExpire: () => void) {
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
    this.onTick?.(Math.ceil(this.remainingMs / 1000));
  }

  resume() {
    if (this.timer !== null || !this.onTick || !this.onExpire || this.remainingMs <= 0) return;
    this.deadline = Date.now() + this.remainingMs;
    const tick = () => {
      this.remainingMs = Math.max(0, this.deadline - Date.now());
      const remain = Math.ceil(this.remainingMs / 1000);
      this.onTick?.(remain);
      if (remain <= 0) {
        const expire = this.onExpire;
        this.stop();
        expire?.();
      }
    };
    tick();
    this.timer = window.setInterval(tick, 250);
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
