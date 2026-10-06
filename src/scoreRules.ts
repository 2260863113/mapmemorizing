import type { RoundResult } from './types';
import { isPuzzleLeaderboardScope, PUZZLE_MIN_SUBMIT } from './modes/puzzle';

/**
 * 成绩提交资格规则（单一事实源，前端结算/提交用）。
 * 与 functions/_lib/validate.ts 的 validateScore 保持语义一致：
 * - endless 需有金币；
 * - puzzle 需为合法范围，且「已拼」≥ PUZZLE_MIN_SUBMIT、不含答错、不超过总片数；
 * - self/click 的**所有**范围（市级全国 null、省级全国哨兵、世界全国哨兵、大洲、次区域、单省 6 位 adcode）
 *   共用同一条门槛：至少答过一题（correct + wrong > 0），且 totalUnits > 0、correct <= totalUnits。
 *
 * 为什么省级榜也放开「全对」：排行榜的口径是「先比答对个数、再比用时」，
 * 答得少的名次自然靠后。若省级榜仍卡全对，同一个用户在全国榜有成绩、切到省级榜却连提交资格都没有，
 * 两侧规则自相矛盾；放开后各范围的资格与排序都由同一条口径决定。
 */
export function canSubmitScore(result: RoundResult): boolean {
  if (result.mode === 'endless') return typeof result.coins === 'number' && result.coins > 0;
  if (result.mode === 'puzzle') {
    return (
      isPuzzleLeaderboardScope(result.scopeProvince) &&
      result.wrong === 0 &&
      result.totalUnits >= PUZZLE_MIN_SUBMIT &&
      result.correct >= PUZZLE_MIN_SUBMIT &&
      result.correct <= result.totalUnits
    );
  }
  // self/click：不再按范围分档，唯一门槛是「至少回答一题」。
  return result.totalUnits > 0 && result.correct <= result.totalUnits && result.correct + result.wrong > 0;
}
