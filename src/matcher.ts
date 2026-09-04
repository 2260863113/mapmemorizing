import type { AppData, Unit } from './types';

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
