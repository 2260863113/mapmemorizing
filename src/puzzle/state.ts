/**
 * 拼图状态机（纯逻辑，无 DOM）：卡槽抽签、碎片放置、**松手时磁吸成组**、整块判定。
 *
 * 位置模型（关键设计）：
 *   每个碎片的多边形用的是**真值经纬度**，投影后即为它的"正确位置"；
 *   用户拖动只是在它身上加一个**组偏移 (dx, dy)**。
 *   于是"两片是否摆对了"= 两片所属组的偏移是否相等 —— 相邻片对只要偏移差 ≤ 容差，
 *   把其中一组的偏移改成另一组的值就实现了**零缝隙精确对齐**（用户选的磁吸口径）。
 *   整幅拼图的绝对位置是自由的（用户可以把它摆在画布任意处），所以偏移没有基准值。
 */
import type { PuzzlePieceDef } from './pieces';
import { pairKey } from './adjacency';

/** 左侧卡槽数量（用户口径：三个）。 */
export const SLOT_COUNT = 3;

/** 磁吸容差（拼图 px，真实比例；不随视口缩放变化）。 */
export const SNAP_TOLERANCE_PX = 15;

export interface PuzzleGroup {
  id: number;
  /** 组内碎片 adcode（有序：便于快照比对）。 */
  pieces: string[];
  dx: number;
  dy: number;
}

export interface DropResult {
  /** 本次放下后新并入的组数（0 = 没吸上）。 */
  mergedGroups: number;
  /** 放下后是否达成"整块"（34 片全在一组）。 */
  complete: boolean;
}

export class PuzzleState {
  private readonly byAdcode = new Map<string, PuzzlePieceDef>();
  private readonly all: string[];
  /** 尚未进过卡槽的碎片（已打乱的抽取池）。 */
  private pool: string[] = [];
  slots: string[] = [];
  groups: PuzzleGroup[] = [];
  private groupSeq = 1;

  constructor(
    pieces: PuzzlePieceDef[],
    private readonly adjacency: Set<string>,
    private readonly tolerance = SNAP_TOLERANCE_PX,
    private readonly rng: () => number = Math.random,
  ) {
    for (const p of pieces) this.byAdcode.set(p.adcode, p);
    this.all = pieces.map((p) => p.adcode);
  }

  /** 开局/重开：清空、打乱、填满卡槽。 */
  start(): void {
    this.groups = [];
    this.groupSeq = 1;
    this.pool = shuffle(this.all, this.rng);
    this.slots = [];
    this.refillSlots();
  }

  private refillSlots(): void {
    while (this.slots.length < SLOT_COUNT && this.pool.length) {
      this.slots.push(this.pool.shift()!);
    }
  }

  /** 是否还有碎片在卡槽或池子里。 */
  hasUnplaced(): boolean {
    return this.slots.length > 0 || this.pool.length > 0;
  }

  /** 已放到画布上的碎片数。 */
  placedCount(): number {
    return this.groups.reduce((sum, g) => sum + g.pieces.length, 0);
  }

  totalCount(): number {
    return this.all.length;
  }

  def(adcode: string): PuzzlePieceDef | null {
    return this.byAdcode.get(adcode) ?? null;
  }

  /** 全部碎片 adcode（视图按它生成 path）。 */
  adcodes(): string[] {
    return [...this.all];
  }

  groupOf(adcode: string): PuzzleGroup | null {
    return this.groups.find((g) => g.pieces.includes(adcode)) ?? null;
  }

  /** 以某片为起点拖出卡槽：返回新建的单片组（偏移暂为 0，由调用方立即设为落点）。 */
  take(adcode: string): PuzzleGroup | null {
    const idx = this.slots.indexOf(adcode);
    if (idx < 0) return null;
    this.slots.splice(idx, 1);
    this.refillSlots();
    const group: PuzzleGroup = { id: this.groupSeq++, pieces: [adcode], dx: 0, dy: 0 };
    this.groups.push(group);
    return group;
  }

  /**
   * 取任意一片（卡槽里或仍在抽取池里）：游戏里只有卡槽能拖出，
   * 但探针需要能直接摆指定片（验证吸附判定），故单开一个入口。
   */
  takeAny(adcode: string): PuzzleGroup | null {
    const group = this.groupOf(adcode) ?? this.take(adcode);
    if (group) return group;
    const poolIdx = this.pool.indexOf(adcode);
    if (poolIdx < 0) return null;
    this.pool.splice(poolIdx, 1);
    const created: PuzzleGroup = { id: this.groupSeq++, pieces: [adcode], dx: 0, dy: 0 };
    this.groups.push(created);
    return created;
  }

  /** 移动整组到绝对偏移（拖动中每帧调用，不做吸附）。 */
  moveGroup(id: number, dx: number, dy: number): void {
    const group = this.groups.find((g) => g.id === id);
    if (!group) return;
    group.dx = dx;
    group.dy = dy;
  }

  /** 若此刻松手，哪些组会与本组吸上（拖动中高亮提示用，只读）。 */
  snapCandidates(groupId: number): PuzzleGroup[] {
    const group = this.groups.find((g) => g.id === groupId);
    if (!group) return [];
    return this.groups.filter((other) => other.id !== groupId && this.pairWithinTolerance(group, other));
  }

  /**
   * 松手：以本组为基准做磁吸 —— 容差内的组**对齐到本组偏移**后并入本组，可连锁（合并后再检查）。
   *
   * 为什么是"对齐到被拖动的一方"：用户手里拿着的那块不该在松手瞬间跳走。
   */
  drop(groupId: number): DropResult {
    const root = this.groups.find((g) => g.id === groupId);
    if (!root) return { mergedGroups: 0, complete: false };
    let merged = 0;
    for (;;) {
      const target = this.groups.find((g) => g.id !== root.id && this.pairWithinTolerance(root, g));
      if (!target) break;
      target.dx = root.dx;
      target.dy = root.dy;
      root.pieces = [...root.pieces, ...target.pieces].sort();
      this.groups = this.groups.filter((g) => g.id !== target.id);
      merged += 1;
    }
    return { mergedGroups: merged, complete: this.isComplete() };
  }

  /** 两组的偏移差是否在容差内，且两组之间**存在相邻片对**。 */
  private pairWithinTolerance(a: PuzzleGroup, b: PuzzleGroup): boolean {
    if (Math.hypot(a.dx - b.dx, a.dy - b.dy) > this.tolerance) return false;
    for (const pa of a.pieces) {
      for (const pb of b.pieces) {
        if (this.adjacency.has(pairKey(pa, pb))) return true;
      }
    }
    return false;
  }

  isComplete(): boolean {
    return this.all.length > 0 && this.groups.length === 1 && this.groups[0].pieces.length === this.all.length;
  }
}

/** Fisher–Yates（注入 rng 便于单测确定顺序）。 */
export function shuffle<T>(items: T[], rng: () => number = Math.random): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
