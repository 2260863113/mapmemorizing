import { describe, it, expect, afterEach, vi } from 'vitest';
import { CORRECT_SCORE, MemoryStore, practiceScore, WRONG_SCORE } from './store';

/**
 * 熟练度**分值**（2026-10 用户口径：答对 +1、答错 −3；此前答错只扣 1）。
 *
 * 为什么必须测：分值同时作用在**地级 / 省级 / 国家**三套熟练度上，而 `score` 是**派生值**
 * （存储里只持久化对/错计数，读回时用 `practiceScore` 现算）。派生带来一个好处（改口径后历史
 * 数据自动重算，不需要写迁移），也带来一个坑：**只要有一处忘了走 `practiceScore`**，
 * 同一个用户在三个粒度上就会看到两套算法 —— 而且不报错、不留痕迹。
 * 故这里把三套入口（record / 读回 / 存量数据重算）逐个钉住。
 */

function stubStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  return store;
}

afterEach(() => vi.unstubAllGlobals());

describe('practiceScore', () => {
  it('答对 +1、答错 −3', () => {
    expect(CORRECT_SCORE).toBe(1);
    expect(WRONG_SCORE).toBe(-3);
    expect(practiceScore(0, 0)).toBe(0);
    expect(practiceScore(1, 0)).toBe(1);
    expect(practiceScore(0, 1)).toBe(-3);
    expect(practiceScore(3, 1)).toBe(0); // 三次答对才抵得过一次答错
    expect(practiceScore(2, 2)).toBe(-4); // 旧口径下这里是 0，改分值后掉到"陌生"档
  });
});

describe('MemoryStore · 三套熟练度都按新分值算', () => {
  it('地级：recordAnswer 后分数 = 对 − 3×错', () => {
    stubStorage();
    const store = new MemoryStore();
    store.recordAnswer('440100', true);
    store.recordAnswer('440100', true);
    store.recordAnswer('440100', false);
    const p = store.getPractice('440100');
    expect(p).toEqual({ correctCount: 2, wrongCount: 1, score: -1 });
  });

  it('省级：recordProvinceAnswer 用同一套分值（不是另一套算法）', () => {
    stubStorage();
    const store = new MemoryStore();
    store.recordProvinceAnswer('440000', true);
    store.recordProvinceAnswer('440000', false);
    store.recordProvinceAnswer('440000', false);
    expect(store.getProvincePractice('440000')).toEqual({ correctCount: 1, wrongCount: 2, score: -5 });
  });

  it('国家：recordWorldAnswer 用同一套分值，且与另两套隔离', () => {
    stubStorage();
    const store = new MemoryStore();
    store.recordWorldAnswer('FRA', false);
    expect(store.getWorldPractice('FRA')).toEqual({ correctCount: 0, wrongCount: 1, score: -3 });
    // 隔离：地级/省级同名键不受影响
    expect(store.getPractice('FRA').score).toBe(0);
    expect(store.getProvincePractice('FRA').score).toBe(0);
  });

  it('存量数据读回时按**新**分值重算（分数是派生的，不需要写迁移）', () => {
    stubStorage({
      'china-admin-memory-v1': JSON.stringify({
        440100: { correctCount: 5, wrongCount: 2, score: 3, learned: false }, // 旧口径存下来的 3
      }),
      'china-admin-province-memory-v1': JSON.stringify({ 440000: { correctCount: 1, wrongCount: 1, score: 0 } }),
      'china-admin-world-memory-v1': JSON.stringify({ FRA: { correctCount: 2, wrongCount: 3, score: -1 } }),
    });
    const store = new MemoryStore();
    expect(store.getPractice('440100').score).toBe(5 - 3 * 2); // 旧值 3 被丢掉，按新口径重算
    expect(store.getProvincePractice('440000').score).toBe(1 - 3);
    expect(store.getWorldPractice('FRA').score).toBe(2 - 3 * 3);
  });

  it('重置按档位清空后分数回到 0（仍走同一套分值）', () => {
    stubStorage();
    const store = new MemoryStore();
    store.recordAnswer('440100', false);
    store.resetPractice();
    expect(store.getPractice('440100')).toEqual({ correctCount: 0, wrongCount: 0, score: 0 });
  });
});
