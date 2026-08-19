/** 每题倒计时（基于截止时间戳，避免 setInterval 漂移） */
export class Countdown {
  private deadline = 0;
  private timer: number | null = null;

  start(seconds: number, onTick: (remain: number) => void, onExpire: () => void) {
    this.stop();
    this.deadline = Date.now() + seconds * 1000;
    const tick = () => {
      const remain = Math.max(0, Math.ceil((this.deadline - Date.now()) / 1000));
      onTick(remain);
      if (remain <= 0) {
        this.stop();
        onExpire();
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
  }
}
