import type { CountryMeta, CountryNames } from './types';

/**
 * 国家名匹配规则（世界粒度专属；与 src/matcher.ts 的中国行政区规则完全隔离）。
 *
 * 基准：Surbowl 数据源的「中文简称」（如 中国/美国/俄罗斯）就是题面与判题的规范名。
 * 容错输入 = 简称 / 官方全称 / 全称去掉政体后缀（共和国、合众国…）后的名称 三者之一；
 * 另有少量「全称剥后缀仍 ≠ 简称」的别名表（单一事实源，见 WORLD_EXTRA_ALIASES）。
 * 不做模糊/前缀匹配，与中国 matcher 一样要求规范化后精确相等，避免错误答案蒙混过关。
 *
 * 2026-09 扩展（「国名 / 首都」+「中文 / 英文」分段按钮）：同一套机制再加两张接受名集合 ——
 *   1. **首都**（`kind: 'capital'`）：只认首都名（中/英文），**不认国家名**；
 *   2. **英文**：国家名与首都名的英文写法（`world_names.json` 的 en / capitalEn + 别名表）。
 * 口径与「省名 / 简称」一致：**改的是考什么，就只接受什么**；中/英文只是同一个名字的两种写法，
 * 故两者都接受（见 worldNames.test.ts 的用例）。
 */

/** 政体后缀（长词在前）。只用于剥官方全称，绝不剥简称（中国/美国不以这些结尾）。 */
const STATE_SUFFIXES = [
  '民主人民共和国',
  '社会主义共和国',
  '人民共和国',
  '民主共和国',
  '共和国',
  '合众国',
  '联合王国',
  '大公国',
  '苏丹国',
  '酋长国',
  '公国',
  '王国',
  '联邦',
];

/** 剥后缀仍 ≠ 简称为数不多的别名补丁（iso_a3 → 额外接受的输入）。 */
const WORLD_EXTRA_ALIASES: Record<string, string[]> = {
  COD: ['刚果民主共和国', '民主刚果'],
  MKD: ['马其顿', '北马其顿共和国'],
  BIH: ['波斯尼亚和黑塞哥维那'],
  SWZ: ['斯威士兰王国'],
  TZA: ['坦桑尼亚联合共和国'],
  ARE: ['阿拉伯联合酋长国'],
  CIV: ['科特迪瓦共和国'],
  TLS: ['东帝汶民主共和国'],
  CZE: ['捷克共和国'],
  KOR: ['大韩民国'],
  PRK: ['朝鲜民主主义人民共和国'],
  LAO: ['老挝人民民主共和国'],
  LBY: ['利比亚国'],
  SYR: ['阿拉伯叙利亚共和国'],
  VNM: ['越南社会主义共和国'],
  SAU: ['沙特阿拉伯王国'],
  MUS: ['毛里求斯共和国'],
  ESH: [],
};

/**
 * 英文常用别名补丁：Natural Earth 的 `NAME_EN` 是**正式外来名**，少数与日常写法不同
 * （如「United States of America」vs「United States」）。只补这些，不做穷举。
 */
const WORLD_EN_ALIASES: Record<string, string[]> = {
  USA: ['United States', 'USA', 'America'],
  GBR: ['UK', 'Great Britain', 'Britain'],
  KOR: ['South Korea', 'Korea'],
  PRK: ['North Korea'],
  COD: ['DR Congo', 'DRC', 'Congo-Kinshasa'],
  COG: ['Congo', 'Congo-Brazzaville'],
  CZE: ['Czechia'],
  NLD: ['Holland'],
  ARE: ['UAE'],
  MMR: ['Burma'],
  TLS: ['East Timor'],
  CIV: ['Ivory Coast', "Cote d'Ivoire"],
  SWZ: ['Swaziland'],
  CPV: ['Cape Verde'],
  TUR: ['Turkey', 'Türkiye'],
  VAT: ['Vatican', 'Holy See'],
  RUS: ['Russia'],
  MKD: ['North Macedonia'],
  GMB: ['Gambia'], // 源值带定冠词 The Gambia
  BHS: ['Bahamas'], // 源值带定冠词 The Bahamas
};

/**
 * 首都的**接受别名**补丁（iso → 额外接受的写法，中英混排）。
 *
 * 三种来源：① 数据源的值比常用答案长（美国给「华盛顿哥伦比亚特区」）；
 * ② 该国另有法定/实际首都，用户写它不算错（南非三个首都、斯里兰卡、荷兰、坦桑尼亚）；
 * ③ 数据源的译名与通行译名不同（瓦都兹/瓦杜兹、三蘭港/达累斯萨拉姆等已在数据侧修掉，
 * 这里只留「同城异名」）。
 */
const WORLD_CAPITAL_ALIASES: Record<string, string[]> = {
  USA: ['华盛顿', 'Washington', 'Washington DC', 'Washington, D.C.'],
  ZAF: ['开普敦', '布隆方丹', 'Cape Town', 'Bloemfontein'],
  LKA: ['斯里贾亚瓦德纳普拉科特', 'Sri Jayawardenepura Kotte'],
  NLD: ['海牙', 'The Hague'],
  TZA: ['多多马', 'Dodoma'],
  BOL: ['拉巴斯', 'La Paz'],
  CIV: ['阿比让', 'Abidjan'],
  KIR: ['塔拉瓦', 'Tarawa'],
  CHE: ['伯恩', 'Berne'],
  MMR: ['仰光', 'Yangon'],
  PSE: ['拉姆安拉'], // 数据侧显示「拉马拉」，标准译名「拉姆安拉」也接受
  PLW: ['恩吉鲁穆德', 'Ngerulmud'], // 2006 年起政府驻地在 Ngerulmud，数据源仍是梅莱凯奥克
  BEN: ['科托努', 'Cotonou'], // 数据侧显示法定首都波多诺伏；科托努是政府所在地
};

