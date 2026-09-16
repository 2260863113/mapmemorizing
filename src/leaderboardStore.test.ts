import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LeaderboardStore, type LeaderboardEntry, type LeaderboardMode } from './leaderboardStore';

/**
 * 排行榜缓存层的约定（本轮补：此前 store 与 panel **一个测试都没有**，
 * 所以"范围变了却不刷新/刷不出来"这类缺陷能长期潜伏）。
 *
 * 四条被钉住的约定：
 *   1. 快照只服务显示，**不阻止**重新请求（否则别人新提交的成绩整个会话都看不到）；
 *   2. 新鲜期内不重复打接口（侧栏有五个刷新触发点，同一操作常同时命中两三个）；
 *   3. 并发合并成一次请求；
 *   4. 请求带超时，且超时后这个范围**不会**被永久卡死（旧实现会把 Promise 永久留在缓存里）。
 */

const apiMock = vi.hoisted(() => ({
  leaderboard: vi.fn(),
  submitScore: vi.fn(),
}));

vi.mock('./api', () => ({ api: apiMock }));

function entry(username: string): LeaderboardEntry {
  return {
    id: username,
    username,
    mode: 'click',
    scopeProvince: null,
    scopeLabel: '全国',
    totalUnits: 340,
    correct: 12,
    elapsedMs: 65_000,
    submittedAt: 1,
    hometown: null,
    avatar: null,
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  apiMock.leaderboard.mockReset();
  apiMock.submitScore.mockReset();
});

describe('LeaderboardStore · 快照与重新请求', () => {
  it('首次取榜前没有快照，取回后 peek 能同步拿到（面板据此实现"切回秒显"）', async () => {
    apiMock.leaderboard.mockResolvedValue({ entries: [entry('a')] });
    const store = new LeaderboardStore();
    expect(store.peek('click', null)).toBeNull();

    await expect(store.ensure('click', null)).resolves.toHaveLength(1);
    expect(store.peek('click', null)?.map((e) => e.username)).toEqual(['a']);
    // 快照按 (mode, scope) 分别存放：换个范围绝不能串榜
    expect(store.peek('puzzle', null)).toBeNull();
    expect(store.peek('click', '__world_nation__')).toBeNull();
  });

  it('新鲜期内重复刷新复用快照，过期后真正重取（"秒显 + 后台刷新"的前提）', async () => {
    let now = 1000;
    apiMock.leaderboard.mockResolvedValue({ entries: [entry('a')] });
    const store = new LeaderboardStore(8000, 2000, () => now);

    await store.ensure('click', null);
    expect(apiMock.leaderboard).toHaveBeenCalledTimes(1);

    await store.ensure('click', null); // 新鲜期内：不再打接口
    expect(apiMock.leaderboard).toHaveBeenCalledTimes(1);

    now += 2001; // 过期：重新取，别人新提交的成绩这才看得见
    await store.ensure('click', null);
    expect(apiMock.leaderboard).toHaveBeenCalledTimes(2);
  });

  it('同一范围的并发刷新合并成一次网络请求', async () => {
    const d = deferred<{ entries: LeaderboardEntry[] }>();
    apiMock.leaderboard.mockReturnValue(d.promise);
    const store = new LeaderboardStore();

    const p1 = store.ensure('click', null);
    const p2 = store.ensure('click', null);
    expect(p1).toBe(p2);
    expect(apiMock.leaderboard).toHaveBeenCalledTimes(1);

    d.resolve({ entries: [entry('x')] });
    await Promise.all([p1, p2]);
    expect(store.peek('click', null)).toHaveLength(1);
  });
});

describe('LeaderboardStore · 超时（旧实现会把一个范围永久卡死）', () => {
  it('超时后抛出，并且下一次调用会真正重新发请求（槽位已释放）', async () => {
    apiMock.leaderboard.mockReturnValue(new Promise(() => {}));
    const store = new LeaderboardStore(5, 0, () => 0);

    await expect(store.ensure('click', null)).rejects.toThrow(/timeout/);

    apiMock.leaderboard.mockResolvedValue({ entries: [entry('b')] });
    await expect(store.ensure('click', null)).resolves.toHaveLength(1);
    expect(apiMock.leaderboard).toHaveBeenCalledTimes(2);
  });

  it('超时之后迟到的响应一律丢弃，绝不写进快照', async () => {
    const d = deferred<{ entries: LeaderboardEntry[] }>();
    apiMock.leaderboard.mockReturnValue(d.promise);
    const store = new LeaderboardStore(5, 0, () => 0);

    await expect(store.ensure('click', null)).rejects.toThrow(/timeout/);
    d.resolve({ entries: [entry('迟到的旧数据')] });
    await flush();

    expect(store.peek('click', null)).toBeNull();
  });

  it('失败不入快照，但已有快照不被失败抹掉（后台刷新失败时保留旧数据）', async () => {
    apiMock.leaderboard.mockResolvedValueOnce({ entries: [entry('a')] });
    const store = new LeaderboardStore(8000, 0, () => 0);
    await store.ensure('click', null);

    apiMock.leaderboard.mockRejectedValueOnce(new Error('boom'));
    await expect(store.ensure('click', null)).rejects.toThrow('boom');
    expect(store.peek('click', null)?.map((e) => e.username)).toEqual(['a']);
  });
});

describe('LeaderboardStore · 提交后作废', () => {
  it('提交成功即作废该范围快照，让紧随其后的刷新真正拉到新榜', async () => {
    apiMock.leaderboard.mockResolvedValue({ entries: [entry('a')] });
    apiMock.submitScore.mockResolvedValue({ status: 'improved' });
    const store = new LeaderboardStore();

    await store.ensure('click', null);
    expect(store.peek('click', null)).not.toBeNull();

    const mode: LeaderboardMode = 'click';
    const status = await store.submit(
      {
        mode,
        scopeProvince: null,
        scopeLabel: '全国',
        totalUnits: 340,
        correct: 12,
        wrong: 0,
        elapsedMs: 65_000,
        finishedAt: 1,
      },
      'token',
    );
    expect(status).toBe('improved');
    expect(store.peek('click', null)).toBeNull();
  });
});
