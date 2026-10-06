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

/**
 * 2026-09 口径变更（用户需求原话：即便没有全对也全部允许提交，排行先看正确个数、再看时间快慢）：
 * self/click 的**所有范围**都不再要求「全对/答完」，唯一门槛是**至少答过一题**。
 * 下面是逐个范围的回归网，防止哪天又给某个范围偷偷加回全对限制。
 */
const ALL_SELF_CLICK_SCOPES: Array<{ name: string; scope: string | null; totalUnits: number }> = [
  { name: '市级全国（null）', scope: null, totalUnits: 340 },
  { name: '省级全国哨兵', scope: '__province_nation__', totalUnits: 34 },
  { name: '世界全国哨兵', scope: '__world_nation__', totalUnits: 195 },
  { name: '大洲哨兵', scope: '__continent_AS__', totalUnits: 46 },
  { name: '次区域哨兵', scope: '__subregion_EAS__', totalUnits: 11 },
  { name: '单省 adcode', scope: '520000', totalUnits: 9 },
];

describe('canSubmitScore', () => {
  it('endless requires coins > 0', () => {
    expect(canSubmitScore(result({ mode: 'endless', coins: 1 }))).toBe(true);
    expect(canSubmitScore(result({ mode: 'endless', coins: 0 }))).toBe(false);
    expect(canSubmitScore(result({ mode: 'endless' }))).toBe(false);
  });

  it('self/click：所有范围都是「至少答过一题」即可，答错也照样能提交', () => {
    for (const { name, scope, totalUnits } of ALL_SELF_CLICK_SCOPES) {
      // 部分作答、且答错过 —— 新口径下允许（旧口径只有全国语义允许，省级语义要求全对）
      expect(canSubmitScore(result({ scopeProvince: scope, totalUnits, correct: 3, wrong: 2 })), name).toBe(true);
      // 只答错、一题没对 —— 也算「答过一题」
      expect(canSubmitScore(result({ scopeProvince: scope, totalUnits, correct: 0, wrong: 1 })), name).toBe(true);
      // 全对（含答满）当然可以
      expect(canSubmitScore(result({ scopeProvince: scope, totalUnits, correct: totalUnits, wrong: 0 })), name).toBe(true);
      // 一题都没答 —— 唯一的拒绝条件
      expect(canSubmitScore(result({ scopeProvince: scope, totalUnits, correct: 0, wrong: 0 })), name).toBe(false);
    }
  });

  it('click 模式与 self 同口径（模式不同不改资格）', () => {
    expect(canSubmitScore(result({ mode: 'click', scopeProvince: '520000', totalUnits: 9, correct: 4, wrong: 1 }))).toBe(true);
    expect(canSubmitScore(result({ mode: 'click', scopeProvince: null, correct: 0, wrong: 0 }))).toBe(false);
  });

  it('题目总数与答对数仍然要自洽（totalUnits > 0、correct <= totalUnits）', () => {
    expect(canSubmitScore(result({ scopeProvince: '520000', totalUnits: 0, correct: 1, wrong: 1 }))).toBe(false);
    expect(canSubmitScore(result({ scopeProvince: '520000', totalUnits: 9, correct: 10, wrong: 0 }))).toBe(false);
  });
});

/**
 * 拼图榜（2026-09 新增，2026-09-16 扩大口径）：**所有合法范围都可提交**——
 * 各自一个范围哨兵、独立成行，排名一律「已拼优先、同数比用时」；
 * 且「已拼」（= 1 + 吸附次数）至少要 ≥ 2（至少吸上过一片）。
 *
 * 本轮「放开未全对提交」**不涉及拼图**：拼图没有"答错"这回事（wrong 恒 0），
 * 它的门槛本来就是「已拼个数」，与 self/click 的「全对」限制无关，故口径保持不变。
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
