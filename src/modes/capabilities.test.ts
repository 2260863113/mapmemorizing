import { describe, it, expect } from 'vitest';
import {
  GRANULARITY_MODES,
  LEADERBOARD_MODES,
  TIMED_TEST_MODES,
  hasGranularityToggle,
  isLeaderboardMode,
  isTimedTestMode,
} from './capabilities';
import { validMode } from '../../functions/_lib/validate';
import type { Mode } from '../types';

/**
 * 模式能力表的跨平面一致性验证（与 `subregions.test.ts` 断言前后端哨兵同一手法）。
 *
 * 为什么关键：`LEADERBOARD_MODES` 是前端「显示排行榜 + 允许提交」的判据，
 * 服务端 `validMode` 是白名单。两侧一旦漂移，表现是「界面上有榜、成绩提交永远被拒」
 * （或反之），而且只在真机上点提交才会发现。
 */

const ALL_MODES: Mode[] = ['free', 'self', 'endless', 'click', 'board', 'admin', 'puzzle'];

describe('LEADERBOARD_MODES', () => {
  it('与服务端成绩白名单逐项一致（多一个 = 前端有榜提交被拒，少一个 = 有榜却不显示）', () => {
    const backend = ALL_MODES.filter((m) => validMode(m));
    expect([...LEADERBOARD_MODES].sort()).toEqual([...backend].sort());
  });

  it('表内无重复项，且每一项都是合法的 Mode', () => {
    expect(new Set(LEADERBOARD_MODES).size).toBe(LEADERBOARD_MODES.length);
    for (const m of LEADERBOARD_MODES) expect(ALL_MODES).toContain(m);
  });

  it('isLeaderboardMode 只认表内模式（undefined / 非测验模式一律 false）', () => {
    for (const m of ALL_MODES) {
      expect(isLeaderboardMode(m), m).toBe((LEADERBOARD_MODES as readonly string[]).includes(m));
    }
    expect(isLeaderboardMode(undefined)).toBe(false);
  });
});

describe('TIMED_TEST_MODES / GRANULARITY_MODES 的从属关系', () => {
  it('计时测验模式必须是排行榜模式（有 开始/暂停/跳过 就一定有榜）', () => {
    for (const m of TIMED_TEST_MODES) expect(isLeaderboardMode(m), m).toBe(true);
    // 反向不成立：拼图有榜，但生命周期是「选范围 → 盘面」两阶段，不是计时测验
    expect(isTimedTestMode('puzzle')).toBe(false);
  });

  it('粒度行只挂在计时测验模式上（熟练度分析的粒度走 analysis 行）', () => {
    for (const m of GRANULARITY_MODES) expect(isTimedTestMode(m), m).toBe(true);
    expect(hasGranularityToggle('free')).toBe(false);
    expect(hasGranularityToggle(undefined)).toBe(false);
  });

  it('非测验模式一律不是计时测验', () => {
    for (const m of ['free', 'board', 'admin'] as const) expect(isTimedTestMode(m), m).toBe(false);
  });
});
