/**
 * 拼图的"谁和谁能拼在一起"：省级邻接 + 岛类的最近片兜底。
 *
 * 两条来源（用户口径）：
 *   1. **陆地相邻**：复用测验模式的省级邻接聚合（`buildProvinceAdjacency`，由 373 个地级单位的
 *      跨省相邻对聚合而来），只保留两端都在拼图里的片对。
 *   2. **岛类兜底**：零邻居的省级单位（实测是 **海南** 与 **台湾**，代码注释只提了台湾）
 *      各补一个"最近片"，度量用**两片几何 bbox 的最小间距**（不是中心点直线距离——
 *      中心点在细长/离散省份上会严重偏移，例如新疆、海南）。bbox 间距为 0 表示两框相接，
 *      取最小者；并列时按中心距离打破。
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
 * @param pieces          拼图碎片
 * @param provinceAdjacency 省级邻接（`buildProvinceAdjacency` 的输出；可缺省）
 */
export function buildPuzzleAdjacency(
  pieces: PuzzlePieceDef[],
  provinceAdjacency: Map<string, string[]>,
): Set<string> {
  const out = new Set<string>();
  const landConnected = new Set<string>();
  for (const piece of pieces) {
    for (const other of provinceAdjacency.get(piece.adcode) ?? []) {
      if (pieces.some((p) => p.adcode === other)) {
        out.add(pairKey(piece.adcode, other));
        landConnected.add(piece.adcode);
        landConnected.add(other);
      }
    }
  }
  // 岛类兜底：零邻居（或邻居都不在拼图里）的片各补一个最近片
  for (const piece of pieces) {
    if (landConnected.has(piece.adcode)) continue;
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
    if (best) out.add(pairKey(piece.adcode, best.adcode));
  }
  return out;
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
