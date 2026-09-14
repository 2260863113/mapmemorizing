/**
 * 「未开始的浏览标签」渲染片段（2026-09：自由模式下线后并入前四个模式）。
 *
 * 用户口径：
 *   · **未开始时显示全量地名**（与自由模式逐字一致：阈值 0，任何缩放倍率都显示）；
 *   · **开始答题后清空** —— 只清全量标签，**已作答单位的绿/红标签保留**（那是答题反馈，
 *     省级全国与世界的「已作答显示绿/红名字」就是靠它）；
 *   · **结束时复现**（结算卡片出现 / 答完 / 重置）；暂停不算结束。
 *
 * 粒度决定显示哪一层的名字：世界档 = 国名；省级全国 = 省名；
 * 其余（市级全国 / 单省 / **省级全国下钻某省**）= 地级市名 —— 浏览的是「画面上现在有什么」。
 *
 * 全局开关 `settings.showBrowseLabels` 关掉时返回空片段（什么都不显示）；
 * 该开关由已下线的自由模式「隐藏标签」迁移而来（见 store.loadSettings 的旧键兼容）。
 *
 * ⚠ 拼图模式**不用**这个片段：它的名称由难度档说话（困难档刻意不给提示，2026-09 口径）。
 */
import type { RenderState } from '../types';

/** 浏览时显示哪一层的名字。 */
export type BrowseLabelScope = 'world' | 'provinceNation' | 'city';

/** 该层级的全量标签片段（`enabled=false` 时为空）。 */
export function browseLabelState(scope: BrowseLabelScope, enabled: boolean): Partial<RenderState> {
  if (!enabled) return {};
  if (scope === 'world') {
    // 世界档：国名常显（worldLabelZoomThreshold=0 关掉「放大到 2.2x 才显示」的阈值）
    return { worldShowAllLabels: true, worldLabelZoomThreshold: 0 };
  }
  if (scope === 'provinceNation') {
    return { showAllProvinceLabels: true };
  }
  // 地级档：地名常显（阈值 0）
  return { showAllLabels: true, labelZoomThreshold: 0 };
}
