import type { CountryMeta } from './types';

/**
 * 国家名匹配规则（世界粒度专属；与 src/matcher.ts 的中国行政区规则完全隔离）。
 *
 * 基准：Surbowl 数据源的「中文简称」（如 中国/美国/俄罗斯）就是题面与判题的规范名。
 * 容错输入 = 简称 / 官方全称 / 全称去掉政体后缀（共和国、合众国…）后的名称 三者之一；
 * 另有少量「全称剥后缀仍 ≠ 简称」的别名表（单一事实源，见 WORLD_EXTRA_ALIASES）。
 * 不做模糊/前缀匹配，与中国 matcher 一样要求规范化后精确相等，避免错误答案蒙混过关。
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

/** 输入规范化：去首尾空白、全角 ASCII → 半角、压缩空白、小写（仅影响英文别名）。 */
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

/** 单个国家接受的规范名集合（简称/全称/剥后缀全称 + 别名补丁），均已规范化。 */
function acceptedNames(country: CountryMeta): string[] {
  const set = new Set<string>();
  const add = (raw: string) => {
    const norm = normalizeCountryName(raw);
    if (norm) set.add(norm);
  };
  add(country.name);
  add(country.fullName);
  add(stripStateSuffix(country.fullName));
  const extra = WORLD_EXTRA_ALIASES[country.iso];
  if (extra) for (const alias of extra) add(alias);
  return [...set];
}

/** 国家名匹配器：输入 → 命中国家 iso（精确匹配任一接受名；无命中返回 null）。 */
export class WorldMatcher {
  private rows: { iso: string; names: string[] }[];

  constructor(countries: readonly CountryMeta[]) {
    // 先收集每个国家接受的名称，再剔除跨国家重复的名称（如 刚果民主共和国/刚果共和国
    // 剥后缀后都是「刚果」→ 两者都不接受该词，避免命中歧义），保证匹配结果唯一确定。
    const all: { iso: string; names: string[] }[] = countries.map((c) => ({ iso: c.iso, names: acceptedNames(c) }));
    const freq = new Map<string, number>();
    for (const row of all) {
      for (const name of new Set(row.names)) freq.set(name, (freq.get(name) ?? 0) + 1);
    }
    this.rows = all.map((row) => ({ iso: row.iso, names: row.names.filter((n) => freq.get(n) === 1) }));
  }

  bestMatch(input: string): string | null {
    const ni = normalizeCountryName(input);
    if (!ni) return null;
    return this.rows.find((r) => r.names.includes(ni))?.iso ?? null;
  }
}
