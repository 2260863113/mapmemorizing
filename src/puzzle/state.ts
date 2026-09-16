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
 * **困难档对「孤悬/极小」单位另有一档放宽**（见 `PuzzleSnapOptions.relaxedPx`）。
 */
export const SNAP_TOLERANCE_PX: Record<'easy' | 'hard', number> = { easy: 10, hard: 5 };

/** 之前的统一容差（仅作历史记录/文档引用，代码里不再使用）。 */
export const LEGACY_SNAP_TOLERANCE_PX = 15;

/** 磁吸判定与卡槽供应顺序的可调项（由 `PuzzleMode.ensureState()` 按难度与范围装配）。 */
export interface PuzzleSnapOptions {
  /** 基础容差：简单 10px / 困难 5px。 */
  basePx: number;
  /**
   * 「孤悬/极小」单位**还是独立一片（未成组）**时的放宽容差（困难档 15px）。
   * `null` / 省略 = 不放开（简单档就是这种：它本来就有绿色预告，10px 也够）。
   */
  relaxedPx?: number | null;
  /** 该片是否属于「孤悬/极小」集合（未成组时才享受放宽）。 */
  isSpecial?: (adcode: string) => boolean;
  /**
   * 该片是否属于「极小」（**只按面积**，海岛不算）：这类碎片在卡槽供应顺序里排到最后，
   * 免得用户早早把它们拿出来、放下后就再也找不到（澳门在 1x 下不到 1px）。
   */
  isTiny?: (adcode: string) => boolean;
}

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
  private readonly basePx: number;
  private readonly relaxedPx: number | null;
  private readonly isSpecial: (adcode: string) => boolean;
  private readonly isTiny: (adcode: string) => boolean;
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
    options: PuzzleSnapOptions = { basePx: SNAP_TOLERANCE_PX.easy },
    private readonly rng: () => number = Math.random,
  ) {
    this.basePx = options.basePx;
    this.relaxedPx = options.relaxedPx ?? null;
    this.isSpecial = options.isSpecial ?? (() => false);
    this.isTiny = options.isTiny ?? (() => false);
    for (const p of pieces) this.byAdcode.set(p.adcode, p);
    this.all = pieces.map((p) => p.adcode);
  }

  /** 开局/重开：清空、打乱、填满卡槽。 */
  start(): void {
    this.groups = [];
    this.groupSeq = 1;
    this.absorbed = 0;
    this.pool = supplyOrder(this.all, this.isTiny, this.rng);
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

  /** 基础容差（简单 10 / 困难 5），不含「孤悬/极小」的放宽。 */
  tolerancePx(): number {
    return this.basePx;
  }

  /**
   * 某片**此刻**适用的容差（探针/验收用）：孤悬/极小的片还没成组时是放宽值，
   * 已经吸进任何一组后回到基础容差。
   */
  toleranceForPiece(adcode: string): number {
    const group = this.groupOf(adcode);
    return this.toleranceOf(group ? group.pieces : [adcode]);
  }

  /**
   * 某"片集合"适用的容差。
   *
   * 用户口径（2026-09-16）：孤悬/极小的单位**还是单独一片**时放宽到 15px；
   * **一旦成了组就回到 5px**——放宽只是帮它"找到对象"，不是整局都变松。
   */
  private toleranceOf(pieces: string[]): number {
    if (this.relaxedPx === null) return this.basePx;
    if (pieces.length > 1) return this.basePx;
    const only = pieces[0];
    return only !== undefined && this.isSpecial(only) ? this.relaxedPx : this.basePx;
  }

  /** 两组判定取**较宽**的那个：拖广东靠近海南、或拖海南靠近广东都是 15px（用户口径）。 */
  private pairTolerance(a: string[], b: string[]): number {
    return Math.max(this.toleranceOf(a), this.toleranceOf(b));
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
      if (Math.hypot(other.dx - dx, other.dy - dy) > this.pairTolerance(pieces, other.pieces)) return false;
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
    if (Math.hypot(a.dx - b.dx, a.dy - b.dy) > this.pairTolerance(a.pieces, b.pieces)) return false;
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

/**
 * 卡槽供应顺序（用户口径 2026-09-16）：正常片打乱在前、**「极小」片一律排到最后**。
 *
 * 动机：澳门在 1x 下不到 1px、香港约 5px，早早从卡槽拿出来放到画布上，用户很可能再也找不到它。
 * 排到最后意味着它们只在别的片都出完之后才出现——那时画布上已经没几片，好找、也好判断位置。
 * 两组各自打乱，组内顺序仍是随机的（开局体验与以前一致）。
 */
export function supplyOrder(
  all: string[],
  isTiny: (adcode: string) => boolean,
  rng: () => number = Math.random,
): string[] {
  const normal = all.filter((a) => !isTiny(a));
  const tiny = all.filter((a) => isTiny(a));
  return [...shuffle(normal, rng), ...shuffle(tiny, rng)];
}
