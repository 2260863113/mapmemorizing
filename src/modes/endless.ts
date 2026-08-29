import type { Mode, Unit } from '../types';
import type { ModeCtx, ModeController } from './types';
import { Countdown } from '../ui/countdown';
import { endlessStatus, flashTimerPenalty, hideLevelEnd, showLevelEnd } from '../ui/dom';
import { formatElapsedSeconds } from '../ui/format';

/**
 * 无尽闯关：
 * 每关限时 45 秒，输入地级市名称收集金币。每关以「时间结束」为结束条件，
 * 结束时本关金币达到目标则展示通关卡片，点击「继续」进入下一关，否则游戏结束。
 * 累计金币跨关保留；每个地级市收集后下一关恢复（按区间随机上浮）可再次收集。
 * 初始金币基于柏林噪声生成（约 50-400，多数低于 250，~150 常见），相邻地级市平滑过渡。
 * 地图仅两种色调：原色（无金币）与绿色（金币越多越深，0￥→原色，500￥→最深绿）；
 * 中心标注金币数，收集后显示地名（仅当前关）。
 */
export class EndlessMode implements ModeController {
  id: Mode = 'endless';
  title = '无尽闯关';
  private coins = new Map<string, number>(); // 当前金币数（0 = 本关已收集，下一关恢复）
  private collectedThisLevel = new Set<string>(); // 本关已收集（用于显示地名）
  private level = 1;
  private target = 0;
  private levelCoins = 0;
  private totalCoins = 0;
  private totalCollects = 0; // 累计收集次数（含跨关重复收集）
  private targetHit = false; // 本关是否已达成目标（仅提示用）
  private started = false;
  private paused = false;
  private switching = false; // 通关卡片展示期（拦截输入/暂停）
  private runStartAt = 0;
  private countdown = new Countdown();
  private perm: Uint8Array = makePermutation(randomSeed());
  private syncingView = false;
  private hidePrices = loadHidePrices(); // 隐藏价格标签

  constructor(private ctx: ModeCtx) {}

  enter() {
    if (this.paused) {
      this.syncScope();
      this.ctx.setHint(''); // 清除其他模式遗留的开始卡片
      this.ctx.search.setPlaceholder('输入地名');
      this.ctx.search.setRequireEnter(true);
      endlessStatus(this.statusHtml());
      this.refresh();
      this.ctx.showTimer(this.countdown.remaining());
      this.ctx.updateProgress();
      this.ctx.search.clear();
      return;
    }
    this.exit();
    this.resetRun();
    this.ctx.search.setPlaceholder('输入地名');
    this.ctx.search.setRequireEnter(true);
    this.syncScope();
    this.showStartHint();
    this.refresh();
    this.ctx.updateProgress();
    this.ctx.search.clear();
  }

  exit() {
    this.countdown.stop();
    this.ctx.showTimer(null);
    this.ctx.search.setRequireEnter(this.ctx.settings.requireEnter);
    hideLevelEnd();
    endlessStatus('');
    this.started = false;
    this.paused = false;
  }

  pause() {
    if (!this.started || this.paused || this.switching) return;
    this.paused = true;
    this.countdown.pause();
    this.ctx.showTimer(this.countdown.remaining());
  }

