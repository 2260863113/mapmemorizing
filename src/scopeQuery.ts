import type { AppData, Continent, SubregionId } from './types';
import { CONTINENTS, SUBREGION_IDS } from './types';
import type { Granularity } from './province';
import { subregionOfContinent } from './subregions';

/**
 * URL 范围参数（Q26）：让 SEO 落地页上的地名能深链回 SPA 的对应视图。
 *
 * 参数（短且稳定——写进落地页后就是长期接口，改名等于所有落地页失效）：
 *   ?g=world|province|city   粒度（缺省按各模式既有默认）
 *   &c=AS|EU|AF|NA|SA|OC     大洲（仅 g=world 有意义）
 *   &s=EAS|…                 次区域（仅 g=world 且 c 已给且该洲分区数 > 1 时生效）
 *   &p=440000                省 adcode（仅 g=city，表示下钻该省）
 *
 * 设计原则：
 *   - 非法值**静默忽略**，绝不抛错、绝不白屏（落地页参数可能被手工篡改或过期）；
 *   - 不引入 router：解析结果只在启动时应用一次，地址栏保持 `/`（与 404 修复兼容，见 Q27）；
 *   - 纯函数：不碰 window，便于单测（调用方传 location.search）。
 */

export interface ScopeQuery {
  granularity: Granularity | null;
  continent: Continent | null;
  subregion: SubregionId | null;
  province: string | null;
}

const GRANULARITIES: Granularity[] = ['province', 'city', 'world'];
const CONTINENT_IDS: Continent[] = CONTINENTS.map((c) => c.id);

/**
 * 解析 `location.search`（或其等价字符串）。
 * data 用于校验「次区域属于该大洲」与「省 adcode 真实存在」，避免落地页参数与数据脱节。
 */
export function parseScopeQuery(search: string, data: AppData): ScopeQuery {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const out: ScopeQuery = { granularity: null, continent: null, subregion: null, province: null };

  const rawG = params.get('g');
  if (rawG && (GRANULARITIES as string[]).includes(rawG)) out.granularity = rawG as Granularity;

  const rawC = params.get('c');
  if (rawC && (CONTINENT_IDS as string[]).includes(rawC)) out.continent = rawC as Continent;

  const rawS = params.get('s');
  // 次区域必须：是合法 id、已选大洲、确实属于该大洲。任一不满足即忽略（而不是修正）。
  if (
    rawS &&
    out.continent &&
    (SUBREGION_IDS as readonly string[]).includes(rawS) &&
    subregionOfContinent(data, rawS as SubregionId) === out.continent
  ) {
    out.subregion = rawS as SubregionId;
  }

  const rawP = params.get('p');
  if (rawP && /^\d{6}$/.test(rawP) && data.provinces.some((p) => p.adcode === rawP)) out.province = rawP;

  // 一致性收口：大洲/次区域/省只在对应粒度下有意义
  if (out.granularity !== 'world') {
    out.continent = null;
    out.subregion = null;
  }
  if (out.granularity !== 'city') out.province = null;
  // 有次区域必须有大洲（次区域 ⊆ 大洲）
  if (out.subregion && !out.continent) out.subregion = null;

  return out;
}
