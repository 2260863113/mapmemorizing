/** 数值工具（消除多处重复的 clamp 实现）。 */

/** 把 value 钳制到 [min, max]；非有限值回落 min。 */
export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
