import type { Mode, Unit } from '../types';
import type { ModeCtx, ModeController } from './types';
import { Countdown } from '../ui/countdown';
import { formatElapsedSeconds } from '../ui/format';

/**
 * 无尽闯关：
 * 每关限时 45 秒，输入地级市名称收集金币；达到本关目标金币立即通关进入下一关，
 * 超时未达标则游戏结束。累计金币跨关保留，未收集城市的金币每关按规则上浮。
 * 初始金币基于柏林噪声生成（100-500），相邻地级市平滑过渡。
 * 地图仅两种色调：原色（无金币）与绿色（金币越多越深）；中心标注金币数，收集后显示地名。
 */
export class EndlessMode implements ModeController {
  id: Mode = 'endless';
  title = '无尽闯关';
  private coins = new Map<string, number>(); // 当前金币数（0 = 已收集过）
  private collected = new Set<string>(); // 本局累计已收集
  private collectedThisLevel = new Set<string>(); // 当前关已收集（下一关清空）
  private level = 1;
  private target = 0;
  private levelCoins = 0;
  private totalCoins = 0;
  private started = false;
  private paused = false;
  private switching = false; // 关卡切换缓冲期
  private runStartAt = 0;
  private countdown = new Countdown();
  private switchTimer: number | null = null;
  private perm: Uint8Array;
  private syncingView = false;

  constructor(private ctx: ModeCtx) {
    this.perm = makePermutation(COIN_NOISE_SEED);
  }

  enter() {
    if (this.paused) {
      this.syncScope();
      this.ctx.search.setPlaceholder('输入地级市名称，如：黔南');
      this.ctx.search.setRequireEnter(true);
      this.ctx.setHint(this.statusHtml());
      this.refresh();
      this.ctx.showTimer(this.countdown.remaining());
      this.ctx.updateProgress();
      this.ctx.search.clear();
      return;
    }
    this.exit();
    this.resetRun();
    this.ctx.search.setPlaceholder('输入地级市名称，如：黔南');
    this.ctx.search.setRequireEnter(true);
    this.syncScope();
    this.showStartHint();
    this.refresh();
    this.ctx.updateProgress();
    this.ctx.search.clear();
  }

  exit() {
    this.countdown.stop();
    if (this.switchTimer !== null) {
      window.clearTimeout(this.switchTimer);
      this.switchTimer = null;
    }
    this.ctx.showTimer(null);
    this.ctx.search.setRequireEnter(this.ctx.settings.requireEnter);
    this.started = false;
    this.paused = false;
  }

  pause() {
    if (!this.started || this.paused || this.switching) return;
    this.paused = true;
    this.countdown.pause();
    if (this.switchTimer !== null) {
      window.clearTimeout(this.switchTimer);
      this.switchTimer = null;
    }
    this.ctx.showTimer(this.countdown.remaining());
  }

  resume() {
    if (!this.started || !this.paused) return;
    this.paused = false;
    this.countdown.resume();
    this.ctx.setHint(this.statusHtml());
  }

  isPaused() {
    return this.paused;
  }

  refresh() {
    this.ctx.renderer.render({
      colorOf: () => 'gray',
      labelZoomThreshold: COIN_LABEL_ZOOM,
      coin: {
        coins: (adcode) => this.coins.get(adcode) ?? 0,
        label: (adcode) => this.labelOf(adcode),
      },
    });
  }

  hasProgress() {
    return this.started || this.collected.size > 0;
  }

  getProgress() {
    return null; // 无尽闯关不使用逐单位进度条
  }

  isStarted() {
    return this.started;
  }

  getScopeProvince() {
    return null; // 全国固定范围，不下钻
  }

  onSubmit(v: string) {
    if (!this.started || this.paused || this.switching || !v.trim()) return;
    const best = this.ctx.matcher.bestUnit(v);
    if (!best) {
      this.ctx.toast('未匹配到有效地名');
      return;
    }
    if (this.collected.has(best.adcode)) {
      this.ctx.toast('该城市金币已收集过');
      return;
    }
    const value = this.coins.get(best.adcode) ?? 0;
    if (value <= 0) {
      this.ctx.toast('该城市金币已收集过');
      return;
    }
    this.collect(best, value);
  }

  onInput() {
    /* 无尽闯关必须按 Enter 确认，不做实时输入判定 */
  }

  onUnitClick() {
    return true; // 拦截下钻，固定全国视图
  }

  onUnitDblClick() {
    this.ctx.toast('无尽闯关不支持下钻省份');
  }

  onSkip() {
    /* 无跳过 */
  }

  onEnd() {
    this.pause();
  }

  onReset() {
    this.countdown.stop();
    this.ctx.showTimer(null);
    if (this.switchTimer !== null) {
      window.clearTimeout(this.switchTimer);
      this.switchTimer = null;
    }
    this.resetRun();
    this.enter();
  }

