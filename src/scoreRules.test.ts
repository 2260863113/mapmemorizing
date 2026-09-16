import { describe, it, expect } from 'vitest';
import { canSubmitScore } from './scoreRules';
import type { RoundResult } from './types';

function result(over: Partial<RoundResult>): RoundResult {
  return {
    mode: 'self',
    scopeProvince: null,
    scopeLabel: '全国',
    totalUnits: 340,
    correct: 0,
    wrong: 0,
    elapsedMs: 1000,
    finishedAt: Date.now(),
    ...over,
  };
}

describe('canSubmitScore', () => {
  it('endless requires coins > 0', () => {
    expect(canSubmitScore(result({ mode: 'endless', coins: 1 }))).toBe(true);
    expect(canSubmitScore(result({ mode: 'endless', coins: 0 }))).toBe(false);
    expect(canSubmitScore(result({ mode: 'endless' }))).toBe(false);
  });

  it('nation scope: correct > 0 and wrong === 0 (allow unfinished)', () => {
    expect(canSubmitScore(result({ scopeProvince: null, correct: 5, wrong: 0 }))).toBe(true);
    expect(canSubmitScore(result({ scopeProvince: null, correct: 5, wrong: 1 }))).toBe(false);
    expect(canSubmitScore(result({ scopeProvince: null, correct: 0, wrong: 0 }))).toBe(false);
  });

  it('world-nation scope: correct > 0 and wrong === 0 (same as nation)', () => {
    expect(canSubmitScore(result({ scopeProvince: '__world_nation__', totalUnits: 195, correct: 5, wrong: 0 }))).toBe(true);
    expect(canSubmitScore(result({ scopeProvince: '__world_nation__', totalUnits: 195, correct: 5, wrong: 1 }))).toBe(false);
    expect(canSubmitScore(result({ scopeProvince: '__world_nation__', totalUnits: 195, correct: 194, wrong: 0 }))).toBe(true);
  });

  it('continent scope: same as world-nation (allow unfinished, wrong must be 0)', () => {
    expect(canSubmitScore(result({ scopeProvince: '__continent_AS__', totalUnits: 46, correct: 5, wrong: 0 }))).toBe(true);
    expect(canSubmitScore(result({ scopeProvince: '__continent_AS__', totalUnits: 46, correct: 46, wrong: 0 }))).toBe(true);
    expect(canSubmitScore(result({ scopeProvince: '__continent_AS__', totalUnits: 46, correct: 5, wrong: 1 }))).toBe(false);
    expect(canSubmitScore(result({ scopeProvince: '__continent_AS__', totalUnits: 46, correct: 0, wrong: 0 }))).toBe(false);
    // 每个大洲哨兵都适用同一规则
    for (const id of ['AS', 'EU', 'AF', 'NA', 'SA', 'OC']) {
      expect(canSubmitScore(result({ scopeProvince: `__continent_${id}__`, correct: 1, wrong: 0 }))).toBe(true);
    }
  });

  it('province scope: must be fully correct', () => {
    expect(canSubmitScore(result({ scopeProvince: '520000', totalUnits: 9, correct: 9, wrong: 0 }))).toBe(true);
    expect(canSubmitScore(result({ scopeProvince: '520000', totalUnits: 9, correct: 8, wrong: 1 }))).toBe(false);
  });

  it('province-nation scope: must be fully correct', () => {
    expect(canSubmitScore(result({ scopeProvince: '__province_nation__', totalUnits: 34, correct: 34, wrong: 0 }))).toBe(true);
    expect(canSubmitScore(result({ scopeProvince: '__province_nation__', totalUnits: 34, correct: 33, wrong: 0 }))).toBe(false);
  });
});

/**
 * 拼图榜（2026-09 新增，2026-09-16 扩大口径）：**所有合法范围都可提交**——
 * 各自一个范围哨兵、独立成行，排名一律「已拼优先、同数比用时」；
 * 且「已拼」（= 1 + 吸附次数）至少要 ≥ 2（至少吸上过一片）。
 *
 * 为什么从"只有两档"放开：默认进入拼图模式落在**省级全国**，而那一档原先不可提交，
 * 于是用户拼完既没有「提交成绩」按钮、那一档的榜也永远是空的（实测到的缺陷）。
 */
describe('canSubmitScore · 拼图', () => {
  const puzzle = (over: Partial<RoundResult>) =>
    result({ mode: 'puzzle', scopeProvince: null, scopeLabel: '全国', totalUnits: 340, correct: 2, wrong: 0, ...over });

  it('可提交的范围：全国级哨兵与下钻范围一律可以', () => {
    expect(canSubmitScore(puzzle({ scopeProvince: null, totalUnits: 340, correct: 2 }))).toBe(true);
    expect(canSubmitScore(puzzle({ scopeProvince: '__world_nation__', totalUnits: 194, correct: 2 }))).toBe(true);
    expect(canSubmitScore(puzzle({ scopeProvince: '__world_nation__', totalUnits: 194, correct: 194 }))).toBe(true);
  });

  it('省级全国 / 大洲 / 次区域 / 下钻某省也都可以（各自独立成行）', () => {
    for (const scope of ['__province_nation__', '__continent_AS__', '__subregion_EAS__', '130000', '110000']) {
      expect(canSubmitScore(puzzle({ scopeProvince: scope, totalUnits: 34, correct: 9 })), scope).toBe(true);
    }
  });

  it('非法的范围形状仍然拒绝（不能靠随手写一个字符串往榜里塞数据）', () => {
    for (const scope of ['随便一个字符串', '__continent_ZZ__', '__subregion_ZZZ__', '13000', '1300000']) {
      expect(canSubmitScore(puzzle({ scopeProvince: scope, totalUnits: 34, correct: 9 })), scope).toBe(false);
    }
  });

  it('「已拼」必须至少 2（1 = 一片都没吸上，属于开局未成成绩）', () => {
    expect(canSubmitScore(puzzle({ correct: 1 }))).toBe(false);
    expect(canSubmitScore(puzzle({ correct: 2 }))).toBe(true);
  });

  it('已拼不能超过总片数，且不含答错数', () => {
    expect(canSubmitScore(puzzle({ totalUnits: 34, correct: 35 }))).toBe(false);
    expect(canSubmitScore(puzzle({ correct: 5, wrong: 1 }))).toBe(false);
    expect(canSubmitScore(puzzle({ totalUnits: 1, correct: 1 }))).toBe(false); // 单片的范围没有意义
  });
});
