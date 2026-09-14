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

/**
 * 磁吸容差（拼图 px，真值比例；不随视口缩放变化）——**按难度分档**（用户口径 2026-09-14）：
 * 简单 10px、困难 5px。两档都比最初的统一 15px 更严，困难档最严（5px 只有指甲盖大小）。
 *
 * 提示与容差是两件事：简单档有可吸附预告但要求更准，困难档没有预告、容差更小。
 */
export const SNAP_TOLERANCE_PX: Record<'easy' | 'hard', number> = { easy: 10, hard: 5 };

/** 之前的统一容差（仅作历史记录/文档引用，代码里不再使用）。 */
export const LEGACY_SNAP_TOLERANCE_PX = 15;

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
  /** 累计"吸附吸收掉的组数"：进度行按用户口径显示 1 + 它（起始 1，每次吸附 +1）。 */
  private absorbed = 0;

  constructor(
    pieces: PuzzlePieceDef[],
    private readonly adjacency: Set<string>,
    private readonly tolerance = SNAP_TOLERANCE_PX.easy,
    private readonly rng: () => number = Math.random,
  ) {
    for (const p of pieces) this.byAdcode.set(p.adcode, p);
    this.all = pieces.map((p) => p.adcode);
  }

  /** 开局/重开：清空、打乱、填满卡槽。 */
  start(): void {
    this.groups = [];
    this.groupSeq = 1;
    this.absorbed = 0;
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

  /** 某组的**总面积**（所含各片面积之和）：画布的上下覆盖按它排（见 view.renderStructure）。 */
  groupArea(group: PuzzleGroup): number {
    let sum = 0;
    for (const adcode of group.pieces) sum += this.byAdcode.get(adcode)?.area ?? 0;
    return sum;
  }

  /** 本组当前可吸上的容差（供探针/验收读，避免测试重复写死数字）。 */
  tolerancePx(): number {
    return this.tolerance;
  }

  /** 若此刻松手，哪些组会与本组吸上（拖动中高亮提示用，只读）。 */
  snapCandidates(groupId: number): PuzzleGroup[] {
    const group = this.groups.find((g) => g.id === groupId);
    return group ? this.candidatesFor(group.dx, group.dy, group.pieces) : [];
  }

  /**
   * 给定"若把 `pieces` 放在偏移 (dx,dy)"，会与哪些现有组吸合（只读，不改状态）。
   *
   * 拖动中的高亮提示与**点选→点放**的幽灵预览共用它：后者此刻还没有真正的组，
   * 只能按"将要落下的偏移"来算。
   */
  candidatesFor(dx: number, dy: number, pieces: string[]): PuzzleGroup[] {
    return this.groups.filter((other) => {
      if (other.pieces.some((p) => pieces.includes(p))) return false; // 同组不算
      if (Math.hypot(other.dx - dx, other.dy - dy) > this.tolerance) return false;
      return pieces.some((pa) => other.pieces.some((pb) => this.adjacency.has(pairKey(pa, pb))));
    });
  }

  /**
   * 松手：**手里这块主动吸附过去** —— 容差内的目标组不动，本组对齐到**目标的偏移**后并入，可连锁。
   *
   * 用户口径（2026-09-14）改过一次方向：最初是"别人移动到手里这块的位置"（不想让手里的块在松手瞬间
   * 跳走），现在反过来 —— 松手后是**被拖拽的碎片去吸附别人**，视觉上像把它"按"进已经拼好的那一块。
   * 连锁时每一步都对齐到当前那个目标的偏移，最终停在最后吸上的那一组的位置上。
   */
  drop(groupId: number): DropResult {
    const root = this.groups.find((g) => g.id === groupId);
    if (!root) return { mergedGroups: 0, complete: false };
    let merged = 0;
    for (;;) {
      const target = this.groups.find((g) => g.id !== root.id && this.pairWithinTolerance(root, g));
      if (!target) break;
      // 拖拽方挪过去（目标组原地不动）
      root.dx = target.dx;
      root.dy = target.dy;
      root.pieces = [...root.pieces, ...target.pieces].sort();
      this.groups = this.groups.filter((g) => g.id !== target.id);
      merged += 1;
      this.absorbed += 1;
    }
    return { mergedGroups: merged, complete: this.isComplete() };
  }

  /**
   * 进度行里的「已拼」个数（用户口径）：**起始 1，每发生一次吸附 +1**，
   * 而不是"从卡槽拿出来的片数"——它衡量的是拼合进度，全部拼好时正好等于总片数。
   */
  assembledCount(): number {
    return Math.min(this.all.length, 1 + this.absorbed);
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