  onViewChange() {
    if (this.syncingView) return;
    if (this.ctx.renderer.currentProvince() !== null) {
      this.syncingView = true;
      this.ctx.renderer.backToNation();
      this.syncingView = false;
    }
  }

  // ---------- 内部 ----------

  private syncScope() {
    if (this.ctx.renderer.currentProvince() !== null) this.ctx.renderer.backToNation();
  }

  private resetRun() {
    this.level = 1;
    this.target = 0;
    this.levelCoins = 0;
    this.totalCoins = 0;
    this.runStartAt = 0;
    this.collected.clear();
    this.collectedThisLevel.clear();
    this.coins.clear();
    this.started = false;
    this.paused = false;
    this.switching = false;
    if (this.switchTimer !== null) {
      window.clearTimeout(this.switchTimer);
      this.switchTimer = null;
    }
  }

  private showStartHint() {
    const actions = '<button id="endless-start" class="start-action">开始</button>';
    this.ctx.setHint(
      `<div class="start-panel">` +
        `<div class="start-title">无尽闯关</div>` +
        `<div class="start-subtitle">每关限时 ${LEVEL_SECONDS} 秒，输入地级市名称收集金币（按 Enter 确认）</div>` +
        `<div class="start-subtitle">放大地图查看金币数，绿色越深金币越多；达到目标金币即进入下一关</div>` +
        `<div class="start-subtitle">累计金币跨关保留，未收集城市的金币每关会增长</div>` +
        actions +
        `</div>`,
    );
    window.setTimeout(() => {
      const start = document.getElementById('endless-start') as HTMLButtonElement | null;
      if (start) start.onclick = () => this.start();
    }, 0);
  }

  private start() {
    if (this.started || this.paused || this.switching) return;
    this.syncScope();
    this.level = 1;
    this.collected.clear();
    this.collectedThisLevel.clear();
    this.totalCoins = 0;
    this.levelCoins = 0;
    this.coins = this.generateCoins();
    this.target = this.targetFor(1);
    this.runStartAt = Date.now();
    this.started = true;
    this.paused = false;
    this.ctx.setHint(this.statusHtml());
    this.ctx.search.clear();
    this.ctx.search.focus();
    this.refresh();
    this.countdown.start(LEVEL_SECONDS, (r) => this.showCountdown(r), () => this.onLevelTimeout());
  }

  private showCountdown(remainingMs: number) {
    this.ctx.showTimer(remainingMs, remainingMs < 10_000);
  }

  private onLevelTimeout() {
    if (!this.started || this.paused || this.switching) return;
    this.countdown.stop();
    this.ctx.showTimer(null);
    if (this.levelCoins >= this.target) {
      this.passLevel();
      return;
    }
    this.gameOver();
  }

  private collect(unit: Unit, value: number) {
    this.coins.set(unit.adcode, 0);
    this.collected.add(unit.adcode);
    this.collectedThisLevel.add(unit.adcode);
    this.levelCoins += value;
    this.totalCoins += value;
    this.ctx.search.clear();
    this.ctx.search.focus();
    this.refresh();
    this.ctx.renderer.flash(unit.adcode);
    if (this.levelCoins >= this.target) {
      this.ctx.toast(`收集成功 +${fmt(value)}￥，达成目标！`);
      this.passLevel();
      return;
    }
    this.ctx.toast(`收集成功：${unit.name} +${fmt(value)}￥`);
    this.ctx.setHint(this.statusHtml());
  }

  private passLevel() {
    this.countdown.stop();
    this.ctx.showTimer(null);
    this.switching = true;
    this.floatUpCoins();
    this.level += 1;
    this.target = this.targetFor(this.level);
    this.levelCoins = 0;
    this.collectedThisLevel.clear();
    this.refresh();
    this.ctx.setHint(this.statusHtml());
    this.ctx.search.clear();
    this.ctx.toast(`通关！进入第 ${this.level} 关`);
    this.switchTimer = window.setTimeout(() => {
      this.switchTimer = null;
      this.switching = false;
      if (!this.started || this.paused) return;
      this.countdown.start(LEVEL_SECONDS, (r) => this.showCountdown(r), () => this.onLevelTimeout());
    }, SWITCH_DELAY_MS);
  }

  private gameOver() {
    this.countdown.stop();
    if (this.switchTimer !== null) {
      window.clearTimeout(this.switchTimer);
      this.switchTimer = null;
    }
    this.ctx.showTimer(null);
    this.started = false;
    this.paused = false;
    this.switching = false;
    this.ctx.updateProgress();
    const elapsedMs = this.runStartAt ? Date.now() - this.runStartAt : 0;
    this.ctx.showSummary(
      `闯关结束<div class="sum-stats">到达第 <b>${this.level}</b> 关 ｜ 累计金币 <b>${fmt(this.totalCoins)}￥</b> ｜ 收集城市 <b>${this.collected.size}</b> 个 ｜ 用时 ${formatElapsedSeconds(elapsedMs)}</div>`,
      () => this.enter(),
    );
    this.showStartHint();
    this.ctx.search.clear();
  }

