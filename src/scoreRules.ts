import type { RoundResult } from './types';

/**
 * 成绩提交资格规则（单一事实源，前端结算/提交用）。
 * 与 functions/_lib/validate.ts 的 validateScore 保持语义一致：
 * - endless 需有金币；
 * - 全国 self/click 允许未答完（已答全对即可，wrong 必须为 0）；
 * - 省级（含省级全国哨兵 `__province_nation__`）必须全部答对。
 */
export function canSubmitScore(result: RoundResult): boolean {
  if (result.mode === 'endless') return typeof result.coins === 'number' && result.coins > 0;
  if (result.scopeProvince === null) return result.correct > 0 && result.wrong === 0;
  // 省级与省级全国：correct === totalUnits 且 wrong === 0（等价于「全对」）。
  return result.totalUnits > 0 && result.correct + result.wrong === result.totalUnits && result.correct === result.totalUnits && result.wrong === 0;
}
