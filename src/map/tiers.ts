/**
 * 地图精细度档位的**纯逻辑**（无 ECharts / DOM 依赖，便于单测）。
 *
 * 背景：本项目地级与省级各五档，档位由 zoom 决定。原先这套判断内联在
 * `renderer.ts` 的私有方法里，既无法单测（构造 Renderer 需要 DOM + ECharts），
 * 也容易被「地级改了、省级忘改」这类改动漏掉。抽到这里后：
 *   · `tiers.test.ts` 可覆盖全部边界值；
 *   · renderer 的地级/省级地图名都由同一份阈值推导，不会漂移。
 *
 * 精细度阶梯（顶点保留比例，五档均为同一份拓扑的简化结果，共享弧只简化一次 → 零缝隙）：
 *
 *   zoom 范围         档位       保留顶点
 *   zoom < 2          ultra       4%
 *   2 ≤ zoom < 6      pro         8%
 *   6 ≤ zoom < 10     fine       15%
 *   10 ≤ zoom < 14    plus       40%
 *   zoom ≥ 14         lossless  100%
 *
 * pro 8% 与 plus 40% 取自相邻档位的**几何中点**：√(4×15)≈7.7→8、√(15×100)≈38.7→40，
 * 使相邻档的顶点数落差从 2.6x/5.8x 降到 1.9x/2.4x，缩放时观感变化更均匀。
 */
export type Tier = 'ultra' | 'pro' | 'fine' | 'plus' | 'lossless';

export const TIER_ZOOM_MIN: Record<Tier, number> = {
  ultra: -Infinity, // 由 MIN_ZOOM(0.8) 兜底
  pro: 2,
  fine: 6,
  plus: 10,
  lossless: 14,
};

/** 档位 → 顶点保留比例（仅用于文档/自检展示）。 */
export const TIER_KEEP_PCT: Record<Tier, number> = {
  ultra: 4, pro: 8, fine: 15, plus: 40, lossless: 100,
};

/**
 * 按 zoom 解析档位（含边界）。
 *
 * @param zoom 当前缩放倍率
 * @param drilled 是否已下钻到某个省。下钻时视口只剩一个省，顶点再多也被视口裁剪挡住，
 *                故直接给最精细档，避免「放大到 12 倍却因为阈值没到 14 而看着糙」。
 */
export function tierOfZoom(zoom: number, drilled = false): Tier {
  if (drilled) return 'lossless';
  if (zoom < TIER_ZOOM_MIN.pro) return 'ultra';
  if (zoom < TIER_ZOOM_MIN.fine) return 'pro';
  if (zoom < TIER_ZOOM_MIN.plus) return 'fine';
  if (zoom < TIER_ZOOM_MIN.lossless) return 'plus';
  return 'lossless';
}

/** 档位 → 地级注册地图名。注意 fine 档沿用历史名 `china`（无后缀）。 */
export function chinaMapNameForTier(tier: Tier): string {
  return tier === 'fine' ? 'china' : `china-${tier}`;
}

/** 档位 → 省级注册地图名。注意 fine 档沿用历史名 `china-provinces`，lossless 档为 `china-provinces-raw`。 */
export function provinceMapNameForTier(tier: Tier): string {
  if (tier === 'fine') return 'china-provinces';
  if (tier === 'lossless') return 'china-provinces-raw';
  return `china-provinces-${tier}`;
}

/** 档位 → 该档在两族（地级/省级）里注册的全部地图名，供档位切换时做有效性自检。 */
export const ALL_CHINA_MAP_NAMES: string[] = (['ultra', 'pro', 'fine', 'plus', 'lossless'] as Tier[]).map(chinaMapNameForTier);
export const ALL_PROVINCE_MAP_NAMES: string[] = (['ultra', 'pro', 'fine', 'plus', 'lossless'] as Tier[]).map(provinceMapNameForTier);
