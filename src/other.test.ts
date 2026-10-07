import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  acceptedNamesOf,
  loadOtherCountryChoice,
  loadOtherLang,
  loadOtherWrong,
  looseKey,
  matchOtherUnit,
  normalizeOtherName,
  otherScopeLabel,
  otherUnits,
  saveOtherCountryChoice,
  saveOtherLang,
  saveOtherWrong,
} from './other';
import type { OtherCountryCode, OtherCountryData, OtherUnitMeta } from './types';

/**
 * 「其他」档（他国一级行政区）的判题与本地记忆。
 *
 * 这一档最容易悄悄坏掉的是**判题**：题池里 51/13/47/83 个名字来自 Natural Earth，
 * 中文名带行政后缀（「加利福尼亚州」）、日文名带都道府县（「東京都」）、俄文名是西里尔字母
 * 而且有「Республика X」这种**前缀**式写法；而用户会怎么打字完全不可预测（少写后缀、
 * 打不出长音符号、大小写随意、中英混用）。判错的表现是"我明明答对了却判错"，而且不报错。
 *
 * 故这里分两层钉：
 *   1. **纯函数**层的归一化与匹配规则（后缀、变音符号、标点、前缀式）；
 *   2. **真实数据**层的全覆盖：四国题池里**每一个**单位都必须能被它自己的三种名字命中，
 *      且不会被别国的名字误伤 —— 换数据源/改兜底表时这条最先报警。
 */

const OTHER_DIR = path.join(process.cwd(), 'public', 'data', 'other');
const load = (cc: OtherCountryCode) =>
  JSON.parse(readFileSync(path.join(OTHER_DIR, `${cc}.units.json`), 'utf8')) as {
    cc: string;
    name: string;
    lang: { id: 'en' | 'ja' | 'ru'; label: string };
    units: OtherUnitMeta[];
  };
const ALL: OtherCountryCode[] = ['usa', 'can', 'jpn', 'rus'];

function stubStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  return store;
}

afterEach(() => vi.unstubAllGlobals());

describe('normalizeOtherName · 比对用归一化', () => {
  it('去掉变音符号（打不出长音符号/重音也能答对）', () => {
    expect(normalizeOtherName('Québec')).toBe(normalizeOtherName('Quebec'));
    expect(normalizeOtherName('Ōita')).toBe(normalizeOtherName('Oita'));
    expect(normalizeOtherName('São Paulo')).toBe(normalizeOtherName('Sao Paulo'));
  });

  it('忽略大小写、空格、连字符与各种标点', () => {
    expect(normalizeOtherName('New-Jersey')).toBe(normalizeOtherName('new jersey'));
    expect(normalizeOtherName('  New   Jersey ')).toBe(normalizeOtherName('NewJersey'));
    expect(normalizeOtherName('Washington, D.C.')).toBe(normalizeOtherName('washington dc'));
  });

  it('剥掉中文行政后缀（省/州/县/府/都/道/自治区/边疆区/共和国…）', () => {
    expect(normalizeOtherName('加利福尼亚州')).toBe(normalizeOtherName('加利福尼亚'));
    expect(normalizeOtherName('北海道')).toBe(normalizeOtherName('北海'));
    expect(normalizeOtherName('阿尔泰边疆区')).toBe(normalizeOtherName('阿尔泰'));
    expect(normalizeOtherName('萨哈共和国')).toBe(normalizeOtherName('萨哈'));
  });

  it('剥掉英/俄行政后缀，含俄文的**前缀**式「Республика X」', () => {
    expect(normalizeOtherName('Alberta Province')).toBe(normalizeOtherName('Alberta'));
    expect(normalizeOtherName('Алтайский край')).toBe(normalizeOtherName('Алтайский'));
    expect(normalizeOtherName('Республика Алтай')).toBe(normalizeOtherName('Алтай'));
    expect(normalizeOtherName('Московская область')).toBe(normalizeOtherName('Московская'));
  });

  it('空串与纯标点归一化成空串（调用方据此判"没输入"）', () => {
    expect(normalizeOtherName('')).toBe('');
    expect(normalizeOtherName('   ')).toBe('');
    expect(normalizeOtherName('- , .')).toBe('');
  });
});

