/**
 * 「世界 / 省级 / 市级」粒度的本地记忆（localStorage）。
 *
 * 为什么收敛到一处：这个读/写对原本在**四个地方各写了一份**——测验基类（输入 + 点击共用）、
 * 拼图模式、自由模式——而且**默认值并不一致**：
 *
 * | 模式 | 存储键后缀 | 首访默认 |
 * |---|---|---|
 * | 输入 / 点击 | `self` / `click` | `province` |
 * | 拼图 | `puzzle` | `province` |
 * | 自由浏览 | `memory` | `city` |
 *
 * 三个默认值埋在四份逐字相同的实现里，改动粒度口径时正是「改一处漏一处」的温床；
 * 现在默认值变成调用点上的**显式参数**，一眼能看出哪个模式默认哪一档。
 */
import type { Granularity } from '../province';

/** 存储键前缀。各模式用自己的后缀，互不干扰。 */
const KEY_PREFIX = 'china-admin-mode-granularity:';

/** 粒度存储键：`china-admin-mode-granularity:<mode>`。 */
export function granularityStorageKey(modePrefix: string): string {
  return KEY_PREFIX + modePrefix;
}

/**
 * 读粒度记忆。
 * 非法值与存储不可用（隐私模式 / 配额）都回落 `fallback`，与历史行为一致。
 */
export function loadStoredGranularity(modePrefix: string, fallback: Granularity): Granularity {
  try {
    const raw = localStorage.getItem(granularityStorageKey(modePrefix));
    if (raw === 'province' || raw === 'city' || raw === 'world') return raw;
    return fallback;
  } catch {
    return fallback;
  }
}

/** 写粒度记忆。存储失败静默忽略 —— 不该因为存不下而影响浏览或答题。 */
export function saveStoredGranularity(modePrefix: string, g: Granularity): void {
  try {
    localStorage.setItem(granularityStorageKey(modePrefix), g);
  } catch {
    /* 忽略存储失败 */
  }
}
