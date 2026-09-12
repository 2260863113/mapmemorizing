/**
 * 「忽略面积极小的国家」清单：`public/data/tiny_countries.json`。
 *
 * 清单由 scripts/build-subregions.mjs 依据世界几何面积（度²，与视觉面积一致）现算，
 * 判定线为「面积 ≤ 马绍尔群岛」——正好卡在天然尺寸断崖上（下一个国家科摩罗是它的 1.7 倍）。
 *
 * 本模块只做一件事：把清单缓存在内存里，供设置面板显示数量、以及渲染/出题两条路径查询。
 * 数据加载时由 src/data.ts 之外单独取（这份文件很小，且设置面板可能在数据就绪前打开）。
 */

let cache: string[] | null = null;
let pending: Promise<string[]> | null = null;

/** 同步读取已缓存的清单（未加载时返回空数组，调用方按「无极小国家」降级）。 */
export function loadTinyCountries(): string[] {
  return cache ?? [];
}

/** 取异步清单，供判定前确保已就绪（幂等，失败时降级为空清单，不抛出）。 */
export async function ensureTinyCountries(): Promise<string[]> {
  if (cache) return cache;
  if (!pending) {
    pending = fetch('data/tiny_countries.json')
      .then((r) => (r.ok ? (r.json() as Promise<{ isos?: string[] }>) : { isos: [] }))
      .then((j) => (cache = Array.isArray(j.isos) ? j.isos.filter((x) => typeof x === 'string') : []))
      .catch(() => (cache = []));
  }
  return pending;
}

/** 测试与热更新用：直接注入清单。 */
export function setTinyCountriesForTest(isos: string[] | null) {
  cache = isos;
  pending = null;
  ignored.clear();
  ignoreActive = false;
}

// ---------- 当前生效的排除集合 ----------
//
// 由 appController 在设置保存/启动时写入，渲染器与各模式的出题池都读这里。
// 之所以放模块级而不是塞进每个模式的字段：这是一条**全局设置**（跟随用户而非模式），
// 三种测验模式 + 分析模式的池都必须同时生效，否则会出现「能出题但点不动」。

let ignoreActive = false;
const ignored = new Set<string>();

/** 应用设置：开启时给出极小国家清单，关闭时清空。 */
export function applyIgnoreTiny(on: boolean, tiny: string[]) {
  ignoreActive = on;
  ignored.clear();
  if (on) for (const iso of tiny) ignored.add(iso);
}

/** 当前被排除出答题与交互的 iso 集合（未开启时为空集）。 */
export function ignoredIsos(): ReadonlySet<string> {
  return ignored;
}

/** 当前是否开启了「忽略面积极小的国家」。 */
export function isIgnoringTiny(): boolean {
  return ignoreActive;
}