  resume() {
    if (!this.started || !this.paused) return;
    this.paused = false;
    this.countdown.resume();
    endlessStatus(this.statusHtml());
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
    return this.started || this.totalCollects > 0;
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

  /** 隐藏价格标签开关（无尽设置卡片）。 */
  setHidePrices(hidden: boolean) {
    this.hidePrices = hidden;
    saveHidePrices(hidden);
    if (this.started) this.refresh();
  }

  isHidePrices() {
    return this.hidePrices;
  }

  onSubmit(v: string) {
    if (!this.started || this.paused || this.switching || !v.trim()) return;
    const best = this.ctx.matcher.bestUnit(v);
    if (!best) {
      this.ctx.toast('匹配失败，惩罚时5秒！');
      this.penalize(5);
      return;
    }
    const value = this.coins.get(best.adcode) ?? 0;
    if (value <= 0) {
      this.ctx.toast('该城市金币本关已收集');
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
    hideLevelEnd();
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
    this.totalCollects = 0;
    this.targetHit = false;
    this.runStartAt = 0;
    this.collectedThisLevel.clear();
    this.coins.clear();
    this.started = false;
    this.paused = false;
    this.switching = false;
    hideLevelEnd();
    endlessStatus('');
  }

  private showStartHint() {
    const actions = '<button id="endless-start" class="start-action">开始</button>';
    this.ctx.setHint(`<div class="start-panel"><div class="start-title">无尽闯关</div><div class="start-subtitle">范围：全国</div>${actions}</div>`);
    window.setTimeout(() => {
      const start = document.getElementById('endless-start') as HTMLButtonElement | null;
      if (start) start.onclick = () => this.start();
    }, 0);
  }

  private start() {
    if (this.started || this.paused || this.switching) return;
    this.syncScope();
    this.ctx.setHint(''); // 点击开始后隐藏开始卡片
    this.perm = makePermutation(randomSeed()); // 每轮重新生成噪声，起始分布不重复
    this.level = 1;
    this.collectedThisLevel.clear();
    this.totalCoins = 0;
    this.levelCoins = 0;
    this.totalCollects = 0;
    this.targetHit = false;
    this.coins = this.generateCoins();
    this.target = this.cumulativeTarget(1);
    this.runStartAt = Date.now();
    this.started = true;
    this.paused = false;
    this.switching = false;
    endlessStatus(this.statusHtml());
    this.ctx.search.clear();
    this.ctx.search.focus();
    this.refresh();
    this.countdown.start(LEVEL_SECONDS, (r) => this.showCountdown(r), () => this.onLevelTimeout());
  }

  private showCountdown(remainingMs: number) {
    this.ctx.showTimer(remainingMs, remainingMs < 10_000);
  }

  /** 每关结束条件 = 时间结束；结束时按是否达标决定通关或结束。 */
  private onLevelTimeout() {
    if (!this.started || this.paused || this.switching) return;
    this.countdown.stop();
    this.ctx.showTimer(null);
    if (this.totalCoins >= this.target) {
      this.showLevelEnd();
      return;
    }
    this.gameOver();
  }

  private collect(unit: Unit, value: number) {
    this.coins.set(unit.adcode, 0);
    this.collectedThisLevel.add(unit.adcode);
    this.levelCoins += value;
    this.totalCoins += value;
    this.totalCollects += 1;
    this.ctx.search.clear();
    this.ctx.search.focus();
    this.refresh();
    this.ctx.renderer.flash(unit.adcode);
    if (!this.targetHit && this.totalCoins >= this.target) {
      this.targetHit = true;
      this.ctx.toast(`已达成目标：${fmt(this.target)}￥，剩余时间可继续收集金币`);
    } else {
      this.ctx.toast(`收集成功：${unit.name} +${fmt(value)}￥`);
    }
    endlessStatus(this.statusHtml());
  }

  /** 匹配失败惩罚：倒计时扣减指定秒数并让倒计时卡片闪烁变红。 */
  private penalize(seconds: number) {
    this.countdown.penalize(seconds * 1000);
    flashTimerPenalty();
  }

  /** 达标通关：屏幕中心展示通关卡片，点击「继续」进入下一关。 */
  private showLevelEnd() {
    this.switching = true;
    endlessStatus('');
    showLevelEnd(
      `<div class="level-end-title">第 ${this.level} 关完成</div>` +
        `<div class="sum-stats">累计目标：<b>${fmt(this.target)}￥</b></div>` +
        `<div class="sum-stats">累计收集：<b>${fmt(this.totalCoins)}￥</b></div>` +
        `<div class="sum-stats">本关收集：<b>${fmt(this.levelCoins)}￥</b></div>`,
      () => this.nextLevel(),
    );
  }

  private nextLevel() {
    this.switching = false;
    this.floatUpCoins();
    this.level += 1;
    this.target = this.cumulativeTarget(this.level);
    this.levelCoins = 0;
    this.targetHit = false;
    this.collectedThisLevel.clear();
    endlessStatus(this.statusHtml());
    this.ctx.search.clear();
    this.ctx.search.focus();
    this.refresh();
    this.countdown.start(LEVEL_SECONDS, (r) => this.showCountdown(r), () => this.onLevelTimeout());
  }

  private gameOver() {
    this.countdown.stop();
    this.ctx.showTimer(null);
    hideLevelEnd();
    this.started = false;
    this.paused = false;
    this.switching = false;
    this.ctx.updateProgress();
    const elapsedMs = this.runStartAt ? Date.now() - this.runStartAt : 0;
    this.ctx.showSummary(
      `闯关结束<div class="sum-stats">到达第 <b>${this.level}</b> 关 ｜ 累计金币 <b>${fmt(this.totalCoins)}￥</b> ｜ 收集 <b>${this.totalCollects}</b> 次 ｜ 用时 ${formatElapsedSeconds(elapsedMs)}</div>`,
      () => this.enter(),
    );
    this.showStartHint();
    endlessStatus('');
    this.ctx.search.clear();
  }

  private statusHtml() {
    return (
      `<span>第 <b>${this.level}</b> 关</span>` +
      `<span>本关目标：<b>${fmt(this.target)}￥</b></span>` +
      `<span>累计收集：<b>${fmt(this.totalCoins)}￥</b></span>` +
      `<span>本关收集：<b>${fmt(this.levelCoins)}￥</b></span>`
    );
  }

  private labelOf(adcode: string): { text: string; price: boolean } | null {
    const c = this.coins.get(adcode) ?? 0;
    if (c > 0) {
      if (this.hidePrices) return null; // 隐藏价格标签
      return { text: fmt(c), price: true };
    }
    if (this.collectedThisLevel.has(adcode)) {
      const u = this.ctx.byAdcode.get(adcode);
      return u ? { text: u.name, price: false } : null;
    }
    return null;
  }

  /** 基于柏林噪声生成全国地级市初始金币（约 50-400，多数低于 250，~150 常见）。 */
  private generateCoins(): Map<string, number> {
    const map = new Map<string, number>();
    for (const u of this.ctx.data.units) {
      const n = clamp(
        fbm((u.center[0] + 180) / COIN_NOISE_SCALE, (u.center[1] + 90) / COIN_NOISE_SCALE, 3, this.perm) * COIN_NOISE_AMPLIFY,
        -1,
        1,
      );
      const t = (n + 1) / 2;
      const coins = clamp(Math.round((COIN_MIN + t * t * (COIN_MAX - COIN_MIN)) / 10) * 10, COIN_MIN, COIN_MAX);
      map.set(u.adcode, coins);
    }
    return map;
  }

  /** 跨关上浮：全部城市（含本关已收集）按当前金币区间取范围内随机值增长。 */
  private floatUpCoins() {
    for (const [adcode, coins] of this.coins) {
      let inc: number;
      if (coins < 100) inc = randInt(30, 50);
      else if (coins < 300) inc = randInt(20, 40);
      else if (coins < 500) inc = randInt(10, 30);
      else inc = randInt(5, 15);
      this.coins.set(adcode, coins + inc);
    }
  }

  /** 本关累计目标：通关所需的累计金币（第一关 1000，第二关 1000+1100=2100，逐关等比求和）。 */
  private cumulativeTarget(level: number) {
    return (BASE_TARGET * (Math.pow(TARGET_GROWTH, level) - 1)) / (TARGET_GROWTH - 1);
  }
}

// ---------- 常量 ----------
const LEVEL_SECONDS = 45;
const BASE_TARGET = 1000; // 第一关累计目标金币
const TARGET_GROWTH = 1.1; // 累计目标每关增幅（第二关 1000+1100=2100）
const COIN_MIN = 50; // 初始金币下限（约 50）
const COIN_MAX = 400; // 初始金币上限（约 400）
const COIN_NOISE_SCALE = 6; // 经/纬度噪声尺度
const COIN_NOISE_AMPLIFY = 1.25; // 噪声起伏放大（拉开差距）
const COIN_LABEL_ZOOM = 2; // 金币标签显示倍率阈值
const HIDE_PRICE_KEY = 'china-admin-endless-hide-price-v1';

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

function randomSeed() {
  return (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
}

function loadHidePrices(): boolean {
  try {
    return localStorage.getItem(HIDE_PRICE_KEY) === '1';
  } catch {
    return false;
  }
}

function saveHidePrices(hidden: boolean) {
  try {
    localStorage.setItem(HIDE_PRICE_KEY, hidden ? '1' : '0');
  } catch {
    /* 忽略存储失败 */
  }
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
