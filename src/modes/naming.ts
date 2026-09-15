/**
 * **取名口径注册表**：「考什么名字」这件事的唯一声明处。
 *
 * ## 为什么要一张表
 * 「国名/首都/国旗」「中文/英文」「省名/省会/简称」这三组分段按钮原先散在 10 个文件里：
 * 按钮 HTML 在 `index.html`、显隐在 `chromeSync`、接线在 `appController`、题面与标签文本在
 * `mapQuizMode`、判题在 `input.ts`、占位提示又在 `input.ts` 的另一处、国旗资源在 `click.ts`、
 * 存盘校验在 `namingStore`。2026-09 加一档「省会」就要动 11 个文件，且每一处都要自己记得
 * 「这里也有个口径」—— 漏一处的表现是界面自相矛盾（题面写省会、标签写省名、判题只认简称）。
 *
 * 收敛到这张表后，**加一档 = 加一行**：
 *   · 分段按钮（值、文字、只在哪些模式出现）→ `INDEX_GROUPS` 渲染；
 *   · 题面 / 答错提示 / 地图标签的文本 → `questionName` / `labelName`；
 *   · 题面用图片（国旗）→ `questionImage`；地图标签用图片（国旗缩略图）→ `labelImage`；
 *   · 输入模式判题 → `judge`；占位提示 → `placeholderKey`。
 *
 * ## 三组的语义差别（这张表要能表达出来，否则就只是把 if 换了个地方）
 * · `world` 组：**改"考什么"**（国名 / 首都 / 国旗），排他；`flag` 只在点击模式提供
 *   （输入模式没有"看图点地图"这条路）。
 * · `lang` 组：**不改"考什么"，只改用什么语言写**——它是"同一个名字的两种写法"，
 *   所以它不给 `judge`（中英文都算对），只影响 `questionName`/`labelName` 的内容语言，
 *   而界面文案始终中文。
 * · `province` 组：同样改"考什么"（省名 / 省会 / 简称），三档判题各自严格。
 *
 * ## 与「题面/标签文本」的关系
 * 文本逻辑仍然只有一处（就是这里），`MapQuizMode` 的 `displayNameOf` / `provinceLabelTextOf`
 * 退化成薄薄的转发 —— 那两处是题面、地图标签、答错提示共用的同一份实现（历史坑：三处各拼一份）。
 */
import type { AppData, Mode, Unit } from '../types';
import type { MessagesKey } from '../i18n';
import type { QuestionNaming } from './types';
import { normalizeProvince } from '../matcher';
import {
  isProvinceAbbrInput,
  isProvinceCapitalInput,
  provinceAbbr,
  provinceCapital,
  provinceByAdcode,
  provinceShortName,
} from '../province';
import type { WorldMatcher } from '../worldNames';
import { flagSrcOf, flagThumbSrcOf } from './flagPreload';

/** 三个口径维度（= `QuestionNaming` 的字段）。 */
export type NamingField = keyof QuestionNaming;

/** 输入判题要用到的上下文（由 `InputMode` 提供；地级档不走注册表）。 */
export interface NamingJudgeCtx {
  data: AppData;
  /** 当前出题池（省级全国 = 34 省；世界全国 = 当前范围内的国家）。 */
  pool: Unit[];
  /** 当前题目 id（世界档首都档要知道"是不是**这一题**的首都"）。 */
  question: string | null;
  /** 世界国名匹配器（国名档用）。 */
  worldMatcher: WorldMatcher;
}

/**
 * 一档取值。
 *
 * 三类维度各有分工，故这些钩子**全是可选的**：
 * · `world` 行给 `questionName`/`labelName`（+ 国旗两档给 image 钩子）；
 * · `lang` 行一个钩子都不给 —— 它就是"写在 world 行里的语言开关"；
 * · `province` 行给 `questionName`/`labelName` + `judge`。
 */
