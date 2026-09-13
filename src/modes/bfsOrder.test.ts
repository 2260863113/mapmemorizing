import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bfsStep } from './bfsOrder';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** N×N 网格图：每个格子与上下左右相邻，坐标即 id。 */
function grid(n: number) {
  const ids: string[] = [];
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) ids.push(`${x},${y}`);
  const neighborsOf = (id: string) => {
    const [x, y] = id.split(',').map(Number);
    return [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]
      .filter(([a, b]) => a >= 0 && b >= 0 && a < n && b < n)
      .map(([a, b]) => `${a},${b}`);
  };
  const centerOf = (id: string) => id.split(',').map(Number) as [number, number];
  return { ids, neighborsOf, centerOf };
}

/**
 * 空洞判定：某个**未作答**单位的**全部邻居都已作答**，且它不在前沿队列里。
 *
 * 注意不能用「已作答集合是否连通」当判据 —— 旧实现每步都走向一个未作答邻居，
 * 已作答集合天然连通（就是一条路径），但它照样会围出空洞。
 */
function countHoles(ids: string[], neighborsOf: (id: string) => string[], done: Set<string>, frontier: Set<string>) {
  let holes = 0;
  for (const id of ids) {
    if (done.has(id) || frontier.has(id)) continue;
    const nbs = neighborsOf(id);
    if (nbs.length && nbs.every((x) => done.has(x))) holes++;
  }
  return holes;
}

/** 用 bfsStep 跑完整个池，返回出题顺序 + 每一步的空洞数。 */
function runBfs(ids: string[], neighborsOf: (id: string) => string[], centerOf: (id: string) => [number, number], start: string) {
  const done = new Set<string>();
  let queue: string[] = [start];
  const order: string[] = [];
  const holeCounts: number[] = [];
  for (let guard = 0; guard < ids.length + 5; guard++) {
    const step = bfsStep({ ids, neighborsOf, isDone: (id) => done.has(id), queue, seedRef: centerOf(start), centerOf });
    if (!step.next) break;
    queue = step.queue;
    done.add(step.next);
    order.push(step.next);
    holeCounts.push(countHoles(ids, neighborsOf, done, new Set(queue)));
  }
  return { order, holeCounts };
}

