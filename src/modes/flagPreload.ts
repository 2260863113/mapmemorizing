/**
 * 国旗预加载队列（点击模式「国旗」档）。
 *
 * ## 为什么需要
 * 线上慢网下，每换一道新国旗就是**一次独立网络请求**（每题一个文件，缓存里没有）—— 这正是用户看到的
 * 「每次都要等约 0.5 秒」。本机空缓存实测第 1 面 32ms、之后 0ms，说明延迟来自**网络**而非解码。
 *
 * ## 缓存多少（2026-09 第二轮口径：只缓存接下来两个）
 * 第一版做法是"选上国旗档就把**整个出题池**排进队列"（世界全国 194 面共 1.21MB）—— 能保证零等待，
 * 但把整个池都下了。用户口径改为「不一次性全量缓存，仅仅缓存接下来两个国旗」。
 * 于是**队列由调用方给出**（`lib` 不再自己决定取什么），实现在 `MapQuizMode.syncFlagPreload`：
 *   · 队列 = 当前题 + 「接下来两道」（点击模式用 `ClickMode.lookahead` 把选题提前一步定下来）；
 *   · 长度恒为 3，与下面的 3 并发正好对上：三张图同时请求；
 *   · 每换一题只多请求一面（下一题上一轮已取过，`done` 集合会跳过重复请求）。
 *
 * ## 实现要点
 * · 同源静态 SVG，用 `new Image()` 触发一次普通 GET 即进入 HTTP 缓存；不需要 decode 结果，也不要插进 DOM。
 * · **低优先级 + 3 并发**：预取不能跟答题本身的请求（排行榜、公告…）抢带宽。
 * · 换池（切范围 / 重开一局）时**替换队列**：已经发出去的请求不取消（取消也只是白费已花的带宽，
 *   而且旧池的国旗仍可能被抽到），只是不再继续排队。
 * · 不检查 `navigator.connection.saveData`（用户口径 2026-09：一律预取）。
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
/**
 * 队列代次：换池/清空时 +1。
 * 为什么需要它：旧队列已经发出的请求，其 onload 回调**一定还会跑**（取消不掉），
 * 而计数器已按新队列重新起算 —— 若旧回调照旧减一，`inFlight` 会变成负数
 * （实测：切一次口径后探针读到 `inFlight: -1`），进而让并发上限形同虚设。
 */
let generation = 0;

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
  const gen = generation;
  while (inFlight < CONCURRENCY && cursor < queue.length) {
    const src = queue[cursor++];
    if (done.has(src)) continue;
    done.add(src);
    inFlight += 1;
    const img = new Image();
    const finish = () => {
      if (gen !== generation) return; // 旧队列的回调：计数器已按新队列重算，不能再减（否则会变负）
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
 *
 * 队列长度由调用方负责（现在的口径是"当前题 + 接下来两道"，见文件头说明）。
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
  inFlight = 0; // 新队列重新起算；旧队列的回调靠 generation 识别并忽略
  generation += 1;
  pump();
}

/** 退出模式/重置时清队列（已发出的请求不可回收，只是不再排队）。 */
export function stopFlagPreload(): void {
  queue = [];
  cursor = 0;
  inFlight = 0;
  generation += 1;
}

/**
 * 组装"某国 → 国旗 src"的取值器。数据缺失返回 null（该国的国旗档会回落成国名题面）。
 */
export function flagSrcOf(data: AppData, iso: string): string | null {
  const file = data.countryFlags[iso];
  return file ? `data/flags/${file}` : null;
}

/**
 * 组装"某国 → 国旗**缩略图** src"的取值器（未开始的浏览标签用）。
 *
 * 与 `flagSrcOf` 分开两张表：题面卡片要原始矢量（清楚、用户口径明确不压缩），
 * 地图标签只有二十几像素宽、194 张横铺，用 40×30 的 WebP 小图（合计 163KB vs 1.21MB）。
 * 数据缺失返回 null → 该国的浏览标签回落到国名文本（宁可少一面旗，也不要一张破图）。
 */
export function flagThumbSrcOf(data: AppData, iso: string): string | null {
  const file = data.countryFlagThumbs[iso];
  return file ? `data/flags/thumbs/${file}` : null;
}
