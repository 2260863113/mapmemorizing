/**
 * 无尽闯关经济系统纯函数（从 endless.ts 抽出，注入随机源以可单测）。
 * 全部函数无副作用、不依赖 DOM/localStorage/renderer，只做数值与规则计算。
 */

export type Rng = () => number; // 返回 [0, 1) 的随机源（默认 Math.random，测试可注入）

export const LEVEL_SECONDS = 45;
export const BASE_TARGET = 1000; // 第一关累计目标金币
export const TARGET_GROWTH = 1.1; // 累计目标每关增幅（第二关 1000+1100=2100）
export const COIN_MIN = 50; // 初始金币下限（约 50）
export const COIN_MAX = 400; // 初始金币上限（约 400）
export const COIN_NOISE_SCALE = 6; // 经/纬度噪声尺度
export const COIN_NOISE_AMPLIFY = 1.25; // 噪声起伏放大（拉开差距）
export const COIN_LABEL_ZOOM = 0; // 金币/地名标签始终显示（不按缩放倍率隐藏）
export const WRONG_INPUT_COIN_LOSS = 10; // 输错地名扣减的金币（盾牌可免疫）
export const HOURGLASS_USES = 5; // 时间沙漏激活后次数
export const POTION_USES = 3; // 透视药水使用次数（每购买一次）
export const POTION_REVEAL_MS = 3000; // 透视药水显示地名时长
export const PRICE_BUMP_MIN = 80; // 购买后涨价下限
export const PRICE_BUMP_MAX = 120; // 购买后涨价上限
export const ITEM_BONUS_MIN = 50; // 幸运草/令牌/美食额外金币下限
export const ITEM_BONUS_MAX = 100; // 额外金币上限
export const TOKEN_BONUS_STEP = 50; // 令牌逐次递增幅度

/** 返回 [min, max] 闭区间内的整数。 */
export function intBetween(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

/** 本关累计目标：通关所需累计金币（第一关 1000，第二关 1000+1100=2100，逐关等比求和）。 */
export function cumulativeTarget(level: number): number {
  return (BASE_TARGET * (Math.pow(TARGET_GROWTH, level) - 1)) / (TARGET_GROWTH - 1);
}

/**
 * 噪声值（已归一化到 [-1, 1]）→ 初始金币。
 * 与 generateCoins 内联公式一致：平方映射让多数城市落在低区间（~150 常见）。
 */
export function coinValue(normalizedNoise: number): number {
  const n = Math.min(1, Math.max(-1, normalizedNoise)); // 越界防御
  const t = (n + 1) / 2;
  const coins = Math.round((COIN_MIN + t * t * (COIN_MAX - COIN_MIN)) / 10) * 10;
  const clamped = Math.min(COIN_MAX, Math.max(COIN_MIN, coins));
  return Number.isFinite(clamped) ? clamped : COIN_MIN;
}

/** 跨关上浮增量：按当前金币区间取不同随机增长。 */
export function floatUpIncrement(rng: Rng, coins: number): number {
  if (coins < 100) return intBetween(rng, 30, 50);
  if (coins < 300) return intBetween(rng, 20, 40);
  if (coins < 500) return intBetween(rng, 10, 30);
  return intBetween(rng, 5, 15);
}

/** 购买后的下次价格（涨价规则）。 */
export function nextPrice(rng: Rng, current: number): number {
  return current + intBetween(rng, PRICE_BUMP_MIN, PRICE_BUMP_MAX);
}

/** 幸运草额外金币：50-100（不超过地名本身价格）。 */
export function cloverBonus(rng: Rng, value: number): number {
  return Math.min(intBetween(rng, ITEM_BONUS_MIN, ITEM_BONUS_MAX), value);
}

/** 飞花令牌额外金币：50-100 基础上逐次递增（不超过地名本身价格）。 */
export function tokenBonus(rng: Rng, value: number, matches: number): number {
  return Math.min(intBetween(rng, ITEM_BONUS_MIN, ITEM_BONUS_MAX) + matches * TOKEN_BONUS_STEP, value);
}

/** 美食鉴赏家额外金币：50-100（不超过地名本身价格）。 */
export function foodBonus(rng: Rng, value: number): number {
  return Math.min(intBetween(rng, ITEM_BONUS_MIN, ITEM_BONUS_MAX), value);
}

/** 时间沙漏奖励秒数：3-5 秒。 */
export function hourglassSeconds(rng: Rng): number {
  return intBetween(rng, 3, 5);
}

/** 飞花令牌命中：含关键字的名称命中；「自治州」中的「州」不作数。 */
export function tokenMatchesName(tokenChar: string, name: string, shortName: string): boolean {
  if (!tokenChar) return false;
  if (tokenChar === '州') {
    return name.replace(/自治州/g, '').includes('州') || shortName.includes('州');
  }
  return name.includes(tokenChar) || shortName.includes(tokenChar);
}

/** 商店道具：每件 50% 概率出现。 */
export function rollShopKeys(rng: Rng, keys: readonly string[]): string[] {
  return keys.filter(() => rng() < 0.5);
}
