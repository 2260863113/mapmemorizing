import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  NAMING_GROUPS,
  activeChoiceOf,
  choiceAvailableIn,
  namingChoiceOf,
  namingGroupOf,
  type NamingField,
  type NamingJudgeCtx,
} from './naming';
import { ALL_MODES } from './capabilities';
import { makeTestCtx } from '../testCtx';
import { InputMode } from './input';
import { WorldMatcher } from '../worldNames';
import { DEFAULT_NAMING } from './namingStore';
import type { QuestionNaming } from './types';

/**
 * 取名口径注册表的**结构不变量**与「加一档只改一行」这条承诺的护栏。
 *
 * 为什么需要：这张表的价值全在"它说了算"—— UI 段、题面、标签、判题、占位提示都从它读。
 * 一旦某一档漏了 `questionName` / `labelName` / `placeholderKey`，表现不是报错，而是**静默少内容**
 * （标签空白、占位提示回落到"地名"、某档在输入模式永远判不出来）。单测在这里逐档断言全覆盖，
 * 并且把"注册表 × index.html × 真数据"三者的关系钉住。
 */

const INDEX_HTML = readFileSync(path.join(process.cwd(), 'index.html'), 'utf8');
/** 夹具：一个真省（河北 → 石家庄/冀/河北）+ 一个真国家（日本 → 东京/Japan）。 */
const DATA = {
  countries: [{ iso: 'JPN', name: '日本', fullName: '日本国', center: [138, 36] as [number, number], neighbors: [], continent: 'AS' as const }],
  countryNames: { JPN: { en: 'Japan', capital: '东京', capitalEn: 'Tokyo' } },
  countryFlags: { JPN: 'jp.svg' },
  countryFlagThumbs: { JPN: 'jp.webp' },
  provinces: [{ adcode: '130000', name: '河北省', center: [114.5, 38] as [number, number] }],
};

/** 覆盖全部维度的口径组合（逐档验证用）。 */
const ALL_NAMING: QuestionNaming[] = [];
for (const world of ['country', 'capital', 'flag'] as const) {
  for (const lang of ['zh', 'en'] as const) {
    for (const province of ['full', 'capital', 'abbr'] as const) {
      ALL_NAMING.push({ world, lang, province });
    }
  }
}

describe('口径注册表 · 结构不变量', () => {
  it('三组的容器 id 都在 index.html 里（按钮由注册表生成，容器必须存在）', () => {
    for (const g of NAMING_GROUPS) {
      expect(INDEX_HTML, g.toggleId).toContain(`id="${g.toggleId}"`);
    }
  });

  it('按钮 id 与运行时验收脚本用的选择器一致（脚本按 id 点击，故 id 是稳定契约）', () => {
    // 生成规则见 ui/namingControls.ts：容器 id 去掉 -toggle + 取值
    const idOf = (g: (typeof NAMING_GROUPS)[number], value: string) => `${g.toggleId.replace(/-toggle$/, '')}-${value}`;
    expect(idOf(namingGroupOf('world'), 'capital')).toBe('world-name-capital');
    expect(idOf(namingGroupOf('world'), 'flag')).toBe('world-name-flag');
    expect(idOf(namingGroupOf('lang'), 'zh')).toBe('world-lang-zh');
    expect(idOf(namingGroupOf('province'), 'abbr')).toBe('province-name-abbr');
    // 验收脚本里确实按这些 id 点击
    const verify = readFileSync(path.join(process.cwd(), 'scripts', 'verify-naming.mjs'), 'utf8');
    for (const id of ['world-name-capital', 'world-name-flag', 'world-lang-zh', 'province-name-abbr']) {
      expect(verify, id).toContain(`#${id}`);
    }
  });

  it('每组内取值唯一、非空、且默认口径落在表内（默认值不能是"表里没有的档"）', () => {
    for (const g of NAMING_GROUPS) {
      const values = g.choices.map((c) => c.value);
      expect(new Set(values).size, g.field).toBe(values.length);
      for (const c of g.choices) {
        expect(c.label.length, `${g.field}=${c.value} 的段按钮文字`).toBeGreaterThan(0);
        expect(String(c.value).length, g.field).toBeGreaterThan(0);
      }
      expect(values, `${g.field} 的默认值`).toContain(DEFAULT_NAMING[g.field]);
    }
  });

  it('world / province 两组的每一档都给得出题面名与标签名（漏了就是静默空白）', () => {
    for (const field of ['world', 'province'] as const) {
      for (const c of namingGroupOf(field).choices) {
        expect(typeof c.questionName, `${field}=${c.value}.questionName`).toBe('function');
        expect(typeof c.labelName, `${field}=${c.value}.labelName`).toBe('function');
      }
    }
  });

  it('每一档都有占位提示（输入模式要知道该输入什么；lang 组除外 —— 它不换考点）', () => {
    for (const field of ['world', 'province'] as const) {
      for (const c of namingGroupOf(field).choices) {
        for (const naming of ALL_NAMING) {
          const key = c.placeholderKey?.(naming);
          expect(key, `${field}=${c.value} 在 ${JSON.stringify(naming)} 下没有占位提示`).toBeTruthy();
        }
      }
    }
  });

  it('参与输入判题的档必须给 judge；被模式限制挡在输入模式外的档可以不给', () => {
    for (const g of NAMING_GROUPS) {
      for (const c of g.choices) {
        const reachableInInput = choiceAvailableIn(c, 'self');
        if (reachableInInput && g.field !== 'lang') {
          expect(typeof c.judge, `${g.field}=${c.value} 在输入模式可达却没有 judge`).toBe('function');
        }
      }
    }
  });
});

