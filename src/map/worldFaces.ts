/**
 * 世界面「是否可见 / 是否可交互」的纯判定。
 *
 * 抽成独立模块的原因：这是本轮最容易出错、也最需要断言的一条逻辑。
 * 原实现把判定写在 renderer 私有方法里，测试无法触达；而它一旦回归，
 * 表现是「悬停空白处高亮一个看不见的国家、点击还会跳到它的上级区域」——
 * 用户明确要求空白区域**不提供任何交互**。
 *
 * 两类面不可交互：
 *   1. 当前范围之外的面：下钻到大洲/次区域后，其余洲的国面在几何上依然存在。
 *      渲染层把它们画成 `silent` 透明面（ECharts 对 silent region 既不发事件
 *      也不做 emphasis），这里再兜一层 name→iso 的回传判定。
 *   2. 被「忽略面积极小的国家」排除的面，以及装饰面（属地/南极等）。
 */

export interface WorldFaceContext {
  /** 当前大洲范围（null = 全世界）。 */
  continent: string | null;
  /** 当前次区域范围（null = 全洲/全世界；次区域优先于大洲）。 */
  subregion: string | null;
  /** iso → 大洲。 */
  isoContinent: ReadonlyMap<string, string>;
  /** iso → 次区域。 */
  isoSubregion: ReadonlyMap<string, string>;
}

/** 某国面是否属于当前范围（全世界时一律可见；次区域优先于大洲）。 */
export function worldFeatureVisible(ctx: WorldFaceContext, iso: string, isDecorative: boolean): boolean {
  const hasScope = ctx.subregion !== null || ctx.continent !== null;
  if (!hasScope) return true;
  if (isDecorative || !iso) return false; // 有范围时装饰面一并隐藏
  if (ctx.subregion) return ctx.isoSubregion.get(iso) === ctx.subregion;
  return ctx.isoContinent.get(iso) === ctx.continent;
}

/**
 * 某国面是否可交互（悬停高亮 / 点击 / 双击 / tooltip）。
 *
 * `name` 是 ECharts 事件里的面名，需要先解析成 iso；解析不到、是装饰面、
 * 或被设置排除，都视为不可交互 —— 也就是「点了等于点空白」。
 */
export function worldFaceInteractive(
  ctx: WorldFaceContext,
  name: string,
  lookups: {
    nameToIso: ReadonlyMap<string, string>;
    decorativeNames: ReadonlySet<string>;
    excludedNames: ReadonlySet<string>;
  },
): boolean {
  if (lookups.decorativeNames.has(name) || lookups.excludedNames.has(name)) return false;
  const iso = lookups.nameToIso.get(name);
  if (!iso) return false;
  return worldFeatureVisible(ctx, iso, false);
}

/** 某 iso 是否被「忽略面积极小的国家」排除（供出题池过滤复用同一份判定口径）。 */
export function isExcludedIso(excluded: ReadonlySet<string>, iso: string): boolean {
  return excluded.has(iso);
}
