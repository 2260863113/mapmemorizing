/**
 * 输入模式「自动跟随」的**倍率系数**（2026-09 需求 8 修订版）。
 *
 * ## 口径（用户 2026-09 二次明确）
 *
 * 基准倍率仍由渲染器按各自模型算出（中国地级 = 按省标定的阶梯 `followZoomFor`；
 * 世界 = 与国家面积成反比的 `worldFollowZoom`），本模块只回答**在这个基准上乘多少**：
 *   · 世界档：**非洲国家 ×0.8**，其余国家 **×0.75**；
 *   · 中国地级（市级全国 / 单省）：**×0.75**；
 *   · **面积极小、几乎难以察觉的国家**（`tiny_countries.json` 那 6 国）**不乘任何系数**，
 *     直接使用渲染器世界跟随的**上限**（28x）—— 它们本来就只有几个像素，再缩小就彻底看不见了。
 *     这条例外由渲染器在执行时判定（它同时掌握面积与清单），本模块不掺和；
 *   · 省级全国不聚焦，故无系数可言。
 *
 * ## 与上一版的差别（为什么改了两次）
 *
 * 上一版实现的是「**加** 2x / 非洲加 6x」，而且用户随后指出方向说反了：他想要的是**乘**系数
 * 把镜头**拉远**（0.75 = 比原来远一档）。两次的差异不是"数值调参"而是**运算类型**变了
 * （加减 → 乘除），所以这里连同函数名一起换掉，不保留 `+2` 时代的 `followZoomWithBonus` ——
 * 留一个语义相反的旧函数比删掉它危险得多。随后非洲档又由 0.5 调成 0.8（2026-10 用户口径）。
 *
 * ## 为什么把系数单独成模块
 *
 * 1. 加成/系数只跟「在考哪儿」有关（大洲、粒度），基准只跟「那块地多大」有关 —— 两层分开后，
 *    模式侧只回答"乘多少"，渲染器侧只回答"基准是多少、怎么夹取"，不会出现某条调用路径漏夹取；
 * 2. 「非洲 ×0.5」这条用户口径可以脱离 ECharts 单测（见 `followScale.test.ts`），
 *    不必起一个真渲染器去量缩放。
 */
import type { Continent } from '../types';
import { MAX_ZOOM, clampZoom } from './zoom';

/** 通用的自动跟随倍率系数（中国地级与世界普通国家）：比基准拉远一档。 */
export const SELF_FOLLOW_SCALE = 0.75;

/** 非洲国家的自动跟随倍率系数：比通用档**略近**一点（2026-10 用户由 0.5 改为 0.8）。 */
export const SELF_FOLLOW_SCALE_AFRICA = 0.8;

/**
 * 世界档某国的跟随系数：非洲 0.8，其余 0.75。
 *
 * 大洲缺失（数据缺字段）一律按通用档：宁可稍微近一点，也不要因为一个空字段突然换档。
 */
export function worldFollowScale(continent: Continent | null | undefined): number {
  return continent === 'AF' ? SELF_FOLLOW_SCALE_AFRICA : SELF_FOLLOW_SCALE;
}

/**
 * 中国地级的跟随系数：统一 0.75。
 *
 * 单独成函数而不是直接写字面量：出口只有一处，将来若要按省区分（例如海南的阶梯倍率本来
 * 就是顶格 28x，乘完是 21x）改这里即可，调用点与单测都不用动。
 */
export function cityFollowScale(): number {
  return SELF_FOLLOW_SCALE;
}

/**
 * 基准倍率 × 系数，再夹到地图缩放范围 `[0.8, 28]`。
 *
 * **非法系数一律按 1 处理**（`NaN` / `Infinity` / `≤ 0`）。这不是洁癖：
 *   · `clampZoom(NaN)` 会**原样返回 NaN**，一旦传进 `geo.zoom` 就是整幅地图消失且再也回不来；
 *   · 系数 0 更危险 —— 它会被夹成 `MIN_ZOOM`(0.8)，表现为"跟随之后镜头突然拉到最远"，
 *     而调用点看起来完全合法。上一版这里就有一个「无尽传 0」的调用点（那时 0 表示"不加成"），
 *     语义换过一次之后极易被遗留的 0 命中，故这里直接把 ≤0 兜掉。
 */
export function scaleFollowZoom(base: number, scale: number): number {
  const factor = Number.isFinite(scale) && scale > 0 ? scale : 1;
  return clampZoom(base * factor);
}

/**
 * 世界档自动跟随的**目标倍率**：极小国直接用上限，其余国家按系数缩放。
 *
 * 抽成纯函数是为了让「极小国不乘系数」这条口径**可断言**（见 `followScale.test.ts`）——
 * 它是本轮唯一一处"同一个函数里两种取倍率方式"的分支，写在 `focusWorldCountry` 内部就只能
 * 靠起一个 ECharts 实例去量。上限用 `MAX_ZOOM`（= 世界跟随上限 28）而不是渲染器里那个别名，
 * 是为了不让 `followScale` ↔ `renderer` 形成循环导入。
 */
export function worldFocusZoom(base: number, scale: number, tiny: boolean): number {
  return tiny ? MAX_ZOOM : scaleFollowZoom(base, scale);
}
