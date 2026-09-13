/**
 * 拼图的"谁和谁能拼在一起"：陆地相邻 + 岛类的最近片兜底 + **连通性修补**。
 *
 * 三条来源（用户口径）：
 *   1. **陆地相邻**：由调用方按范围给出邻居表——省级档用地级跨省相邻聚合出的省邻接，
 *      市级档用地级单位自己的 `neighbors`，世界档用国家 `neighbors`（iso）。
 *   2. **岛类兜底**：零邻居的单位（实测省级档是 **海南** 与 **台湾**，世界档有 39 个岛国/孤立国，
 *      如日本、新西兰、冰岛、马达加斯加、澳大利亚…）各补一个"最近片"，度量用
 *      **两片几何 bbox 的最小间距**（不是中心点直线距离——中心点在细长/离散单位上会严重偏移）。
 *      bbox 间距为 0 表示两框相接，取最小者；并列时按中心距离打破。
 *   3. **连通性修补**：兜底只给孤立片一条边，出来的图仍可能分成几个连通块（世界档实测 6 块：
 *      澳洲—巴新、新西兰—澳洲、马达加斯加、日本…各成一块）。**分成几块就永远拼不成一整块**，
 *      于是再按"跨块 bbox 最小间距"逐次搭桥，直到全图连通——这是"能拼完"的硬保证，
 *      与兜底同源（都用几何最近片），不是新增玩法。
 */
import type { PuzzlePieceDef } from './pieces';

/** 片对的规范化 key（adcode 升序，避免 a|b 与 b|a 两份）。 */
export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** 两个经纬度 bbox 的最小间距（度）：相交或相接时为 0。 */
export function bboxGap(
  a: [number, number, number, number],
  b: [number, number, number, number],
): number {
  const dx = Math.max(0, Math.max(a[0] - b[2], b[0] - a[2]));
  const dy = Math.max(0, Math.max(a[1] - b[3], b[1] - a[3]));
  return Math.hypot(dx, dy);
}

function centerDistance(a: PuzzlePieceDef, b: PuzzlePieceDef): number {
  return Math.hypot(a.origin[0] - b.origin[0], a.origin[1] - b.origin[1]);
}

/**
 * 构建拼图邻接集合。
 *
 * @param pieces       当前范围的碎片
 * @param neighboursOf 取某片的陆地邻居 id 列表（省级档传聚合后的省邻接，其它档传各自邻居表）
 */
export function buildPuzzleAdjacency(
  pieces: PuzzlePieceDef[],
  neighboursOf: (adcode: string) => string[],
): Set<string> {
  const out = new Set<string>();
  const landConnected = new Set<string>();
  const known = new Set(pieces.map((p) => p.adcode));
  for (const piece of pieces) {
    for (const other of neighboursOf(piece.adcode)) {
      if (!known.has(other)) continue;
      out.add(pairKey(piece.adcode, other));
      landConnected.add(piece.adcode);
      landConnected.add(other);
    }
  }
  // 岛类兜底：零邻居（或邻居都不在本次范围内）的片各补一个最近片
  for (const piece of pieces) {
    if (landConnected.has(piece.adcode)) continue;
    const best = nearestPiece(piece, pieces);
    if (best) out.add(pairKey(piece.adcode, best.adcode));
  }
  connectComponents(pieces, out);
  return out;
}

/** 离 `piece` 最近的另一片（bbox 最小间距，并列时比中心距离）。 */
function nearestPiece(piece: PuzzlePieceDef, pieces: PuzzlePieceDef[]): PuzzlePieceDef | null {
  let best: PuzzlePieceDef | null = null;
  let bestGap = Number.POSITIVE_INFINITY;
  let bestCenter = Number.POSITIVE_INFINITY;
  for (const other of pieces) {
    if (other.adcode === piece.adcode) continue;
    const gap = bboxGap(piece.bbox, other.bbox);
    const center = centerDistance(piece, other);
    if (gap < bestGap - 1e-9 || (Math.abs(gap - bestGap) <= 1e-9 && center < bestCenter)) {
      best = other;
      bestGap = gap;
      bestCenter = center;
    }
  }
  return best;
}

/** 按现有边把碎片分成连通块（返回每块的 adcode 列表）。 */
export function puzzleComponents(pieces: PuzzlePieceDef[], adjacency: Set<string>): string[][] {
  const neighbours = new Map<string, string[]>();
  for (const key of adjacency) {
    const [a, b] = key.split('|');
    for (const [from, to] of [
      [a, b],
      [b, a],
    ]) {
      const list = neighbours.get(from);
      if (list) list.push(to);
      else neighbours.set(from, [to]);
    }
  }
  const seen = new Set<string>();
  const out: string[][] = [];
  for (const piece of pieces) {
    if (seen.has(piece.adcode)) continue;
    const stack = [piece.adcode];
    const comp: string[] = [];
    seen.add(piece.adcode);
    while (stack.length) {
      const cur = stack.pop()!;
      comp.push(cur);
      for (const next of neighbours.get(cur) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        stack.push(next);
      }
    }
    out.push(comp);
  }
  return out;
}

/**
 * 连通性修补：反复把"跨块几何最近"的两块用一条边连起来，直到只剩一块。
 *
 * 只在**块间**找最小 bbox 间距（块内已经连通，不需要再比）。世界档实测 6 块 → 5 次搭桥，
 * 每次桥都是一对地理上最近的片（澳洲↔印尼、新西兰↔澳洲、日本↔韩国…），拼图手感自然。
 */
function connectComponents(pieces: PuzzlePieceDef[], adjacency: Set<string>): void {
  const byAdcode = new Map(pieces.map((p) => [p.adcode, p]));
  let comps = puzzleComponents(pieces, adjacency);
  while (comps.length > 1) {
    let bestI = 0;
    let bestJ = 1;
    let bestGap = Number.POSITIVE_INFINITY;
    let bestCenter = Number.POSITIVE_INFINITY;
    for (let i = 0; i < comps.length; i += 1) {
      for (let j = i + 1; j < comps.length; j += 1) {
        for (const a of comps[i]) {
          const pa = byAdcode.get(a);
          if (!pa) continue;
          for (const b of comps[j]) {
            const pb = byAdcode.get(b);
            if (!pb) continue;
            const gap = bboxGap(pa.bbox, pb.bbox);
            const center = centerDistance(pa, pb);
            if (gap < bestGap - 1e-9 || (Math.abs(gap - bestGap) <= 1e-9 && center < bestCenter)) {
              bestI = i;
              bestJ = j;
              bestGap = gap;
              bestCenter = center;
            }
          }
        }
      }
    }
    const [a, b] = [comps[bestI][0], comps[bestJ][0]];
    adjacency.add(pairKey(a, b));
    comps = comps.map((c, idx) => (idx === bestI ? [...c, ...comps[bestJ]] : c)).filter((_, idx) => idx !== bestJ);
  }
}

/** 某片在拼图里能与之吸附的片（邻接的对称闭包）。 */
export function neighboursInPuzzle(adjacency: Set<string>, adcode: string): Set<string> {
  const out = new Set<string>();
  for (const key of adjacency) {
    const [a, b] = key.split('|');
    if (a === adcode) out.add(b);
    else if (b === adcode) out.add(a);
  }
  return out;
}