describe('matchOtherUnit · 三种写法都接受', () => {
  const usa = load('usa').units;
  const jpn = load('jpn').units;
  const code = (input: string, units = usa) => matchOtherUnit(input, units);

  it('中文名：带后缀与不带后缀等价', () => {
    expect(code('加利福尼亚州')).toBe('US-CA');
    expect(code('加利福尼亚')).toBe('US-CA');
    expect(code('华盛顿州')).toBe('US-WA');
  });

  it('当地语言名（英语）与大小写无关', () => {
    expect(code('california')).toBe('US-CA');
    expect(code('CALIFORNIA')).toBe('US-CA');
    expect(code('District of Columbia')).toBe('US-DC');
  });

  it('日文：当地写法与英文罗马字都算对', () => {
    expect(matchOtherUnit('東京都', jpn)).toBe('JP-13');
    expect(matchOtherUnit('东京都', jpn)).toBe('JP-13');
    expect(matchOtherUnit('Tokyo', jpn)).toBe('JP-13');
    expect(matchOtherUnit('北海道', jpn)).toBe('JP-01');
    expect(matchOtherUnit('Hokkaido', jpn)).toBe('JP-01');
    // 长音符号缺失（Ōita → Oita）
    expect(matchOtherUnit('Oita', jpn)).toBe('JP-44');
  });

  it('俄文：西里尔写法与英文罗马字都算对，且不因前缀式写法失配', () => {
    const rus = load('rus').units;
    expect(matchOtherUnit('Москва', rus)).toBe('RU-MOW');
    expect(matchOtherUnit('Московская область', rus)).toBe('RU-MOS');
    expect(matchOtherUnit('Республика Алтай', rus)).toBe('RU-AL');
    expect(matchOtherUnit('Алтайский край', rus)).toBe('RU-ALT');
    // ⚠ 这里的"英文名"是源数据的**罗马字**（NE 的 NAME 字段），不是常见英文名 ——
    // 莫斯科的罗马字是 `Moskva` 而不是 `Moscow`、阿尔泰共和国是 `Gorno-Altay` 而不是
    // `Altai Republic`。美加档没这个问题（英文名就是正式英文名），日俄两档接受的是
    // "中文 / 当地语言 / 罗马字"三种写法；常见英文名若也要接受，需要另加一张别名表。
    expect(matchOtherUnit('Moskva', rus)).toBe('RU-MOW');
    expect(matchOtherUnit('Gorno-Altay', rus)).toBe('RU-AL');
  });

  /**
   * ⚠ 这一组是本档最容易踩的坑：剥掉行政后缀后，源数据里有**两对**名字会撞成同一个键 ——
   * `阿尔泰共和国`/`阿尔泰边疆区` 都剥成「阿尔泰」、`莫斯科`/`莫斯科州` 都剥成「莫斯科」。
   * 只做"归一化后查表"会把用户答对的题判错（`other.test.ts` 的全覆盖用例当初就是这么抓出来的），
   * 故 `matchOtherUnit` 按「精确 > 归一化 > 前缀」打分。这几条断言就是那两对的回归闸门。
   */
  it('剥后缀会撞车的那两对：精确写法必须命中自己，而不是排序靠前的邻居', () => {
    const rus = load('rus').units;
    expect(matchOtherUnit('阿尔泰边疆区', rus)).toBe('RU-ALT');
    expect(matchOtherUnit('阿尔泰共和国', rus)).toBe('RU-AL');
    expect(matchOtherUnit('莫斯科', rus)).toBe('RU-MOW');
    expect(matchOtherUnit('莫斯科州', rus)).toBe('RU-MOS');
    // 只输入核心名（两个阿尔泰同分）时：有"当前题目"就判当前题，没有就取第一个（稳定可复现）
    expect(matchOtherUnit('阿尔泰', rus)).toBe('RU-AL');
    expect(matchOtherUnit('阿尔泰', rus, 'RU-ALT')).toBe('RU-ALT');
  });

  it('常见简称式前缀（北卡 → 北卡罗来纳）；单字输入不足以命中', () => {
    expect(code('北卡')).toBe('US-NC');
    expect(code('宾夕法尼亚')).toBe('US-PA');
    expect(code('北')).toBeNull();
  });

  it('不相关输入返回 null（判"答错"，而不是误判成别人）', () => {
    expect(code('不存在的名字XYZ')).toBeNull();
    expect(code('')).toBeNull();
    expect(code('日本')).toBeNull(); // 那是国家名，不是州名
    // 用日本的池子匹配美国名字 → 不该命中（跨国家不污染）
    expect(matchOtherUnit('California', jpn)).toBeNull();
    expect(matchOtherUnit('加利福尼亚州', jpn)).toBeNull();
  });
});

