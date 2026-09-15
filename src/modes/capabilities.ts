/**
 * **模式目录**：每个模式一行，声明它有哪些 chrome、叫什么名字、以哪种方式收尾。
 *
 * 为什么单独成模块：这些事实原先以 `mode === 'self' || mode === 'click' || …` 的形式散落在
 * `appController`（排行榜资格、帮助文案、提交门槛）与 `chromeSync`（侧栏、按钮显隐、搜索框、各类
 * 分段行）里，共 30 余处，只靠注释互相提醒「与 xx 保持一致」。新增一个模式（拼图就是这么加进来的）
 * 必须逐处补，漏一处的表现是静默的 UI 不一致（按钮显示但功能没接上），而不是编译错误。
 *
 * 收敛到这里后：新增模式只改这张表；`capabilities.test.ts` 再锁住「与服务端白名单一致」、
 * 「每个模式都有 spec」「标题键都存在」这些跨平面不变量。
 *
 * ⚠ 表里的 `titleKey` 是模式名的**唯一来源**（模式 tab、每模式设置浮层标题、排行榜标题、
 * 开始卡片标题都读它）。`index.html` 里 tab 上的中文只是首屏兜底，由 `capabilities.test.ts`
 * 断言与它逐字一致 —— 从前这里漂过一次（输入模式的设置浮层标题写着「自测模式」）。
 */
import { t } from '../i18n';
import type { MessagesKey } from '../i18n';
import type { Mode } from '../types';

/** 一个模式的 chrome 清单。字段全部是**事实声明**，判断逻辑留在各调用点。 */
export interface ModeSpec {
  /** 模式名（中文）的文案键。模式名只有这一处来源。 */
  titleKey: MessagesKey;
  /** 该模式有「帮助」说明（顶栏 ? 按钮）；文案键固定为 `help.<mode>.title` / `.body`。 */
  help?: true;
  /** 有「开始 → 作答 → 结算」生命周期与 跳过/暂停/重置 一组按钮。 */
  timedTest?: true;
  /** 有排行榜资格（前端显示 + 允许提交）。服务端白名单必须一致（单测断言）。 */
  leaderboard?: true;
  /** 自己维护「世界 / 省级 / 市级」粒度行（熟练度分析的粒度是另一组元素，不在此列）。 */
  granularity?: true;
  /** 「顺序/随机/错题」分段行的元素 id（每个模式的行不同）。 */
  orderToggleId?: string;
  /** 出题顺序的默认值（写在这里，免得同步高亮时各传一个字面量）。 */
  defaultOrder?: 'sequential' | 'random' | 'wrong';
  /** 搜索输入框：`always` 常驻（无尽闯关）/ `started` 只在测试开始后（输入模式）/ 省略 = 没有。 */
  search?: 'always' | 'started';
  /**
   * 重置时弹「结算卡片」而不是直接重置（输入/点击的全国范围，拼图的两个可上榜范围）。
   * 无尽闯关不走这张卡片（游戏结束自成一套），故不声明。
   */
  settlementCard?: true;
  /** 不是地图模式（留言板/管理端）：地图整块隐藏，也不响应缩放。 */
  nonMap?: true;
  /** 熟练度分析：没有「开始」概念，粒度行与重置同行。 */
  analysis?: true;
  /** 拼图：两阶段生命周期（选范围 → 盘面），显隐规则自成一类。 */
  twoPhase?: true;
}

/**
 * 模式目录（顺序即这里书写的顺序，`MODES` 的白名单校验不看顺序）。
 * 写 `satisfies Record<Mode, ModeSpec>` 是为了「新增一个 Mode 就编译报错」——
 * 忘了加 spec 的模式会在 tsc 阶段被拦下，而不是运行时显示成空白按钮。
 */
export const MODE_SPECS = {
  self: {
    titleKey: 'mode.self.title',
    help: true,
    timedTest: true,
    leaderboard: true,
    granularity: true,
    orderToggleId: 'self-order-toggle',
    defaultOrder: 'sequential',
    search: 'started',
    settlementCard: true,
  },
  click: {
    titleKey: 'mode.click.title',
    help: true,
    timedTest: true,
    leaderboard: true,
    granularity: true,
    orderToggleId: 'click-order-toggle',
    defaultOrder: 'random',
    settlementCard: true,
  },
  endless: { titleKey: 'mode.endless.title', help: true, timedTest: true, leaderboard: true, search: 'always' },
  puzzle: { titleKey: 'mode.puzzle.title', help: true, leaderboard: true, twoPhase: true, settlementCard: true },
  free: { titleKey: 'mode.free.title', help: true, analysis: true },
  board: { titleKey: 'mode.board.title', nonMap: true },
  admin: { titleKey: 'mode.admin.title', nonMap: true },
} as const satisfies Record<Mode, ModeSpec>;

