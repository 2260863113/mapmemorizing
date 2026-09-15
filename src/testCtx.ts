/**
 * 测试用的假 `ModeCtx`（模式层单测的公共夹具）。
 *
 * ## 为什么集中到这里
 * `quizNaming.test.ts` 与 `browseLabels.test.ts` 原先各自写了一份约 65 行的假 ctx（假渲染器 +
 * 假 store + 假搜索框 + `as unknown as ModeCtx` 强转），两份逐字重复、且每当 `ModeCtx` 加一个字段
 * 就要同步补两处 —— 与 `testFixture.makeAppData` 当年被抽出来是同一个理由。
 *
 * ## 设计要点
 * · **默认 `randomUnit` 取池首**：题序因此完全可预期（夹具里的池顺序即题序），断言不用去猜随机结果。
 * · **记录型替身**：渲染状态 / 题面 / toast / 占位提示都存进数组，测试断言"实际会发生什么"，
 *   而不是断言"某个方法被调用过"（后者会随实现细节漂移）。
 * · 不碰 DOM、不碰 ECharts：调用方仍应避免走 `enter()` 这类会生成开始卡片 DOM 的路径
 *   （需要时自己 stub `document`，见 browseLabels.test.ts 的一处用例）。
 */
import type { ModeCtx } from './modes/types';
import type { AppData, RenderState, Unit } from './types';
import { makeAppData } from './testFixture';
import { Matcher } from './matcher';

export interface TestCtxOptions {
  /** AppData 覆盖（未列出的字段用 `makeAppData` 的空壳）。 */
  data?: Partial<AppData>;
  /** 「未开始时显示地图标签」全局开关（默认开）。 */
  showBrowseLabels?: boolean;
  /** 随机取题（默认取池首，让题序可预期）。 */
  randomUnit?: (pool: Unit[]) => Unit;
}

export interface TestCtx {
  ctx: ModeCtx;
  /** 每次 `render()` 收到的渲染状态（`states.at(-1)` = 当前画面）。 */
  states: RenderState[];
  /** 顶栏题面/提示的 HTML（`hints.at(-1)`）。 */
  hints: string[];
  /** toast 文案。 */
  toasts: string[];
  /** 输入框占位提示（口径切换时写入）。 */
  placeholders: string[];
}

export function makeTestCtx(opts: TestCtxOptions = {}): TestCtx {
  const states: RenderState[] = [];
  const hints: string[] = [];
  const toasts: string[] = [];
  const placeholders: string[] = [];
  const renderer = {
    setWorldMode: () => {},
    setProvinceMode: () => {},
    render: (state: RenderState) => {
      states.push(state);
    },
    drillToProvince: () => {},
    backToNation: () => {},
    currentProvince: () => null,
    flash: () => {},
    focusUnit: () => {},
    focusWorldCountry: () => {},
    panUnit: () => {},
    panWorldCountry: () => {},
  };
  /** 熟练度记录：所有档位共用同一份空记录（单测不关心分数，只关心"读了它"）。 */
  const practice = { correctCount: 0, wrongCount: 0, score: 0 };
  const data = makeAppData(opts.data);
  const ctx = {
    data,
    renderer,
    matcher: new Matcher(data),
    store: {
      getPractice: () => practice,
      getProvincePractice: () => practice,
      getWorldPractice: () => practice,
      recordAnswer: () => {},
      recordProvinceAnswer: () => {},
      recordWorldAnswer: () => {},
    },
    search: {
      setPlaceholder: (v: string) => placeholders.push(v),
      setRequireEnter: () => {},
      clear: () => {},
      focus: () => {},
    },
    stats: {},
    settings: {
      darkMode: false,
      cityBoundaryTone: 'light',
      provinceBoundaryTone: 'dark',
      worldBoundaryTone: 'mid',
      ignoreTinyCountries: false,
      showBrowseLabels: opts.showBrowseLabels ?? true,
    },
    byAdcode: new Map(data.allUnits.map((u) => [u.adcode, u])),
    toast: (m: string) => toasts.push(m),
    setHint: (html: string) => hints.push(html),
    showTimer: () => {},
    showStopwatch: () => {},
    showSummary: () => {},
    hideSummary: () => {},
    updateProgress: () => {},
    randomUnit: opts.randomUnit ?? ((pool: Unit[]) => pool[0]),
  } as unknown as ModeCtx;
  return { ctx, states, hints, toasts, placeholders };
}
