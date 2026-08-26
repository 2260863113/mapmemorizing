/** 可暂停的正向计时器，按 10ms 刷新显示，时间基准使用 performance.now。 */
export class Stopwatch {
  private elapsed = 0;
  private startedAt = 0;
  private timer: number | null = null;
  private onTick: ((elapsedMs: number) => void) | null = null;

  start(onTick: (elapsedMs: number) => void) {
    this.stop();
    this.onTick = onTick;
    this.elapsed = 0;
    this.startedAt = performance.now();
    this.emit();
    this.timer = window.setInterval(() => this.emit(), 10);
  }

  pause() {
    if (!this.startedAt) return;
    this.elapsed += performance.now() - this.startedAt;
    this.startedAt = 0;
    this.clearTimer();
    this.emit();
  }

  resume() {
    if (this.startedAt || !this.onTick) return;
    this.startedAt = performance.now();
    this.emit();
    this.timer = window.setInterval(() => this.emit(), 10);
  }

  stop() {
    this.clearTimer();
    this.elapsed = 0;
    this.startedAt = 0;
    this.onTick = null;
  }

  elapsedMs() {
    return this.elapsed + (this.startedAt ? performance.now() - this.startedAt : 0);
  }

  private emit() {
    this.onTick?.(this.elapsedMs());
  }

  private clearTimer() {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
  }
}