/**
 * 同一张表的**宽化视图**：谓词要读"这一行有没有某个能力"，而 `as const` 的字面量联合里
 * 未声明的可选字段是**不存在的属性**（`MODE_SPECS['free'].leaderboard` 直接访问会 tsc 报错）。
 * 读数一律走这张宽化表，字面量信息留给下面的类型推导用。
 */
const SPEC: Record<Mode, ModeSpec> = MODE_SPECS;

/** 全部模式的 id（顺序固定，供测试与遍历用）。改名避开服务端白名单的同名 `MODES`（那是"可上榜"子集）。 */
export const ALL_MODES = Object.keys(MODE_SPECS) as Mode[];

/** 取某模式的一行（未知模式返回 undefined）。 */
export function modeSpec(mode: Mode | undefined): ModeSpec | undefined {
  return mode === undefined ? undefined : SPEC[mode];
}

/** 模式名（模式 tab、设置浮层标题、排行榜标题、开始卡片标题共用这一处）。 */
export function modeTitle(mode: Mode): string {
  return t(SPEC[mode].titleKey);
}

// ==================== 派生谓词（保持既有名字，调用点不必改） ====================

/** 有排行榜 / 可提交成绩的模式。服务端白名单（`functions/_lib/validate.ts` 的 `MODES`）必须一致。 */
export const LEADERBOARD_MODES = ALL_MODES.filter((m) => SPEC[m].leaderboard === true);

/**
 * 排行榜模式类型：**由表推导**（`leaderboard: true` 那几行的字面量联合），
 * 而不是另写一份 `'self' | 'click' | …` —— 那样类型与表会各自漂移，且加模式时要改两处。
 */
export type LeaderboardMode = {
  [K in Mode]: (typeof MODE_SPECS)[K] extends { leaderboard: true } ? K : never;
}[Mode];

/** 有「帮助」说明的模式（`help.<mode>.title` / `.body` 两个键必然存在）。 */
export type HelpMode = { [K in Mode]: (typeof MODE_SPECS)[K] extends { help: true } ? K : never }[Mode];

export function isLeaderboardMode(mode: Mode | undefined): mode is LeaderboardMode {
  return mode !== undefined && (LEADERBOARD_MODES as readonly Mode[]).includes(mode);
}

/**
 * 计时测验模式：有「开始 → 作答 → 结算」生命周期与 跳过/暂停/重置 一组按钮。
 * （熟练度分析、留言板、管理端不是测验，拼图是另一套两阶段生命周期。）
 */
export const TIMED_TEST_MODES = ALL_MODES.filter((m) => SPEC[m].timedTest === true);

export function isTimedTestMode(mode: Mode | undefined): boolean {
  return mode !== undefined && (TIMED_TEST_MODES as readonly Mode[]).includes(mode);
}

/**
 * 由模式自己维护「世界 / 省级 / 市级」粒度的模式（粒度行归它所有）。
 * 熟练度分析也用粒度，但那是分析档位、随时可切，走 `analysis-granularity-toggle`，不在这张表里。
 */
export const GRANULARITY_MODES = ALL_MODES.filter((m) => SPEC[m].granularity === true);

export function hasGranularityToggle(mode: Mode | undefined): boolean {
  return mode !== undefined && (GRANULARITY_MODES as readonly Mode[]).includes(mode);
}

/** 非地图模式（留言板 / 管理端）。 */
export function isNonMapMode(mode: Mode | undefined): boolean {
  return mode !== undefined && SPEC[mode].nonMap === true;
}

/** 熟练度分析（有粒度、无「开始」，按钮布局不参与「未开始」那条排版规则）。 */
export function isAnalysisMode(mode: Mode | undefined): boolean {
  return mode !== undefined && SPEC[mode].analysis === true;
}

