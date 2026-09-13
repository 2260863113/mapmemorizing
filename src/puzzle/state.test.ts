import { describe, it, expect } from 'vitest';
import { PuzzleState, SLOT_COUNT, shuffle } from './state';
import { pairKey } from './adjacency';
import type { PuzzlePieceDef } from './pieces';

/** 造最简碎片：只要 adcode（几何/bbox 由状态机之外的地方使用）。 */
function piece(adcode: string): PuzzlePieceDef {
  return {
    adcode,
    name: adcode,
    label: adcode,
    polygons: [],
    seaIslets: [],
    bbox: [0, 0, 1, 1],
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

  it('磁吸：相邻两片偏移差在容差内 → 合并成一组并精确对齐', () => {
    const state = makeState();
    state.start();
    const a = state.take('A')!;
    state.moveGroup(a.id, 100, 50);
    expect(state.drop(a.id).mergedGroups).toBe(0); // 场上只有 A

    const b = state.take('B')!;
    state.moveGroup(b.id, 100 + 10, 50 - 8); // 差 (10,-8)，模长 12.8 ≤ 15
    const result = state.drop(b.id);
    expect(result.mergedGroups).toBe(1);
    expect(state.groups).toHaveLength(1);
    expect(state.groups[0].pieces).toEqual(['A', 'B']);
    // 对齐到**被拖动的一方**（这里是 B）：手里拿着的那块不该在松手瞬间跳走
    expect(state.groups[0].dx).toBeCloseTo(110, 9);
    expect(state.groups[0].dy).toBeCloseTo(42, 9);
    expect(result.complete).toBe(false);
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
