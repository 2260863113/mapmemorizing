import type { AppData, Unit } from './types';
import rules from './normalize-rules.json';

/** 民族限定词（单一事实源：src/normalize-rules.json，与 scripts/build-data.mjs 共用） */
export const ETHNIC_WORDS: string[] = rules.ethnicWords;
// 民族词 + 可选「族」+ 后随「自治」（仅剥离自治地名，避免误伤「白山市」「满洲里」等普通地名）
// 注意：伊犁哈萨克自治州没有「族」字，因此「族」为可选；循环剥离处理「土家族苗族」连写
const ETHNIC_RE = new RegExp(`(?:${ETHNIC_WORDS.join('|')})(?:族)?(?=自治)`, 'g');
const SUFFIXES: string[] = rules.suffixes;

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

const PROV_SUFFIXES: string[] = rules.provinceSuffixes;

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

export class Matcher {
  private rows: { unit: Unit; ns: string; nf: string }[];

  constructor(data: AppData) {
    this.rows = data.units.map((unit) => ({ unit, ns: unit.shortName, nf: normalize(unit.name) }));
  }

  /** 最佳单位候选（测试模式判题、自由模式标记用）：仅接受规范化后的精确匹配，避免模糊匹配让错误答案通过 */
  bestUnit(input: string): Unit | null {
    const ni = normalize(input);
    if (!ni) return null;
    return this.rows.find((r) => ni === r.ns || ni === r.nf)?.unit ?? null;
  }
}