/** 两阶段生命周期模式（拼图）。 */
export function isTwoPhaseMode(mode: Mode | undefined): boolean {
  return mode !== undefined && SPEC[mode].twoPhase === true;
}

/** 该模式的「顺序/随机/错题」行元素 id（无 → null）。 */
export function orderToggleIdOf(mode: Mode | undefined): string | null {
  return mode === undefined ? null : (SPEC[mode].orderToggleId ?? null);
}

/** 该模式的帮助文案键（无帮助 → null）。键名由模式名拼出，**表里声明了 help 却没写文案会在 tsc 阶段报错**。 */
export function helpKeysOf(mode: Mode | undefined): { title: MessagesKey; body: MessagesKey } | null {
  if (mode === undefined || SPEC[mode].help !== true) return null;
  const m = mode as HelpMode;
  return { title: `help.${m}.title`, body: `help.${m}.body` };
}

/** 出题顺序行的默认值（无该行的模式返回 null）。 */
export function defaultOrderOf(mode: Mode | undefined): ModeSpec['defaultOrder'] | null {
  return mode === undefined ? null : (SPEC[mode].defaultOrder ?? null);
}

/** 搜索输入框是否显示（`started` 档只在测试开始后显示）。 */
export function showsSearchBox(mode: Mode | undefined, started: boolean): boolean {
  if (mode === undefined) return false;
  const search = SPEC[mode].search;
  return search === 'always' || (search === 'started' && started);
}

/** 重置是否弹「结算卡片」（而不是直接重置）。 */
export function usesSettlementCard(mode: Mode | undefined): boolean {
  return mode !== undefined && SPEC[mode].settlementCard === true;
}

/** 全部「顺序/随机/错题」行元素 id（由表推导：加第三个行 = 加一行 spec）。 */
export const ORDER_TOGGLE_IDS = ALL_MODES.map((m) => SPEC[m].orderToggleId).filter((id): id is string => id !== undefined);

/** `跳过/暂停/重置` 三个按钮的显隐输入。 */
export interface TestButtonState {
  /** 会话已开始（进行中/暂停都算）。 */
  started: boolean;
  /** 拼图盘面阶段（选范围阶段传 false）；非拼图模式恒 false。 */
  board: boolean;
}

/**
 * `跳过 / 暂停 / 重置` 三个按钮的显隐 —— **唯一实现**。
 *
 * 为什么抽成纯函数：这三条规则原先写在 `chromeSync.syncSegments` 里，是三个各自嵌套了
 * 「是不是拼图 / 是不是计时测验 / 是不是粒度模式」的三元表达式，读起来要同时在脑子里
 * 展开四五个模式的行为；而它们的差异是**每个模式的事实**（拼图没跳过、无尽闯关没有重置、
 * 熟练度分析没有"开始"），正该由模式表说话。抽出来后可以逐模式断言（`capabilities.test.ts`）。
 *
 * 语义与抽离前逐项一致（含几个看起来"怪"但确实是产品口径的点）：
 * · 拼图没有「跳过」（它没有答错这回事），有「暂停」，但只在盘面阶段显示；
 * · 无尽闯关没有「跳过」（它一直在倒计时，跳过就失去意义）；
 * · 「重置」除了**非地图模式**（留言板/管理端那些整块界面里没有按钮区要重置）之外一律显示：
 *   熟练度分析的重置是"清空熟练度"、无尽闯关的重置是重开一局，都不是"没有按钮"；
 * · 未开始（只有开始卡片）时，输入/点击模式只留「重置」——三个按钮从不同时出现。
 */
export function testButtonsVisible(
  mode: Mode | undefined,
  s: TestButtonState,
): { skip: boolean; pause: boolean; reset: boolean } {
  const timed = isTimedTestMode(mode);
  const twoPhase = isTwoPhaseMode(mode);
  const granularity = hasGranularityToggle(mode);
  // 未开始的输入/点击模式：三个按钮整组收起（只有「重置」留在原位）
  const beforeStartOfGranularityMode = granularity && !s.started;
  return {
    skip: timed && mode !== 'endless' && !beforeStartOfGranularityMode,
    pause: twoPhase ? s.board : timed && !beforeStartOfGranularityMode,
    reset: mode !== undefined && !isNonMapMode(mode),
  };
}
