import { describe, it, expect } from 'vitest';
import { PuzzleState, SLOT_COUNT, SNAP_TOLERANCE_PX, shuffle } from './state';
import { pairKey } from './adjacency';
import type { PuzzlePieceDef } from './pieces';

/** 造最简碎片：只要 adcode（几何/bbox 由状态机之外的地方使用）。 */
function piece(adcode: string, area = 1): PuzzlePieceDef {
  return {
    adcode,
    name: adcode,
    label: adcode,
    polygons: [],
    seaIslets: [],
    bbox: [0, 0, 1, 1],
    area,
    origin: [0.5, 0.5],
    labelAnchor: [0.5, 0.5],
  };
}

/** A–B–C 三片链式相邻，D 孤立的四个碎片。 */
function makeState(tolerance = 15) {
  const pieces = ['A', 'B', 'C', 'D'].map(piece);
  const adjacency = new Set([pairKey('A', 'B'), pairKey('B', 'C')]);
  // 固定 rng：抽取顺序恒为 A,B,C,D
  const state = new PuzzleState(pieces, adjacency, tolerance, () => 0.999);
  return state;
}

describe('PuzzleState', () => {
  it('开局：卡槽填满 3 个、池子里剩 1 个、无重复', () => {
    const state = makeState();
    state.start();
    expect(state.slots).toHaveLength(SLOT_COUNT);
    expect(state.slots).toEqual(['A', 'B', 'C']);
    expect(state.placedCount()).toBe(0);
    expect(state.hasUnplaced()).toBe(true);
    expect(state.isComplete()).toBe(false);
  });

  it('拖出卡槽：槽位由池子补上，画布上多一个单片组', () => {
    const state = makeState();
    state.start();
    const group = state.take('A');
    expect(group).not.toBeNull();
    expect(group!.pieces).toEqual(['A']);
    expect(state.slots).toEqual(['B', 'C', 'D']); // 从池子补进 D
    expect(state.placedCount()).toBe(1);
    expect(state.hasUnplaced()).toBe(true);
    // 拿过的片不能再拿
    expect(state.take('A')).toBeNull();
  });

  it('磁吸：相邻两片偏移差在容差内 → 合并成一组，且**被拖拽的那片主动吸附过去**', () => {
    const state = makeState();
    state.start();
    const a = state.take('A')!;
    state.moveGroup(a.id, 100, 50);
    expect(state.drop(a.id).mergedGroups).toBe(0); // 场上只有 A

    const b = state.take('B')!;
    state.moveGroup(b.id, 100 + 10, 50 - 8); // 差 (10,-8)，模长 12.8 ≤ 15（测试用容差）
    const result = state.drop(b.id);
    expect(result.mergedGroups).toBe(1);
    expect(state.groups).toHaveLength(1);
    expect(state.groups[0].pieces).toEqual(['A', 'B']);
    // 用户口径（2026-09-14）：**拖拽方挪到目标组的位置**，目标组原地不动。
    // 于是 B 松手后跳到 A 的 (100,50)，而不是把 A 拽到 B 的 (110,42)。
    expect(state.groups[0].dx).toBeCloseTo(100, 9);
    expect(state.groups[0].dy).toBeCloseTo(50, 9);
    expect(result.complete).toBe(false);
  });

  it('容差按难度分档：简单 10px / 困难 5px（同一对偏移差在困难档吸不上）', () => {
    expect(SNAP_TOLERANCE_PX.easy).toBe(10);
    expect(SNAP_TOLERANCE_PX.hard).toBe(5);
    const setup = (tolerance: number) => {
      const state = makeState(tolerance);
      state.start();
      const a = state.take('A')!;
      state.moveGroup(a.id, 0, 0);
      state.drop(a.id);
      const b = state.take('B')!;
      state.moveGroup(b.id, 8, 0); // 差 8px：简单档（10）吸得上，困难档（5）吸不上
      return { state, b };
    };
    expect(setup(SNAP_TOLERANCE_PX.easy).state.drop(setup(SNAP_TOLERANCE_PX.easy).b.id).mergedGroups).toBe(1);
    const hard = setup(SNAP_TOLERANCE_PX.hard);
    expect(hard.state.drop(hard.b.id).mergedGroups).toBe(0);
    expect(hard.state.groups).toHaveLength(2);
    // 困难档 5px 内仍然吸得上
    const hard2 = setup(SNAP_TOLERANCE_PX.hard);
    hard2.state.moveGroup(hard2.b.id, 4, 0);
    expect(hard2.state.drop(hard2.b.id).mergedGroups).toBe(1);
  });

  it('groupArea：组的总面积 = 组内各片面积之和（画布上下层按它排）', () => {
    const state = makeState();
    state.start();
    const a = state.take('A')!;
    const b = state.take('B')!;
    state.moveGroup(a.id, 0, 0);
    state.moveGroup(b.id, 5, 0);
    state.drop(a.id);
    state.drop(b.id);
    const group = state.groups[0];
    expect(group.pieces).toEqual(['A', 'B']);
    const sum = group.pieces.reduce((acc, adcode) => acc + (state.def(adcode)?.area ?? 0), 0);
    expect(state.groupArea(group)).toBeCloseTo(sum, 9);
    expect(state.groupArea(group)).toBeGreaterThan(state.def('A')!.area);
  });

  it('不相邻的两片即使重叠也不吸（D 与谁都不相邻）', () => {
    const state = makeState();
    state.start();
    const a = state.take('A')!;
    state.moveGroup(a.id, 0, 0);
    state.drop(a.id);
    const d = state.take('D')!;
    state.moveGroup(d.id, 1, 1);
    expect(state.drop(d.id).mergedGroups).toBe(0);
    expect(state.groups).toHaveLength(2);
  });

  it('超出容差不成组', () => {
    const state = makeState();
    state.start();
    const a = state.take('A')!;
    state.moveGroup(a.id, 0, 0);
    state.drop(a.id);
    const b = state.take('B')!;
    state.moveGroup(b.id, 16, 0); // 16 > 15
    expect(state.drop(b.id).mergedGroups).toBe(0);
    expect(state.groups).toHaveLength(2);
  });

  it('连锁合并：C 靠近已合并的 A+B，三片并成一组', () => {
    const state = makeState();
    state.start();
    const a = state.take('A')!;
    const b = state.take('B')!;
    state.moveGroup(a.id, 200, 100);
    state.moveGroup(b.id, 205, 100); // 与 A 相差 5 → 吸
    state.drop(b.id);
    expect(state.groups[0].pieces).toEqual(['A', 'B']);

    const c = state.take('C')!;
    state.moveGroup(c.id, 208, 104); // 与 A+B 相差 (8,4) → 吸
    const result = state.drop(c.id);
    expect(result.mergedGroups).toBe(1);
    expect(state.groups).toHaveLength(1);
    expect(state.groups[0].pieces).toEqual(['A', 'B', 'C']);
  });

  it('snapCandidates 只报容差内且相邻的组（拖动中高亮用，不改状态）', () => {
    const state = makeState();
    state.start();
    const a = state.take('A')!;
    state.moveGroup(a.id, 0, 0);
    state.drop(a.id);
    const d = state.take('D')!;
    state.moveGroup(d.id, 3, 3); // 与 A 重叠但不相邻
    expect(state.snapCandidates(d.id)).toHaveLength(0);
    state.moveGroup(d.id, 500, 500);
    expect(state.snapCandidates(d.id)).toHaveLength(0);

    const b = state.take('B')!;
    state.moveGroup(b.id, 5, 0); // 与 A 相邻且在容差内
    expect(state.snapCandidates(b.id).map((g) => g.pieces)).toEqual([['A']]);
  });

  it('candidatesFor：点选→点放时按"将要落下的偏移"预告会拼上谁（不改状态）', () => {
    const state = makeState();
    state.start();
    const a = state.take('A')!;
    state.moveGroup(a.id, 0, 0);
    state.drop(a.id);
    // 幽灵预览：B 若落在偏移 (8,6) 处会与 A 吸上
    expect(state.candidatesFor(8, 6, ['B']).map((g) => g.pieces)).toEqual([['A']]);
    // 超出容差 / 不相邻 / 同组，都不算
    expect(state.candidatesFor(40, 40, ['B'])).toHaveLength(0);
    expect(state.candidatesFor(2, 2, ['D'])).toHaveLength(0);
    expect(state.candidatesFor(0, 0, ['A'])).toHaveLength(0);
    expect(state.groups).toHaveLength(1); // 只读，没改状态
  });

  it('「已拼」按用户口径：起始 1，每次吸附 +1（与从卡槽拿出的片数无关）', () => {
    const state = makeState();
    state.start();
    expect(state.assembledCount()).toBe(1); // 起始 1
    const a = state.take('A')!;
    state.moveGroup(a.id, 0, 0);
    state.drop(a.id);
    expect(state.assembledCount()).toBe(1); // 只是拿出来，没有吸附 → 不变
    const b = state.take('B')!;
    state.moveGroup(b.id, 5, 0);
    state.drop(b.id); // 吸上 A
    expect(state.assembledCount()).toBe(2);
    const c = state.take('C')!;
    state.moveGroup(c.id, 8, 0);
    state.drop(c.id); // 吸上 A+B
    expect(state.assembledCount()).toBe(3);
    expect(state.placedCount()).toBe(3);
    expect(state.isComplete()).toBe(false); // D 还没放
  });

  it('一次放下可能连锁吸收两个组（彼此不相邻、但都与手里这片相邻）', () => {
    // 京津冀模型：北京(A) 与 天津(B) 彼此不相邻，但都与 河北(C) 相邻 ——
    // 于是它们各自独立成组，直到 C 落进容差里把两块都吸过来。
    const pieces = ['A', 'B', 'C', 'D'].map(piece);
    const adjacency = new Set([pairKey('A', 'C'), pairKey('B', 'C')]);
    const state = new PuzzleState(pieces, adjacency, 15, () => 0.999);
    state.start();
    const a = state.take('A')!;
    state.moveGroup(a.id, 0, 0);
    state.drop(a.id);
    const b = state.take('B')!;
    state.moveGroup(b.id, 5, 0);
    expect(state.drop(b.id).mergedGroups).toBe(0); // A–B 不相邻 → 两块独立
    expect(state.groups).toHaveLength(2);
    expect(state.assembledCount()).toBe(1);

    const c = state.take('C')!;
    state.moveGroup(c.id, 2, 0); // 与 A、B 都在容差内
    const result = state.drop(c.id);
    expect(result.mergedGroups).toBe(2);
    expect(state.assembledCount()).toBe(3);
    expect(state.groups).toHaveLength(1);
    // 连锁时每吸一组就挪到那一组的位置：先吸 A(0)，再连锁吸 B(5) → 最终停在 B
    expect(state.groups[0].dx).toBeCloseTo(5, 9);
  });

  it('四片全部吸成一组才算完成', () => {
    const state = makeState();
    state.start();
    const a = state.take('A')!;
    const b = state.take('B')!;
    const c = state.take('C')!;
    const d = state.take('D')!;
    state.moveGroup(a.id, 0, 0);
    state.drop(a.id);
    state.moveGroup(b.id, 2, 0);
    state.drop(b.id);
    state.moveGroup(c.id, 4, 0);
    expect(state.drop(c.id).complete).toBe(false); // D 还没放下
    state.moveGroup(d.id, 300, 300); // D 不相邻，放哪儿都进不了同一组
    const result = state.drop(d.id);
    expect(result.mergedGroups).toBe(0);
    expect(state.isComplete()).toBe(false);
    expect(state.hasUnplaced()).toBe(false);
  });

  it('全部放下且都在容差内 → 一整块 = 完成', () => {
    const pieces = ['A', 'B', 'C'].map(piece);
    const adjacency = new Set([pairKey('A', 'B'), pairKey('B', 'C')]);
    const state = new PuzzleState(pieces, adjacency, 15, () => 0.999);
    state.start();
    for (const adcode of ['A', 'B', 'C']) {
      const group = state.take(adcode)!;
      state.moveGroup(group.id, 10, 20);
      state.drop(group.id);
    }
    expect(state.groups).toHaveLength(1);
    expect(state.groups[0].pieces).toEqual(['A', 'B', 'C']);
    expect(state.placedCount()).toBe(3);
    expect(state.isComplete()).toBe(true);
  });
});

describe('shuffle', () => {
  it('用注入的 rng 时顺序确定，且不改变原数组', () => {
    const input = ['a', 'b', 'c', 'd'];
    const out = shuffle(input, () => 0.5);
    expect(input).toEqual(['a', 'b', 'c', 'd']);
    expect(out).toHaveLength(4);
    expect([...out].sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(shuffle(input, () => 0.5)).toEqual(out);
  });
});