  private statusHtml() {
    return (
      `<div class="endless-status">` +
      `<span>第 <b>${this.level}</b> 关</span>` +
      `<span>本关 <b>${fmt(this.levelCoins)} / ${fmt(this.target)}</b> ￥</span>` +
      `<span>累计 <b>${fmt(this.totalCoins)}</b> ￥</span>` +
      `<span>已收 <b>${this.collected.size}</b> 城</span>` +
      `</div>`
    );
  }

  private labelOf(adcode: string): string | null {
    const c = this.coins.get(adcode) ?? 0;
    if (c > 0) return `${fmt(c)}￥`;
    if (this.collectedThisLevel.has(adcode)) {
      const u = this.ctx.byAdcode.get(adcode);
      return u?.name ?? null;
    }
    return null;
  }

  /** 基于柏林噪声生成全国地级市初始金币（100-500，相邻平滑过渡）。 */
  private generateCoins(): Map<string, number> {
    const map = new Map<string, number>();
    for (const u of this.ctx.data.units) {
      const n = fbm((u.center[0] + 180) / COIN_NOISE_SCALE, (u.center[1] + 90) / COIN_NOISE_SCALE, 3, this.perm);
      const value = clamp(Math.round(COIN_MIN + ((n + 1) / 2) * (COIN_MAX - COIN_MIN)), COIN_MIN, COIN_MAX);
      map.set(u.adcode, Math.round(value / 10) * 10);
    }
    return map;
  }

  /** 跨关上浮：未收集城市按当前金币区间增加金币。 */
  private floatUpCoins() {
    for (const [adcode, coins] of this.coins) {
      if (coins <= 0) continue; // 已收集，不再上浮
      let inc: number;
      if (coins < 100) inc = randMultipleOf10(30, 50);
      else if (coins < 300) inc = randMultipleOf10(20, 40);
      else if (coins < 500) inc = randMultipleOf10(10, 30);
      else inc = randMultipleOf10(5, 15);
      this.coins.set(adcode, coins + inc);
    }
  }

  private targetFor(level: number) {
    const raw = BASE_TARGET * Math.pow(TARGET_GROWTH, level - 1);
    return Math.round(raw / 50) * 50;
  }
}

// ---------- 常量 ----------
const LEVEL_SECONDS = 45;
const BASE_TARGET = 1000; // 第一关目标金币
const TARGET_GROWTH = 1.08; // 目标金币每关增幅
const COIN_MIN = 100;
const COIN_MAX = 500;
const COIN_NOISE_SCALE = 6; // 经/纬度噪声尺度（越小变化越频繁）
const COIN_NOISE_SEED = 20260829;
const COIN_LABEL_ZOOM = 2; // 金币标签显示倍率阈值
const SWITCH_DELAY_MS = 1200; // 通关切换缓冲

// ---------- 工具 ----------
function fmt(n: number) {
  return Math.round(n).toLocaleString('zh-CN');
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function randInt(min: number, max: number) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function randMultipleOf10(min: number, max: number) {
  const lo = Math.ceil(min / 10);
  const hi = Math.floor(max / 10);
  return randInt(lo, hi) * 10;
}

// ---------- 柏林噪声（种子化，确定性） ----------
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makePermutation(seed: number): Uint8Array {
  const rand = mulberry32(seed);
  const perm = new Uint8Array(512);
  const base = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = base[i];
    base[i] = base[j];
    base[j] = tmp;
  }
  for (let i = 0; i < 512; i++) perm[i] = base[i & 255];
  return perm;
}

function fade(t: number) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function grad2(hash: number, x: number, y: number): number {
  switch (hash & 7) {
    case 0: return x + y;
    case 1: return -x + y;
    case 2: return x - y;
    case 3: return -x - y;
    case 4: return x;
    case 5: return -x;
    case 6: return y;
    default: return -y;
  }
}

function perlin2(x: number, y: number, perm: Uint8Array): number {
  const xi = Math.floor(x) & 255;
  const yi = Math.floor(y) & 255;
  const xf = x - Math.floor(x);
  const yf = y - Math.floor(y);
  const u = fade(xf);
  const v = fade(yf);
  const aa = perm[perm[xi] + yi];
  const ab = perm[perm[xi] + yi + 1];
  const ba = perm[perm[xi + 1] + yi];
  const bb = perm[perm[xi + 1] + yi + 1];
  const x1 = lerp(grad2(aa, xf, yf), grad2(ba, xf - 1, yf), u);
  const x2 = lerp(grad2(ab, xf, yf - 1), grad2(bb, xf - 1, yf - 1), u);
  return lerp(x1, x2, v);
}

function fbm(x: number, y: number, octaves: number, perm: Uint8Array): number {
  let value = 0;
  let amp = 0.5;
  let freq = 1;
  let max = 0;
  for (let i = 0; i < octaves; i++) {
    value += amp * perlin2(x * freq, y * freq, perm);
    max += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return value / max;
}
