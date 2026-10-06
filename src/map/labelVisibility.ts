/**
 * 地图地名标签的**会话级可见性覆盖**（2026-09 需求 6：Alt 热切换）。
 *
 * ## 为什么要有「覆盖」这一层，而不是直接改设置
 *
 * 标签的显示口径原本只有一个来源：全局设置 `settings.showBrowseLabels`（「未开始显示地图地名」）。
 * 但用户要的是**游玩过程中随时用 Alt 看一眼地名**——这是临时的、会话级的意图，
 * 不该写进 localStorage 把用户长期的偏好改掉（下次打开还想按自己的设置走）。
 * 因此覆盖只活在内存里：刷新页面即回到设置口径，这正是「会话级」的含义。
 *
 * ## 三态
 *
 * `null`（默认）= 没有覆盖，走设置；`true` = 强制显示；`false` = 强制隐藏。
 * 覆盖的存在还有一个关键作用：**答题进行中也要能显示全量标签**。
 * 按设置口径「开始答题即清空全量地名」（那是答题反馈的一部分，见 browseLabels.ts），
 * 而覆盖为 true 时我们明确要让用户看到全量——否则 Alt 在答题中按下等于没反应，
 * 「热切换」就名不副实。
 *
 * 反例（曾经考虑过的做法）：把 Alt 的效果写进 `settings.showBrowseLabels`。
 * 那样按一次 Alt 就永久改掉了全局设置，用户下次进别的模式发现地名没了，
 * 却不知道是自己哪次误触——临时意图与长期偏好必须分开存。
 */

/** 会话级覆盖：`null` = 不覆盖（走设置）；`true`/`false` = 强制显示/隐藏。 */
export type LabelOverride = boolean | null;

/** 当前会话覆盖（模块级单例：整个页面只有一份「这一局想不想看地名」的意图）。 */
let override: LabelOverride = null;

export function labelOverride(): LabelOverride {
  return override;
}

export function setLabelOverride(v: LabelOverride): void {
  override = v;
}

/**
 * 在给定覆盖值下求**有效可见性**：覆盖优先；没有覆盖时 = 「设置开关 && 非答题进行中」。
 *
 * 抽成显式的三参函数是为了让模式侧能吃到外壳注入的读数（`ModeCtx.labelsOverride`）——
 * 单测里可以传任意覆盖值，不必去动模块级单例，也不会让用例之间互相污染。
 */
export function labelsVisibleWith(o: LabelOverride, settingsOn: boolean, playing: boolean): boolean {
  if (o !== null) return o;
  return settingsOn && !playing;
}

/** 有效可见性（覆盖优先；否则「设置开关 && 非答题进行中」）。 */
export function labelsVisible(settingsOn: boolean, playing: boolean): boolean {
  return labelsVisibleWith(override, settingsOn, playing);
}