describe('真实数据全覆盖：每个单位都能被自己的三种名字命中', () => {
  for (const cc of ALL) {
    it(`${cc}：${load(cc).units.filter((u) => !u.decorative).length} 个题池单位逐一自洽`, () => {
      const units = load(cc).units.filter((u) => !u.decorative);
      const failures: string[] = [];
      for (const u of units) {
        for (const name of acceptedNamesOf(u)) {
          const hit = matchOtherUnit(name, units);
          if (hit !== u.code) failures.push(`${u.code} 的「${name}」命中了 ${hit}`);
        }
      }
      expect(failures, failures.join('; ')).toEqual([]);
    });
  }

  it('题池内三种名字在**不剥后缀**的口径下都不重复（剥后缀后允许撞车，由打分决胜）', () => {
    for (const cc of ALL) {
      const units = load(cc).units.filter((u) => !u.decorative);
      for (const field of ['name', 'nameLocal', 'nameEn'] as const) {
        const names = units.map((u) => looseKey(u[field]));
        const dup = names.filter((v, i) => v && names.indexOf(v) !== i);
        expect([...new Set(dup)], `${cc} 的 ${field} 有重复`).toEqual([]);
      }
    }
  });

  it('剥后缀后**确实**存在撞车（这正是必须打分的理由，撞车消失了说明归一化被改狠了）', () => {
    const rus = load('rus').units.filter((u) => !u.decorative);
    const keyed = new Map<string, string[]>();
    for (const u of rus) {
      const k = normalizeOtherName(u.name);
      keyed.set(k, [...(keyed.get(k) ?? []), u.code]);
    }
    const collisions = [...keyed.entries()].filter(([, codes]) => codes.length > 1);
    expect(collisions.map(([k]) => k).sort()).toEqual(['莫斯科', '阿尔泰']); // .sort() 按码位：莫(83AB) < 阿(963F)
  });

  it('「不考但显示」的争议地区不进题池，也不会被任何题池单位命中', () => {
    const rus = load('rus');
    const pool = rus.units.filter((u) => !u.decorative);
    const decorative = rus.units.filter((u) => u.decorative).map((u) => u.code);
    expect(decorative).toEqual(['UA-40', 'UA-43']);
    expect(pool.map((u) => u.code)).not.toContain('UA-43');
    // 它们自己的名字在题池里查不到（因为它们不在池里）
    expect(matchOtherUnit('克里米亚自治共和国', pool)).toBeNull();
    expect(matchOtherUnit('Севастополь', pool)).toBeNull();
  });
});