/** 旧的贪心游走（邻居里随机取 + 最近优先），仅用于证明本测试确实能抓出缺陷。 */
function runGreedy(ids: string[], neighborsOf: (id: string) => string[], centerOf: (id: string) => [number, number], seedRng: number) {
  let rnd = seedRng;
  const rand = () => ((rnd = (rnd * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const done = new Set<string>();
  let last: string | null = ids[0];
  let maxHoles = 0;
  for (let i = 0; i < ids.length; i++) {
    let pick: string | null = null;
    if (i > 0 && last) {
      const cand: string[] = neighborsOf(last).filter((a) => !done.has(a));
      if (cand.length) pick = cand[Math.floor(rand() * cand.length)];
    }
    if (!pick) {
      const rest = ids.filter((a) => !done.has(a));
      let best = rest[0];
      let bd = Number.POSITIVE_INFINITY;
      for (const a of rest) {
        const d = (centerOf(a)[0] - centerOf(last ?? a)[0]) ** 2 + (centerOf(a)[1] - centerOf(last ?? a)[1]) ** 2;
        if (d < bd) { bd = d; best = a; }
      }
      pick = best;
    }
    done.add(pick);
    last = pick;
    // 旧实现没有前沿队列，故 frontier 为空集
    maxHoles = Math.max(maxHoles, countHoles(ids, neighborsOf, done, new Set()));
  }
  return maxHoles;
}

describe('bfsStep（顺序模式的严格广度优先）', () => {
  it('不出现空洞：全程没有任何「被包住的未作答单位」（5×5 / 8×8 / 12×12）', () => {
    for (const n of [5, 8, 12]) {
      const { ids, neighborsOf, centerOf } = grid(n);
      const { order, holeCounts } = runBfs(ids, neighborsOf, centerOf, '0,0');
      expect(order, `${n}×${n} 应出满`).toHaveLength(n * n);
      expect(Math.max(...holeCounts), `${n}×${n} 出现空洞`).toBe(0);
    }
  });

  it('从中心出发同样无空洞（不是靠「贴着边界走」侥幸）', () => {
    const { ids, neighborsOf, centerOf } = grid(9);
    const { order, holeCounts } = runBfs(ids, neighborsOf, centerOf, '4,4');
    expect(order).toHaveLength(81);
    expect(Math.max(...holeCounts)).toBe(0);
  });

  it('本测试有牙：旧的贪心游走会被这条断言抓出来', () => {
    const { ids, neighborsOf, centerOf } = grid(12);
    // 旧实现在多个随机种子下都会围出空洞
    const worst = Math.max(...[1, 7, 42, 99, 12345].map((s) => runGreedy(ids, neighborsOf, centerOf, s)));
    expect(worst, '若为 0 说明这条断言已经失去鉴别力').toBeGreaterThan(0);
  });

  it('严格逐层：出题的层次单调不降，且同层内不夹更深的层', () => {
    const { ids, neighborsOf, centerOf } = grid(6);
    const { order } = runBfs(ids, neighborsOf, centerOf, '0,0');
    const dist = (id: string) => {
      const [x, y] = id.split(',').map(Number);
      return x + y; // 从 (0,0) 出发的曼哈顿距离 = BFS 层
    };
    const layers = order.map(dist);
    for (let i = 1; i < layers.length; i++) {
      expect(layers[i], `第 ${i} 步层次回退`).toBeGreaterThanOrEqual(layers[i - 1]);
    }
    const first = new Map<number, number>();
    const lastSeen = new Map<number, number>();
    layers.forEach((d, i) => {
      if (!first.has(d)) first.set(d, i);
      lastSeen.set(d, i);
    });
    for (const [d, f] of first) {
      const l = lastSeen.get(d) as number;
      for (let i = f; i <= l; i++) expect(layers[i], '同层区间内夹了更深的层').toBe(d);
    }
  });

  it('池外邻居被忽略：不会出到当前范围之外的单位', () => {
    // 链 0-1-2-3-4，但池子只含 0,1,2（相当于下钻后 3、4 在范围外）
    const chain = ['0', '1', '2', '3', '4'];
    const neighborsOf = (id: string) => {
      const i = Number(id);
      return [chain[i - 1], chain[i + 1]].filter((x) => x !== undefined);
    };
    const centerOf = (id: string) => [Number(id), 0] as [number, number];
    const ids = ['0', '1', '2'];
    const done = new Set<string>();
    let queue: string[] = ['0'];
    const order: string[] = [];
    for (let i = 0; i < 10; i++) {
      const step = bfsStep({ ids, neighborsOf, isDone: (x) => done.has(x), queue, seedRef: [0, 0], centerOf });
      if (!step.next) break;
      queue = step.queue;
      done.add(step.next);
      order.push(step.next);
    }
    expect(order.slice().sort()).toEqual(['0', '1', '2']);
    expect(order).not.toContain('3');
    expect(order).not.toContain('4');
  });

  it('不连通分量（岛屿）走 BFS 森林：先跑完近分量再换下一个，且各自无空洞', () => {
    const neighborsOf = (id: string) =>
      id === 'a1' ? ['a2'] : id === 'a2' ? ['a1'] : id === 'b1' ? ['b2'] : ['b1'];
    const centerOf = (id: string) => (id.startsWith('a') ? [0, 0] : [100, 100]) as [number, number];
    const ids = ['a1', 'a2', 'b1', 'b2'];
    const done = new Set<string>();
    let queue: string[] = [];
    const order: string[] = [];
    for (let i = 0; i < 10; i++) {
      const step = bfsStep({ ids, neighborsOf, isDone: (x) => done.has(x), queue, seedRef: [0, 0], centerOf });
      if (!step.next) break;
      queue = step.queue;
      done.add(step.next);
      order.push(step.next);
    }
    expect(order).toHaveLength(4);
    expect(order.slice(0, 2).sort()).toEqual(['a1', 'a2']);
    expect(order.slice(2).sort()).toEqual(['b1', 'b2']);
  });

  it('作答过的单位从队列剔除，不重复出题', () => {
    const { ids, neighborsOf, centerOf } = grid(4);
    const { order } = runBfs(ids, neighborsOf, centerOf, '0,0');
    expect(new Set(order).size).toBe(order.length);
    expect(order).toHaveLength(16);
  });

  it('池子为空或全部作答完时返回 null，不抛异常', () => {
    const { ids, neighborsOf, centerOf } = grid(2);
    expect(bfsStep({ ids, neighborsOf, isDone: () => true, queue: [], seedRef: [0, 0], centerOf }).next).toBe(null);
    expect(bfsStep({ ids: [], neighborsOf, isDone: () => false, queue: [], seedRef: [0, 0], centerOf }).next).toBe(null);
  });
});

describe('真实数据：世界国家邻接图上的 BFS', () => {
  const countries = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data/countries.json'), 'utf8')).countries as {
    iso: string;
    center: [number, number];
    neighbors: string[];
  }[];

  it('194 国全池跑完、无重复、无空洞（分量边界处才允许跳跃）', () => {
    const ids = countries.map((c) => c.iso);
    const byIso = new Map(countries.map((c) => [c.iso, c]));
    const neighborsOf = (id: string) => byIso.get(id)?.neighbors ?? [];
    const centerOf = (id: string) => byIso.get(id)?.center ?? [0, 0];

    const done = new Set<string>();
    let queue: string[] = ['CHN'];
    const order: string[] = [];
    let componentStart = 0;
    for (let i = 0; i < ids.length + 5; i++) {
      const step = bfsStep({ ids, neighborsOf, isDone: (x) => done.has(x), queue, seedRef: centerOf('CHN'), centerOf });
      if (!step.next) break;
      queue = step.queue;
      done.add(step.next);
      order.push(step.next);
      // 空洞判定按「当前连通分量」分段：跨国分量处会重新播种，是 BFS 森林的正常现象
      if (i > componentStart && !neighborsOf(order[i]).some((nb) => new Set(order.slice(componentStart, i)).has(nb))) {
        componentStart = i;
      }
      const seg = order.slice(componentStart);
      const component = new Set(seg);
      let holes = 0;
      for (const id of seg) {
        if (id === order[i]) continue;
        const nbs = neighborsOf(id).filter((x) => !component.has(x));
        if (!nbs.length) continue;
        if (nbs.every((x) => done.has(x))) holes++;
      }
      expect(holes, `${order[i]} 这一步在分量内出现了空洞`).toBe(0);
    }
    expect(order).toHaveLength(194);
    expect(new Set(order).size).toBe(194);
    expect(order[0]).toBe('CHN');
  });
});
