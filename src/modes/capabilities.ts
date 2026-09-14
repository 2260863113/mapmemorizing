/**
 * 模式能力表：哪些模式有排行榜、哪些是计时测验、哪些带「世界/省级/市级」粒度行。
 *
 * 为什么单独成模块：这三组集合原先以 `mode === 'self' || mode === 'click' || …` 的形式，
 * 散落在 `appController`（排行榜资格）与 `chromeSync`（侧栏、按钮显隐、搜索框）里，
 * 只靠注释互相提醒「与 xx 保持一致」。新增一个模式（拼图就是这么加进来的）必须逐处补，
 * 漏一处的表现是静默的 UI 不一致（按钮显示但功能没接上），而不是编译错误。
 *
 * 收敛到这里后：新增模式只改这张表；`capabilities.test.ts` 再锁住「与服务端白名单一致」。
 */
import type { Mode } from '../types';

/**
 * 有排行榜 / 可提交成绩的模式。
 * 服务端白名单必须与之一致（`functions/_lib/validate.ts` 的 `MODES`），由单测断言。
 */
export const LEADERBOARD_MODES = ['self', 'click', 'endless', 'puzzle'] as const;

/** 排行榜模式类型：由运行期表推导，避免「类型与表漂移」这种两头都要改的情形。 */
export type LeaderboardMode = (typeof LEADERBOARD_MODES)[number];

export function isLeaderboardMode(mode: Mode | undefined): mode is LeaderboardMode {
  return mode !== undefined && (LEADERBOARD_MODES as readonly Mode[]).includes(mode);
}

/**
 * 计时测验模式：有「开始 → 作答 → 结算」生命周期与 跳过/暂停/重置 一组按钮。
 * （熟练度分析、留言板、管理端不是测验，拼图是另一套两阶段生命周期。）
 */
export const TIMED_TEST_MODES = ['self', 'click', 'endless'] as const;

export function isTimedTestMode(mode: Mode | undefined): boolean {
  return mode !== undefined && (TIMED_TEST_MODES as readonly Mode[]).includes(mode);
}

/**
 * 由模式自己维护「世界 / 省级 / 市级」粒度的模式（粒度行归它所有）。
 * 熟练度分析也用粒度，但那是分析档位、随时可切，走 `analysis-granularity-toggle`，不在这张表里。
 */
export const GRANULARITY_MODES = ['self', 'click'] as const;

export function hasGranularityToggle(mode: Mode | undefined): boolean {
  return mode !== undefined && (GRANULARITY_MODES as readonly Mode[]).includes(mode);
}