describe('otherUnits · 虚拟题池', () => {
  const country = (cc: OtherCountryCode): OtherCountryData => {
    const file = load(cc);
    const units = file.units;
    const byCode = new Map(units.map((u) => [u.code, u]));
    return {
      meta: { cc, name: file.name, lang: file.lang, count: units.filter((u) => !u.decorative).length, decorativeCount: 2, bbox: { main: [0, 0, 0, 0] } },
      units,
      pool: units.filter((u) => !u.decorative),
      geoJson: null,
      bboxMain: [0, 0, 0, 0],
      byCode,
    };
  };

  it('题池只含可答单位，adcode 用 ISO 编码，相邻/质心原样透传', () => {
    const c = country('usa');
    const pool = otherUnits(c, 'zh');
    expect(pool.length).toBe(c.pool.length);
    expect(pool.map((u) => u.adcode)).toEqual(c.pool.map((u) => u.code));
    const ca = pool.find((u) => u.adcode === 'US-CA')!;
    expect(ca.neighbors.length).toBeGreaterThan(0);
    expect(ca.center).toHaveLength(2);
    expect(ca.decorative).toBe(false);
  });

  it('语言档决定名字（中文 ↔ 当地语言），编码身份不变', () => {
    const c = country('jpn');
    const zh = otherUnits(c, 'zh').find((u) => u.adcode === 'JP-13')!;
    const local = otherUnits(c, 'local').find((u) => u.adcode === 'JP-13')!;
    expect(zh.name).toBe('东京都');
    expect(local.name).toBe('東京都');
    expect(zh.adcode).toBe(local.adcode);
  });
});

describe('otherScopeLabel · 范围文案', () => {
  it('「美国 · 一级行政区」这种写法（对应中国的"省级"）', () => {
    const c = { meta: { name: '美国' } } as OtherCountryData;
    expect(otherScopeLabel(c)).toBe('美国 · 一级行政区');
  });
});

describe('本地记忆 · 非法值与存储不可用都要安全', () => {
  it('语言档：只认 local，其余一律回落 zh', () => {
    stubStorage();
    expect(loadOtherLang('self')).toBe('zh');
    saveOtherLang('self', 'local');
    expect(loadOtherLang('self')).toBe('local');
    stubStorage({ 'china-admin-other-lang:self': 'zh' });
    expect(loadOtherLang('self')).toBe('zh');
  });

  it('国家：记住上次选的；记忆里的国家已从数据里删掉时回落第一个', () => {
    const available: OtherCountryCode[] = ['usa', 'can', 'jpn', 'rus'];
    stubStorage();
    expect(loadOtherCountryChoice('click', available)).toBe('usa');
    saveOtherCountryChoice('click', 'rus');
    expect(loadOtherCountryChoice('click', available)).toBe('rus');
    stubStorage({ 'china-admin-other-country:click': 'deu' }); // 数据里没有的国家
    expect(loadOtherCountryChoice('click', available)).toBe('usa');
  });

  it('错题清单：读回集合、写回 JSON；损坏的 JSON 不抛错', () => {
    stubStorage();
    expect([...loadOtherWrong('self')]).toEqual([]);
    saveOtherWrong('self', new Set(['JP-13', 'US-CA']));
    expect([...loadOtherWrong('self')].sort()).toEqual(['JP-13', 'US-CA']);
    stubStorage({ 'china-admin-other-wrong:self': '{ 不是 JSON' });
    expect([...loadOtherWrong('self')]).toEqual([]);
  });

  it('localStorage 不可用（隐私模式）时读回落默认、写静默失败', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    expect(loadOtherLang('self')).toBe('zh');
    expect(loadOtherCountryChoice('self', ['usa', 'jpn'])).toBe('usa');
    expect([...loadOtherWrong('self')]).toEqual([]);
    expect(() => saveOtherLang('self', 'local')).not.toThrow();
    expect(() => saveOtherCountryChoice('self', 'jpn')).not.toThrow();
    expect(() => saveOtherWrong('self', new Set(['US-CA']))).not.toThrow();
  });
});