export interface NamingChoice<F extends NamingField> {
  value: QuestionNaming[F];
  /** 分段按钮上的字。 */
  label: string;
  /** 只在列出的模式提供（省略 = 所有有该行的模式都有）；点击/输入是唯一会用到它的两个模式。 */
  modes?: readonly Mode[];
  /** 输入框占位提示的文案键（`lang` 组没有占位提示）。 */
  placeholderKey?(naming: QuestionNaming): MessagesKey;
  /** 题面 / 答错提示里的名字。`id`：省级 = adcode，世界 = iso_a3。 */
  questionName?(id: string, data: AppData, naming: QuestionNaming): string;
  /** 地图标签的文本（省级「省名」档与题面**不同**：题面是省全名、标签是去后缀省名）。 */
  labelName?(id: string, data: AppData, naming: QuestionNaming): string;
  /** 题面改用图片时返回资源 URL（国旗档 = 原始 SVG；null = 回落文字题面）。 */
  questionImage?(id: string, data: AppData): string | null;
  /** 地图标签改用图片时返回缩略图 URL（国旗档；null = 回落文字标签）。 */
  labelImage?(id: string, data: AppData): string | null;
  /** 输入模式判题：命中返回单位 id，否则 null（省略 = 这一档不参与输入判题）。 */
  judge?(input: string, ctx: NamingJudgeCtx): string | null;
}

/** 一组分段按钮（一个 `QuestionNaming` 字段）。 */
export interface NamingGroup<F extends NamingField = NamingField> {
  field: F;
  /** 分段按钮容器的 DOM id（HTML 里只留容器，按钮由 `namingControls` 生成）。 */
  toggleId: string;
  ariaLabel: string;
  /** 这一组挂在哪个粒度上（世界全国 / 省级全国）。 */
  granularity: 'world' | 'province';
  choices: readonly NamingChoice<F>[];
}

// ==================== 世界组：国名 / 首都 / 国旗 ====================

/** 国名（语言开关生效；数据缺失回落 iso）。 */
function worldCountryName(id: string, data: AppData, naming: QuestionNaming): string {
  const fallback = countryName(data, id);
  if (naming.lang === 'en') return data.countryNames[id]?.en || fallback;
  return fallback;
}

/** 首都名（语言开关生效；缺首都数据回落国名 —— 保证永远有可显示文本）。 */
function worldCapitalName(id: string, data: AppData, naming: QuestionNaming): string {
  const names = data.countryNames[id];
  const capital = naming.lang === 'en' ? names?.capitalEn : names?.capital;
  return capital || countryName(data, id);
}

/** 国家中文名（找不到就回落 iso）。 */
function countryName(data: AppData, iso: string): string {
  return data.countries.find((c) => c.iso === iso)?.name ?? iso;
}

const WORLD_CHOICES: readonly NamingChoice<'world'>[] = [
  {
    value: 'country',
    label: '国名',
    placeholderKey: (n) => (n.lang === 'en' ? 'self.worldEnPlaceholder' : 'self.worldPlaceholder'),
    questionName: worldCountryName,
    labelName: worldCountryName,
    judge: (input, ctx) => ctx.worldMatcher.bestMatch(input),
  },
  {
    value: 'capital',
    label: '首都',
    placeholderKey: (n) => (n.lang === 'en' ? 'self.capitalEnPlaceholder' : 'self.capitalPlaceholder'),
    questionName: worldCapitalName,
    labelName: worldCapitalName,
    // 首都档不走 `bestMatch` 的「重名剔除」，改用 acceptsCapital：判据是"这个输入是不是**当前这一题**
    // 的合法名字"（牙买加 Kingston 与圣文森特 Kingstown 的通用译名同为「金斯敦」，两边都被剔掉会让
    // 这两国在首都档**永远答不出来**，见 worldNames.test.ts 的回归闸门）。
    judge: (input, ctx) => (ctx.worldMatcher.acceptsCapital(ctx.question ?? '', input) ? ctx.question : null),
  },
  {
    value: 'flag',
    label: '国旗',
    // 题面给国旗图片、点地图上对应的国家：输入模式没有"看图点地图"这条路，故只在点击模式提供。
    modes: ['click'],
    // 输入模式不会到这一档（段按钮不显示）；占位提示与国名档一致，只是为了让"每档都有提示"这条不变量成立。
    placeholderKey: (n) => (n.lang === 'en' ? 'self.worldEnPlaceholder' : 'self.worldPlaceholder'),
    // 国旗档的**题面**是图片，故题目文本仍给国名：答错提示与已作答标签要读得懂"刚认出的这面旗是哪国"。
    questionName: worldCountryName,
    labelName: worldCountryName,
    questionImage: (id, data) => flagSrcOf(data, id),
    labelImage: (id, data) => flagThumbSrcOf(data, id),
  },
];

const LANG_CHOICES: readonly NamingChoice<'lang'>[] = [
  { value: 'zh', label: '中文' },
  { value: 'en', label: '英文' },
];

// ==================== 省级组：省名 / 省会 / 简称 ====================

