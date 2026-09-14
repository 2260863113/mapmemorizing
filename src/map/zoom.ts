/**
 * 地图与拼图**共用**的缩放范围。
 *
 * 为什么单独成模块：`MIN_ZOOM = 0.8` / `MAX_ZOOM = 28` 原先在 `map/renderer.ts` 与
 * `puzzle/view.ts` 里**各定义一份**，只靠一句注释维系同步（view.ts：「缩放范围与地图页
 * 完全一致」）。但拼图口径明确要求「1x 与地图 1x 是同一比例」「缩放范围也与地图一致
 * （0.8–28x）」—— 这是**契约**而不是巧合，契约不该靠注释守护。
 *
 * 注意 `WORLD_FOLLOW_*`（世界跟随的倍率区间）不在这里：那是「国家面积 → 倍率」这条
 * 业务映射的取值范围，属于 `renderer.ts` 的跟随策略，与画布缩放范围是两件事。
 */

/** 缩放下限：0.8x 时能一眼看全整幅（地图与拼图共用）。 */
export const MIN_ZOOM = 0.8;

/** 缩放上限：28x，下钻某省时仍能继续放大（地图与拼图共用）。 */
export const MAX_ZOOM = 28;

/** 把倍率夹到 `[MIN_ZOOM, MAX_ZOOM]`。 */
export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}