describe('口径注册表 · 各档产出互不相同且都不是空串（真数据）', () => {
  const { ctx } = makeTestCtx({ data: DATA });
  const provinceChoices = namingGroupOf('province').choices;
  const worldChoices = namingGroupOf('world').choices;

  it('省级三档：省名（去后缀）/ 省会 / 单字简称 互不相同', () => {
    const out: Record<string, string[]> = {};
    for (const c of provinceChoices) {
      out[String(c.value)] = ALL_NAMING.map((n) => c.labelName!('130000', ctx.data, n));
    }
    for (const [value, texts] of Object.entries(out)) {
      expect(new Set(texts).size, `${value} 同一单位在不同组合下文本漂移`).toBe(1);
      expect(texts[0].length, `${value} 是空串`).toBeGreaterThan(0);
    }
    expect(out.full[0]).toBe('河北'); // 省名档的标签是去后缀省名
    expect(out.capital[0]).toBe('石家庄');
    expect(out.abbr[0]).toBe('冀');
  });

  it('世界三档：国名 / 首都名 / 国旗档的文本（国旗档的文本口径 = 国名）', () => {
    const zh = ALL_NAMING.find((n) => n.lang === 'zh')!;
    const en = ALL_NAMING.find((n) => n.lang === 'en')!;
    expect(namingChoiceOf('world', 'country')!.questionName!('JPN', ctx.data, zh)).toBe('日本');
    expect(namingChoiceOf('world', 'country')!.questionName!('JPN', ctx.data, en)).toBe('Japan');
    expect(namingChoiceOf('world', 'capital')!.questionName!('JPN', ctx.data, zh)).toBe('东京');
    expect(namingChoiceOf('world', 'capital')!.questionName!('JPN', ctx.data, en)).toBe('Tokyo');
    const flag = namingChoiceOf('world', 'flag')!;
    expect(flag.questionName!('JPN', ctx.data, zh)).toBe('日本');
    // 图片钩子：题面用原始 SVG、地图标签用缩略图（两套资源，见 build-flag-thumbs.mjs）
    expect(flag.questionImage!('JPN', ctx.data)).toBe('data/flags/jp.svg');
    expect(flag.labelImage!('JPN', ctx.data)).toBe('data/flags/thumbs/jp.webp');
  });

  it('国旗档只在点击模式提供；输入模式不会出现"按了也没用"的段', () => {
    const flag = namingChoiceOf('world', 'flag')!;
    expect(choiceAvailableIn(flag, 'click')).toBe(true);
    expect(choiceAvailableIn(flag, 'self')).toBe(false);
    // 其余档在所有模式下都提供
    for (const c of namingGroupOf('world').choices) {
      if (c.value === 'flag') continue;
      for (const m of ALL_MODES) expect(choiceAvailableIn(c, m), `${c.value} @ ${m}`).toBe(true);
    }
  });

  it('缺数据时逐级回落，不给空标签', () => {
    const bare = makeTestCtx({ data: { countries: [], countryNames: {}, provinces: [] } }).ctx;
    const zh = ALL_NAMING[0];
    for (const c of worldChoices) {
      const text = c.questionName!('JPN', bare.data, zh);
      expect(text.length, `world=${c.value} 缺数据时给了空文本`).toBeGreaterThan(0);
    }
    for (const c of provinceChoices) {
      const text = c.labelName!('130000', bare.data, zh);
      expect(text.length, `province=${c.value} 缺数据时给了空文本`).toBeGreaterThan(0);
    }
  });
});

