import type { AppData, Province, Unit } from './types';
import { t } from './i18n';

/** 民族限定词（与 scripts/build-data.mjs 保持同步） */
export const ETHNIC_WORDS = [
  '布依', '苗', '侗', '壮', '回', '藏', '蒙古', '彝', '哈尼', '傣', '傈僳', '佤', '拉祜', '水', '纳西', '景颇',
  '达斡尔', '鄂温克', '鄂伦春', '哈萨克', '柯尔克孜', '锡伯', '塔吉克', '乌孜别克', '俄罗斯', '满', '土家',
  '白', '瑶', '朝鲜', '黎', '畲', '高山', '赫哲', '撒拉', '东乡', '裕固', '保安', '门巴', '珞巴', '羌', '毛南',
  '仫佬', '仡佬', '京', '独龙', '德昂', '阿昌', '普米', '怒', '基诺', '布朗', '维吾尔',
];
// 民族词 + 可选「族」+ 后随「自治」（仅剥离自治地名，避免误伤「白山市」「满洲里」等普通地名）
// 注意：伊犁哈萨克自治州没有「族」字，因此「族」为可选；循环剥离处理「土家族苗族」连写
const ETHNIC_RE = new RegExp(`(?:${ETHNIC_WORDS.join('|')})(?:族)?(?=自治)`, 'g');
const SUFFIXES = ['自治州', '自治县', '自治旗', '地区', '林区', '新区', '盟', '州', '市', '县', '旗'];

/** 地级单位名规范化：去民族词 + 去行政后缀。例：黔南布依族苗族自治州 → 黔南 */
export function normalize(raw: string): string {
  let s = raw.trim().toLowerCase();
  s = s.replace(/[\uff01-\uff5e]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  s = s.replace(/\u3000/g, ' ');
  let prev = '';
  while (s !== prev) {
    prev = s;
    s = s.replace(ETHNIC_RE, '');
  }
  prev = '';
  while (s !== prev) {
    prev = s;
    for (const suf of SUFFIXES) {
      if (s.endsWith(suf)) {
        s = s.slice(0, -suf.length);
        break;
      }
    }
  }
  return s;
}

const PROV_SUFFIXES = [
  '维吾尔自治区', '壮族自治区', '回族自治区',
  '特别行政区', '自治区', '省', '市',
];

/** 省级名规范化（纯后缀剥离）。例：海南省 → 海南；新疆维吾尔自治区 → 新疆 */
export function normalizeProvince(raw: string): string {
  let s = raw.trim().toLowerCase();
  let prev = '';
  while (s !== prev) {
    prev = s;
    for (const suf of PROV_SUFFIXES) {
      if (s.endsWith(suf)) {
        s = s.slice(0, -suf.length);
        break;
      }
    }
  }
  return s;
}

/** 编辑距离（错别字容错） */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

export interface SuggestItem {
  kind: 'unit' | 'province';
  adcode: string;
  label: string;
  sub: string;
}

interface Ranked extends SuggestItem {
  score: number;
}

function scoreUnit(ni: string, ns: string, nf: string): number {
  if (ni === ns || ni === nf) return 100;
  if (ns.startsWith(ni) || nf.startsWith(ni)) return 80;
  if (ni.length >= 2 && (ns.includes(ni) || nf.includes(ni))) return 70;
  if (ni.length >= 2 && (levenshtein(ni, ns) <= 2 || levenshtein(ni, nf) <= 2)) return 60;
  return 0;
}

export class Matcher {
  private rows: { unit: Unit; ns: string; nf: string }[];
  private provRows: { province: Province; ns: string; count: number }[];

  constructor(data: AppData) {
    this.rows = data.units.map((unit) => ({ unit, ns: unit.shortName, nf: normalize(unit.name) }));
    const counts = new Map<string, number>();
    for (const u of data.units) counts.set(u.provinceAdcode, (counts.get(u.provinceAdcode) ?? 0) + 1);
    this.provRows = data.provinces.map((province) => ({
      province,
      ns: normalizeProvince(province.name),
      count: counts.get(province.adcode) ?? 0,
    }));
  }

  /** 最佳单位候选（测试模式判题、自由模式标记用）：仅接受规范化后的精确匹配，避免模糊匹配让错误答案通过 */
  bestUnit(input: string): Unit | null {
    const ni = normalize(input);
    if (!ni) return null;
    return this.rows.find((r) => ni === r.ns || ni === r.nf)?.unit ?? null;
  }

  /** 省份候选（输入省名时下钻用）：精确或前缀命中 */
  bestProvince(input: string): Province | null {
    const ni = normalizeProvince(input);
    if (!ni) return null;
    for (const { province, ns } of this.provRows) {
      if (ni === ns) return province;
    }
    if (ni.length >= 2) {
      for (const { province, ns } of this.provRows) {
        if (ns.startsWith(ni)) return province;
      }
    }
    return null;
  }

  /** 联想候选：地级单位 + 省级条目（自由模式用） */
  suggest(input: string, limit = 8): SuggestItem[] {
    const ni = normalize(input);
    if (!ni) return [];
    const out: Ranked[] = [];
    const seen = new Set<string>();
    for (const { unit, ns, nf } of this.rows) {
      const score = scoreUnit(ni, ns, nf);
      if (score > 0 && !seen.has(unit.adcode)) {
        seen.add(unit.adcode);
        out.push({ kind: 'unit', adcode: unit.adcode, label: unit.name, sub: unit.province, score });
      }
    }
    for (const { province, ns, count } of this.provRows) {
      const score = scoreUnit(ni, ns, ns);
      if (score > 0) {
        out.push({
          kind: 'province', adcode: province.adcode, label: province.name,
          sub: t('matcher.provinceHint', { count }), score: score - 1,
        });
      }
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, limit).map(({ kind, adcode, label, sub }) => ({ kind, adcode, label, sub }));
  }
}