/** 题面/判题口径：按国家名还是按首都名。 */
export type WorldNameKind = 'country' | 'capital';
/** 输入规范化：去首尾空白、全角 ASCII → 半角、压缩空白、小写（中英文都走这一套）。 */
export function normalizeCountryName(raw: string): string {
  let s = raw.trim().toLowerCase();
  s = s.replace(/[\uff01-\uff5e]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  s = s.replace(/\u3000/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/** 剥去官方全称的政体后缀（阿拉伯埃及共和国 → 阿拉伯埃及）。 */
export function stripStateSuffix(name: string): string {
  let s = name;
  let prev = '';
  while (s !== prev) {
    prev = s;
    for (const suf of STATE_SUFFIXES) {
      if (s.endsWith(suf)) {
        s = s.slice(0, -suf.length);
        break;
      }
    }
  }
  return s;
}

/** 单个国家接受的**国名**集合（中文简称/全称/剥后缀全称 + 别名 + 英文名与英文别名），均已规范化。 */
function acceptedCountryNames(country: CountryMeta, names: CountryNames | undefined): string[] {
  const set = new Set<string>();
  const add = (raw: string | undefined) => {
    if (!raw) return;
    const norm = normalizeCountryName(raw);
    if (norm) set.add(norm);
  };
  add(country.name);
  add(country.fullName);
  add(stripStateSuffix(country.fullName));
  for (const alias of WORLD_EXTRA_ALIASES[country.iso] ?? []) add(alias);
  add(names?.en);
  for (const alias of WORLD_EN_ALIASES[country.iso] ?? []) add(alias);
  return [...set];
}

/** 单个国家接受的**首都**集合（中文名 + 英文名 + 别名）。数据缺失时为空集（该题不会被判对）。 */
function acceptedCapitalNames(iso: string, names: CountryNames | undefined): string[] {
  const set = new Set<string>();
  const add = (raw: string | undefined) => {
    if (!raw) return;
    const norm = normalizeCountryName(raw);
    if (norm) set.add(norm);
  };
  add(names?.capital);
  add(names?.capitalEn);
  for (const alias of WORLD_CAPITAL_ALIASES[iso] ?? []) add(alias);
  return [...set];
}

/**
 * 按「接受名 → 命中唯一国家」建索引：**跨国家重名的写法一律剔除**。
 *
 * 例：刚果民主共和国与刚果共和国剥后缀后都是「刚果」→ 两者都不接受该词，避免命中歧义。
 * 保证匹配结果唯一确定。
 *
 * ⚠ 这套剔除只用于**国名档**（`bestMatch`）。首都档不走它，见 `acceptsCapital`。
 */
function buildRows(entries: { iso: string; names: string[] }[]): { iso: string; names: string[] }[] {
  const freq = new Map<string, number>();
  for (const row of entries) {
    for (const name of new Set(row.names)) freq.set(name, (freq.get(name) ?? 0) + 1);
  }
  return entries.map((row) => ({ iso: row.iso, names: row.names.filter((n) => freq.get(n) === 1) }));
}

/** 国家名/首都名匹配器。 */
export class WorldMatcher {
  private countryRows: { iso: string; names: string[] }[];
  /** 首都接受名表（**不剔除重名**，见 acceptsCapital）。 */
  private capitalNames = new Map<string, string[]>();

  constructor(countries: readonly CountryMeta[], countryNames: Record<string, CountryNames> = {}) {
    this.countryRows = buildRows(
      countries.map((c) => ({ iso: c.iso, names: acceptedCountryNames(c, countryNames[c.iso]) })),
    );
    for (const c of countries) this.capitalNames.set(c.iso, acceptedCapitalNames(c.iso, countryNames[c.iso]));
  }

  /**
   * 国名匹配（默认口径）：输入 → 命中国家 iso；无命中返回 null。
   *
   * 「跨国家重名一律剔除」是既有决策：刚果（金）/刚果（布）剥后缀后同名的「刚果」两国都不接受，
   * 避免同一个输入把两个国家都判对（数据侧本来就给了带括号的消歧写法）。
   */
  bestMatch(input: string): string | null {
    const ni = normalizeCountryName(input);
    if (!ni) return null;
    return this.countryRows.find((r) => r.names.includes(ni))?.iso ?? null;
  }

  /**
   * 首都档判题：`input` 是否为 **iso 这个国家**的合法首都名（中/英文 + 别名）。
   *
   * 为什么首都档**不**沿用 `bestMatch` 的「重名剔除」：判据本来就该是「这个输入是不是**当前这一题**
   * 的合法名字」，而不是「这个输入在全池里能不能唯一定位到一个国家」。剔除会造成真实的死角 ——
   * 牙买加 Kingston 与圣文森特 Kingstown 的大陆通用译名**同为「金斯敦」**，两边都被剔掉后，
   * 这两国在「首都 + 中文」下永远答不出来（题面显示金斯敦、输入金斯敦却判错）。
   * 保留重名后，同一输入对这两国各自的题都算对，正是同形异国该有的语义。
   */
  acceptsCapital(iso: string, input: string): boolean {
    const ni = normalizeCountryName(input);
    if (!ni) return false;
    return this.capitalNames.get(iso)?.includes(ni) ?? false;
  }
}