/** 省级档里"考什么"对应的名字（**按传入的档取值算**，不回头看 `naming.province`）。 */
function provinceName(value: QuestionNaming['province'], id: string, data: AppData): string {
  if (value === 'abbr') return provinceAbbr(data, id);
  if (value === 'capital') return provinceCapital(data, id);
  return provinceByAdcode(data, id)?.name ?? provinceShortName(data, id);
}

/** 省名档判题：精确匹配省名（全名或去后缀名，二者等价），不认简称与省会。 */
function judgeProvinceFull(input: string, ctx: NamingJudgeCtx): string | null {
  const ni = normalizeProvince(input);
  if (!ni) return null;
  for (const p of ctx.pool) {
    if (normalizeProvince(p.name) === ni || normalizeProvince(p.shortName) === ni) return p.adcode;
  }
  return null;
}

/**
 * 造一档省级口径。
 *
 * ⚠ 每档的名字函数**只认自己那一档的取值**（`value`），不去读 `naming.province`：
 * 后者会让"这一档的函数"其实取决于调用方传进来的整个口径（拿 full 档的函数配 abbr 的口径会算出简称），
 * 那正是这张表要消灭的那类隐式耦合。`naming.test.ts` 有一条不变量专门钉住这件事
 * （同一档在各种口径组合下产出的文本必须一致）。
 */
function provinceChoice(
  value: QuestionNaming['province'],
  label: string,
  placeholderKey: MessagesKey,
  judge: NamingChoice<'province'>['judge'],
): NamingChoice<'province'> {
  return {
    value,
    label,
    placeholderKey: () => placeholderKey,
    // 题面：省名档是**省全名**（历史行为，如 广东省）
    questionName: (id, data) => provinceName(value, id, data),
    // 地图标签：省名档是**去后缀省名**（广东），与题面不同；省会/简称档两者一致
    labelName: (id, data) => (value === 'full' ? provinceShortName(data, id) : provinceName(value, id, data)),
    judge,
  };
}

const PROVINCE_CHOICES: readonly NamingChoice<'province'>[] = [
  provinceChoice('full', '省名', 'self.provincePlaceholder', judgeProvinceFull),
  // 省会档只认省会名（「石家庄」与「石家庄市」都算，那是同一个名字的行政后缀写法），不认省名与简称。
  provinceChoice('capital', '省会', 'self.provinceCapitalPlaceholder', (input, ctx) =>
    ctx.pool.find((p) => isProvinceCapitalInput(ctx.data, p.adcode, input))?.adcode ?? null,
  ),
  // 简称档只认单字简称（含 蜀/黔/滇/秦/陇 等官方并存写法），不认省名 —— 见 province.isProvinceAbbrInput。
  provinceChoice('abbr', '简称', 'self.abbrPlaceholder', (input, ctx) =>
    ctx.pool.find((p) => isProvinceAbbrInput(ctx.data, p.adcode, input))?.adcode ?? null,
  ),
];

/** 全部组（顺序即 UI 里的行序）。 */
export const NAMING_GROUPS: readonly NamingGroup[] = [
  { field: 'world', toggleId: 'world-name-toggle', ariaLabel: '世界档题面：按国名、首都或国旗', granularity: 'world', choices: WORLD_CHOICES },
  { field: 'lang', toggleId: 'world-lang-toggle', ariaLabel: '世界档题面与标签语言：中文或英文', granularity: 'world', choices: LANG_CHOICES },
  { field: 'province', toggleId: 'province-name-toggle', ariaLabel: '省级全国题面：按省名、省会或简称', granularity: 'province', choices: PROVINCE_CHOICES },
];

/** 某字段的组。 */
export function namingGroupOf(field: NamingField): NamingGroup {
  return NAMING_GROUPS.find((g) => g.field === field)!;
}

/** 某字段 + 取值的档（取值非法时返回 undefined）。 */
export function namingChoiceOf(field: NamingField, value: string): NamingChoice<NamingField> | undefined {
  return namingGroupOf(field).choices.find((c) => c.value === value);
}

/** 当前口径下某字段的档。 */
export function activeChoiceOf(field: NamingField, naming: QuestionNaming): NamingChoice<NamingField> {
  return namingChoiceOf(field, naming[field]) ?? namingGroupOf(field).choices[0];
}

/** 该档在这些模式下是否提供（`modes` 省略 = 全部模式下都提供）。 */
export function choiceAvailableIn(choice: NamingChoice<NamingField>, mode: Mode | undefined): boolean {
  return choice.modes === undefined || (mode !== undefined && choice.modes.includes(mode));
}
