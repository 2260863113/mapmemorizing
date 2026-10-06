/**
 * 输入模式「自由跟随」的**倍率加成**（2026-09 需求 8）。
 *
 * ## 口径
 *
 * 自动跟随开启时，出题后镜头聚焦到该题的位置，并在**按区域标定的基准倍率**上再加一段：
 *   · 世界档：非洲国家 **+6x**，其余国家 **+2x**；
 *   · 中国地级（市级全国 / 单省）：**+2x**；
 *   · 省级全国：不聚焦（保持全国视野，无加成可言）。
 *
 * ## 为什么把「加成」单独抽出来当纯函数
 *
 * 基准倍率有**两个来源**（中国族 `followZoomFor(省)` 的阶梯、世界族 `worldFollowZoom(面积)`
 * 的对数映射），加成则只跟「在考哪儿」有关。分成两层后：
 *   1. 镜头落点由渲染器 `focusUnit/focusWorldCountry` 的 `extraZoom` 参数统一相加并夹取，
 *      模式侧只回答「加多少」——不会出现某条调用路径忘了夹取上限；
 *   2. 「非洲 +6」这条用户口径可以脱离 ECharts 单测（见 followBonus.test.ts），
 *      而不必起一个真渲染器去量缩放。
 *
 * ## 数值是标定，不是推导
 *
 * 为什么非洲是 6 而不是别的数：非洲国家面积整体偏大（`worldFollowZoom` 是面积的反比映射，
 * 大国基准倍率低），统一 +2 后画面仍然偏远、看不清国界，用户因此对非洲单独给了 +6。
 * 这条理由是**记录**而不是公式——数值本身由用户标定，故集中在这里一处，改动只影响这里。
 */
import type { Continent } from '../types';
import { SELF_FOLLOW_ZOOM_BONUS, SELF_FOLLOW_ZOOM_BONUS_AFRICA } from '../modeSettings';

/**
 * 世界档某国的跟随加成：非洲 +6，其余（含大洲信息缺失时）+2。
 *
 * 大洲缺失一律按普通档：宁可少放一点，也不要因为数据缺字段而突然跳到 6x 把镜头拉花。
 */
export function worldFollowExtraZoom(continent: Continent | null | undefined): number {
  return continent === 'AF' ? SELF_FOLLOW_ZOOM_BONUS_AFRICA : SELF_FOLLOW_ZOOM_BONUS;
}

/**
 * 中国地级（市级全国 / 单省）的跟随加成：统一 +2。
 *
 * 需要单列一个函数而不是直接写字面量 2：出口只有一处，将来若要按省区分（例如海南 28x 顶格
 * 再加会溢出到地图上限）改这里即可，调用点与单测都不用动。
 */
export function cityFollowExtraZoom(): number {
  return SELF_FOLLOW_ZOOM_BONUS;
}
