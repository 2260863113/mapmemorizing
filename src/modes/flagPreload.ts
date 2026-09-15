/**
 * 国旗预加载队列（点击模式「国旗」档）。
 *
 * ## 为什么需要
 * 线上慢网下，每换一道新国旗就是**一次独立网络请求**（每题一个文件，缓存里没有）—— 这正是用户看到的
 * 「每次都要等约 0.5 秒」。本机空缓存实测第 1 面 32ms、之后 0ms，说明延迟来自**网络**而非解码。
 *
 * ## 为什么是"预取整个池"而不是"预取下一面"
 * 点击模式的下一题是**答对那一刻才随机决定的**（`nextUnit` → 随机 / 错题），所以"提前加载后面那一面"
 * 根本无从知道该加载哪一面。唯一能让每个新国旗都零延迟的做法，是把**当前出题池的全部国旗**放进浏览器缓存
 * （世界全国 194 面共 1.21MB，大洲/次区域按池子大小递减）。
 *
 * ## 实现要点
 * · 同源静态 SVG，用 `new Image()` 触发一次普通 GET 即进入 HTTP 缓存；不需要 decode 结果，也不要插进 DOM。
 * · **低优先级 + 3 并发**：预取不能跟答题本身的请求（排行榜、公告…）抢带宽。
 * · 换池（切范围 / 重开一局）时**替换队列**：已经发出去的请求不取消（取消也只是白费已花的带宽，
 *   而且旧池的国旗仍可能被抽到），只是不再继续排队。
 * · 不检查 `navigator.connection.saveData`（用户口径 2026-09：一律全预取）。
 * · `stop()` 在退出模式时清队列；`done` 集合避免对同一个 src 重复建 Image（浏览器缓存是最终依据）。
 */
import type { AppData } from '../types';

/** 同时进行的预取请求数：够快，又不至于把答题本身的请求挤掉。 */
const CONCURRENCY = 3;

/** 已经预取过（成功或失败都算）的 src：避免每次换池都把整整一池重新建一遍 Image。 */
const done = new Set<string>();

let queue: string[] = [];
let cursor = 0;
let inFlight = 0;

/** 当前队列快照（测试与验收探针用）。 */
export function flagPreloadStats(): { total: number; done: number; started: boolean; inFlight: number } {
  return { total: queue.length, done: Math.min(cursor, queue.length), started: queue.length > 0 && cursor < queue.length, inFlight };
}

/** 仅供测试复位模块级状态。 */
export function resetFlagPreloadForTest(): void {
  queue = [];
  cursor = 0;
  inFlight = 0;
  done.clear();
}

function pump() {
  while (inFlight < CONCURRENCY && cursor < queue.length) {
    const src = queue[cursor++];
    if (done.has(src)) continue;
    done.add(src);
    inFlight += 1;
    const img = new Image();
    const finish = () => {
      inFlight -= 1;
      pump();
    };
    img.onload = finish;
    img.onerror = finish; // 单张失败不阻塞队列，也不再重试（重试交给下次换池）
    img.src = src;
  }
}

/**
 * 用一组 src **替换**当前预取队列。调用方给的顺序即优先级，故通常把"当前题"放最前。
 * 已经预取过的 src 会被跳过。
 */
export function preloadFlags(srcs: readonly string[]): void {
  const next: string[] = [];
  const seen = new Set<string>();
  for (const src of srcs) {
    if (!src || seen.has(src)) continue;
    seen.add(src);
    next.push(src);
  }
  queue = next;
  cursor = 0;
  inFlight = 0; // 旧的 in-flight 回调仍会跑，但只影响它自己那次计数；新队列重新起算
  pump();
}

/** 退出模式/重置时清队列（已发出的请求不可回收，只是不再排队）。 */
export function stopFlagPreload(): void {
  queue = [];
  cursor = 0;
}

/**
 * 组装"某国 → 国旗 src"的取值器。数据缺失返回 null（该国的国旗档会回落成国名题面）。
 */
export function flagSrcOf(data: AppData, iso: string): string | null {
  const file = data.countryFlags[iso];
  return file ? `data/flags/${file}` : null;
}
