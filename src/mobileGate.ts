/**
 * 手机端访问门槛（2026-10 需求）：手机打开站点时先弹一个「请用电脑端访问」的窗口，
 * 下方一个「继续访问」按钮；点它之后页面按**电脑视图**渲染（viewport 固定桌面宽度），
 * 而不是错乱的手机视图。
 *
 * ## 为什么真正的逻辑内联在 index.html 里，这里只放"契约常量"
 *
 * 门槛必须**早于主 bundle** 生效：主 bundle 有 1.3MB，等它执行到再遮罩，用户已经先看到一眼
 * 错乱的手机布局（`styles.css` 在构建产物里是 `<link>`，首屏就已经生效，而 JS 还没跑）。
 * 所以遮罩的样式与判定只能写在 `index.html` 的 `<style>` / `<script>` 里（同步执行、早于首次绘制）。
 *
 * 代价是同一份口径出现在两个文件里。本模块把这份口径里的**可变部分**变成可导入的常量：
 * 手机 UA 的**正则源码**、爬虫 UA 正则、localStorage 键、桌面 viewport 值、门槛的 class 名；
 * `mobileGate.test.ts` 断言 `index.html` **逐字包含**它们 —— 与 `capabilities.test.ts` 断言
 * index.html 里的 tab 文案等于模式名是同一套路子（那边比模式名，这边比正则源码）。
 * 于是"改了实现忘了改内联副本"会在单测里立刻变红，而不是等到线上才发现门槛没弹。
 *
 * ## 为什么排除爬虫
 *
 * Googlebot-Smartphone 的 UA 与普通手机**无法区分**（同样含 `Android`…`Mobile Safari`），
 * 而本站的 SEO 依赖爬虫能读到正文（见 README 的 SEO 一节）。故先排除明显的爬虫 UA ——
 * 它们本来也不该被"请用电脑端访问"挡住。
 *
 * ## 为什么点「继续访问」后不是隐藏页面，而是换 viewport
 *
 * 项目的 CSS 没有手机版布局（只有两处窄屏微调），真正决定"手机视图 vs 电脑视图"的是
 * **layout viewport 宽度**：`width=device-width`（≈390px）会把桌面布局挤成错乱的样子；
 * `width=1280` 则让手机按 1280px 宽排版（整页缩小显示、可双指放大）。
 * 为什么是 1280：项目自己的两个窄屏断点是 900 / 620px，取 1280 保证落在"电脑档"里。
 */

/**
 * 手机 UA 正则的**源码**（不含斜杠与 flags）。
 *
 * 为什么 `Windows Phone` / `HarmonyOS` / `MiuiBrowser` 都列上：国产机型与鸿蒙的自定义 UA
 * 不一定带 `Android`；而 `MicroMessenger` / `Weixin` 是因为微信内置浏览器在部分机型上会改写 UA。
 * 由 `mobileGate.test.ts` 断言与 index.html 内联副本逐字一致。
 */
export const PHONE_UA_SOURCE =
  'Android|iPhone|iPod|Windows Phone|HarmonyOS|MiuiBrowser|MicroMessenger|Weixin|Mobile Safari';

/** 明显爬虫 UA 的源码；命中则完全不弹门槛（见文件头）。 */
export const CRAWLER_UA_SOURCE = 'bot|spider|crawler|slurp|headless|externalagent';

/** 「继续访问」的选择存在这个键里（值为 `GATE_CONTINUE_VALUE`）；下次访问不再打扰。 */
export const MOBILE_GATE_KEY = 'china-admin-mobile-gate-v1';

/** 选择"继续访问"时写入的存储值。 */
export const GATE_CONTINUE_VALUE = 'continue';

/** 点「继续访问」后使用的 viewport（固定桌面宽度，见文件头）。 */
export const DESKTOP_VIEWPORT = 'width=1280';

/** 门槛生效时给 `<html>` 加的 class：内联脚本加、点按钮去掉。 */
export const GATE_CLASS = 'mobile-gate';

/**
 * 是否需要弹门槛：**不是**爬虫、UA 像手机、且确实有触屏/粗指针。
 *
 * 三个条件缺一不可：
 *   · 只按 UA 判会把桌面浏览器的"移动端模拟"与某些 UA 异常的真桌面浏览器也算进来；
 *   · 只按触屏判会把触摸屏笔记本算进来（那上面显示电脑视图本来就是对的，弹窗纯属打扰）。
 * 生产路径用的是 index.html 里的内联副本（理由见文件头），本函数供单测与文档使用。
 */
export function isPhoneClient(input: { userAgent: string; touch: boolean; coarsePointer: boolean }): boolean {
  if (new RegExp(CRAWLER_UA_SOURCE, 'i').test(input.userAgent)) return false;
  if (!new RegExp(PHONE_UA_SOURCE, 'i').test(input.userAgent)) return false;
  return input.touch || input.coarsePointer;
}