describe('口径注册表 · 判题（通过输入模式实际走一遍）', () => {
  /** 造一个省级全国输入模式，题目固定为某省，然后提交一个答案，返回是否判对。 */
  const submit = (naming: Partial<QuestionNaming>, question: string, answer: string) => {
    const { ctx } = makeTestCtx({ data: DATA });
    const mode = new InputMode(ctx);
    mode.applyScopeQuery({ granularity: 'province', continent: null, subregion: null, province: null });
    mode.setQuestionNaming(naming);
    const d = mode.diagnostics();
    d.question = question;
    mode.onSubmit(answer);
    return d.green.has(question);
  };

  it('省名档：认省全名与去后缀省名，不认省会与简称', () => {
    expect(submit({ province: 'full' }, '130000', '河北')).toBe(true);
    expect(submit({ province: 'full' }, '130000', '河北省')).toBe(true);
    expect(submit({ province: 'full' }, '130000', '石家庄')).toBe(false);
    expect(submit({ province: 'full' }, '130000', '冀')).toBe(false);
  });

  it('省会档：认省会名（含「市」后缀），不认省名与简称', () => {
    expect(submit({ province: 'capital' }, '130000', '石家庄')).toBe(true);
    expect(submit({ province: 'capital' }, '130000', '石家庄市')).toBe(true);
    expect(submit({ province: 'capital' }, '130000', '河北')).toBe(false);
    expect(submit({ province: 'capital' }, '130000', '冀')).toBe(false);
  });

  it('简称档：只认单字简称', () => {
    expect(submit({ province: 'abbr' }, '130000', '冀')).toBe(true);
    expect(submit({ province: 'abbr' }, '130000', '河北')).toBe(false);
    expect(submit({ province: 'abbr' }, '130000', '石家庄')).toBe(false);
  });

  it('世界档判题由注册表说话：国名档认国名/英文名，首都档只认首都（都走 InputMode 真实路径）', () => {
    const run = (naming: Partial<QuestionNaming>, answer: string) => {
      const { ctx } = makeTestCtx({ data: DATA });
      const mode = new InputMode(ctx);
      mode.applyScopeQuery({ granularity: 'world', continent: null, subregion: null, province: null });
      mode.setQuestionNaming(naming);
      const d = mode.diagnostics();
      d.question = 'JPN';
      mode.onSubmit(answer);
      return d.green.has('JPN');
    };
    expect(run({ world: 'country' }, '日本')).toBe(true);
    expect(run({ world: 'country' }, 'Japan')).toBe(true); // 同一个名字的两种写法
    expect(run({ world: 'country' }, '东京')).toBe(false);
    expect(run({ world: 'capital' }, '东京')).toBe(true);
    expect(run({ world: 'capital' }, 'Tokyo')).toBe(true);
    expect(run({ world: 'capital' }, '日本')).toBe(false);
  });
});

describe('口径注册表的取值器', () => {
  it('activeChoiceOf 对非法取值回落该组第一档（不返回 undefined）', () => {
    const weird = { world: 'nope' as QuestionNaming['world'], lang: 'zh' as const, province: 'full' as const };
    expect(activeChoiceOf('world', weird).value).toBe('country');
  });

  it('namingGroupOf 对三个字段都返回同一份表里的组（引用稳定）', () => {
    for (const field of ['world', 'lang', 'province'] as NamingField[]) {
      expect(namingGroupOf(field)).toBe(NAMING_GROUPS.find((g) => g.field === field));
      expect(namingGroupOf(field).field).toBe(field);
    }
  });

  it('judge 拿到的是当前出题池与当前题（不是全量数据）', () => {
    const choice = namingChoiceOf('world', 'capital')!;
    const { ctx } = makeTestCtx({ data: DATA });
    const judgeCtx: NamingJudgeCtx = {
      data: ctx.data,
      pool: [],
      question: null,
      worldMatcher: new WorldMatcher(ctx.data.countries, ctx.data.countryNames),
    };
    // 池为空 / 没有当前题 → 不判对任何东西（首都档的判据必须落在"这一题"上）
    expect(choice.judge!('东京', judgeCtx)).toBeNull();
  });
});
