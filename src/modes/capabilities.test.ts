import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  ALL_MODES,
  GRANULARITY_MODES,
  LEADERBOARD_MODES,
  MODE_SPECS,
  ORDER_TOGGLE_IDS,
  TIMED_TEST_MODES,
  defaultOrderOf,
  hasGranularityToggle,
  helpKeysOf,
  isAnalysisMode,
  isLeaderboardMode,
  isNonMapMode,
  isTimedTestMode,
  isTwoPhaseMode,
  modeSpec,
  modeTitle,
  orderToggleIdOf,
  showsSearchBox,
  testButtonsVisible,
  usesSettlementCard,
} from './capabilities';
import { validMode } from '../../functions/_lib/validate';
import { t } from '../i18n';
import type { Mode } from '../types';

/**
 * **模式目录**（能力表）的跨平面一致性验证。
 *
 * 三件事在这里被钉住：
 * ① **与服务端白名单一致**：`LEADERBOARD_MODES` 是前端「显示排行榜 + 允许提交」的判据，
 *    服务端 `validMode` 是白名单。两侧一旦漂移，表现是「界面上有榜、成绩提交永远被拒」
 *    （或反之），而且只在真机上点提交才会发现。
 * ② **模式名只有一处来源**：模式 tab（`index.html` 的首屏兜底文字）、每模式设置浮层标题、
 *    排行榜标题、开始卡片标题全部读 `titleKey`。从前这里漂过一次 —— 输入模式的设置浮层
 *    写着「自测模式」，而 tab 与开始卡片写着「输入模式」。
 * ③ **`跳过/暂停/重置` 的显隐规则**逐模式钉住（原先散在 `chromeSync` 里的三个嵌套三元表达式，
 *    要同时在脑子里展开四五个模式的行为才能读懂）。
 */

const ALL: Mode[] = ['free', 'self', 'endless', 'click', 'board', 'admin', 'puzzle'];
const INDEX_HTML = readFileSync(path.join(process.cwd(), 'index.html'), 'utf8');

describe('LEADERBOARD_MODES', () => {
  it('与服务端成绩白名单逐项一致（多一个 = 前端有榜提交被拒，少一个 = 有榜却不显示）', () => {
    const backend = ALL.filter((m) => validMode(m));
    expect([...LEADERBOARD_MODES].sort()).toEqual([...backend].sort());
  });

  it('表内无重复项，且每一项都是合法的 Mode', () => {
    expect(new Set(LEADERBOARD_MODES).size).toBe(LEADERBOARD_MODES.length);
    for (const m of LEADERBOARD_MODES) expect(ALL).toContain(m);
  });

  it('isLeaderboardMode 只认表内模式（undefined / 非测验模式一律 false）', () => {
    for (const m of ALL) {
      expect(isLeaderboardMode(m), m).toBe((LEADERBOARD_MODES as readonly string[]).includes(m));
    }
    expect(isLeaderboardMode(undefined)).toBe(false);
  });
});

describe('TIMED_TEST_MODES / GRANULARITY_MODES 的从属关系', () => {
  it('计时测验模式必须是排行榜模式（有 开始/暂停/跳过 就一定有榜）', () => {
    for (const m of TIMED_TEST_MODES) expect(isLeaderboardMode(m), m).toBe(true);
    // 反向不成立：拼图有榜，但生命周期是「选范围 → 盘面」两阶段，不是计时测验
    expect(isTimedTestMode('puzzle')).toBe(false);
  });

  it('粒度行只挂在计时测验模式上（熟练度分析的粒度走 analysis 行）', () => {
    for (const m of GRANULARITY_MODES) expect(isTimedTestMode(m), m).toBe(true);
    expect(hasGranularityToggle('free')).toBe(false);
    expect(hasGranularityToggle(undefined)).toBe(false);
  });

  it('非测验模式一律不是计时测验', () => {
    for (const m of ['free', 'board', 'admin'] as const) expect(isTimedTestMode(m), m).toBe(false);
  });
});

describe('模式目录 · 每个模式都有完整一行', () => {
  it('ALL_MODES 覆盖全部 Mode（加模式忘了加 spec 会让 tsc 先报错，这里再兜一层）', () => {
    expect([...ALL_MODES].sort()).toEqual([...ALL].sort());
    for (const m of ALL) expect(MODE_SPECS[m], m).toBeTruthy();
  });

  it('模式名唯一、非空，且都是真实存在的文案（键写错时 t() 会原样返回键名）', () => {
    const titles = ALL.map((m) => modeTitle(m));
    for (const [i, title] of titles.entries()) {
      expect(title.length, ALL[i]).toBeGreaterThan(0);
      expect(title, ALL[i]).not.toBe(MODE_SPECS[ALL[i]].titleKey);
      expect(title, ALL[i]).not.toContain('.title');
    }
    expect(new Set(titles).size).toBe(titles.length);
  });

  it('模式 tab 的首屏兜底文字与模式名逐字一致（改词必须两处同步，这里就是那道闸门）', () => {
    const tabModes: Mode[] = ['click', 'self', 'puzzle', 'endless'];
    for (const mode of tabModes) {
      const m = INDEX_HTML.match(new RegExp(`data-mode="${mode}"[^>]*>([^<]*)<`));
      expect(m, `index.html 里没有 ${mode} 的 tab`).toBeTruthy();
      expect(m![1].trim(), `tab「${mode}」与 modeTitle("${mode}") 不一致`).toBe(modeTitle(mode));
    }
  });

  it('熟练度分析按钮（右上角）也是同一个模式名', () => {
    const m = INDEX_HTML.match(/id="btn-free"[^>]*>([^<]*)</);
    expect(m?.[1].trim()).toBe(modeTitle('free'));
  });

  it('顺序行 id 由表推导，且都存在于 index.html；没有顺序行的模式也不该有默认顺序', () => {
    expect(ORDER_TOGGLE_IDS.length).toBe(GRANULARITY_MODES.length);
    for (const id of ORDER_TOGGLE_IDS) expect(INDEX_HTML, id).toContain(`id="${id}"`);
    for (const m of ALL) {
      const id = orderToggleIdOf(m);
      // 表的字面量联合里"未声明的可选字段"不存在，故对比时走宽化视图（`modeSpec`）
      if (id) expect(id).toBe(modeSpec(m)?.orderToggleId);
      else expect(defaultOrderOf(m), m).toBeNull();
    }
  });

  it('帮助文案：声明了 help 的模式都取得到标题与正文，其余一律没有（只有非地图模式可以没有）', () => {
    for (const m of ALL) {
      const keys = helpKeysOf(m);
      if (keys) {
        expect(t(keys.title).length, m).toBeGreaterThan(0);
        expect(t(keys.body).length, m).toBeGreaterThan(0);
        expect(t(keys.title), m).toContain(modeTitle(m)); // 「X 说明」
      } else {
        expect(isNonMapMode(m), `只有非地图模式可以没有帮助：${m}`).toBe(true);
      }
    }
    expect(helpKeysOf(undefined)).toBeNull();
  });
});

describe('testButtonsVisible（跳过/暂停/重置 的唯一实现）', () => {
  const cases: {
    mode: Mode | undefined;
    started: boolean;
    board?: boolean;
    expect: { skip: boolean; pause: boolean; reset: boolean };
    why: string;
  }[] = [
    { mode: 'self', started: false, expect: { skip: false, pause: false, reset: true }, why: '输入模式未开始：只留重置' },
    { mode: 'self', started: true, expect: { skip: true, pause: true, reset: true }, why: '输入模式进行中：三个按钮' },
    { mode: 'click', started: false, expect: { skip: false, pause: false, reset: true }, why: '点击模式未开始：只留重置' },
    { mode: 'click', started: true, expect: { skip: true, pause: true, reset: true }, why: '点击模式进行中：三个按钮' },
    { mode: 'endless', started: false, expect: { skip: false, pause: true, reset: true }, why: '无尽闯关：没有跳过（重置 = 重开一局）' },
    { mode: 'endless', started: true, expect: { skip: false, pause: true, reset: true }, why: '无尽闯关进行中同样如此' },
    { mode: 'puzzle', started: false, board: false, expect: { skip: false, pause: false, reset: true }, why: '拼图选范围阶段：只留重置' },
    { mode: 'puzzle', started: true, board: true, expect: { skip: false, pause: true, reset: true }, why: '拼图盘面：暂停 + 重置' },
    { mode: 'free', started: false, expect: { skip: false, pause: false, reset: true }, why: '熟练度分析：只有重置（清空熟练度，没有暂停/跳过）' },
    { mode: 'board', started: false, expect: { skip: false, pause: false, reset: false }, why: '留言板没有按钮区（非地图模式整块界面）' },
    { mode: 'admin', started: false, expect: { skip: false, pause: false, reset: false }, why: '管理端没有按钮区' },
    { mode: undefined, started: false, expect: { skip: false, pause: false, reset: false }, why: '还没进入任何模式' },
  ];
  for (const c of cases) {
    it(`${c.mode ?? '(无模式)'} started=${c.started}${c.board ? ' board' : ''}：${c.why}`, () => {
      expect(testButtonsVisible(c.mode, { started: c.started, board: c.board ?? false })).toEqual(c.expect);
    });
  }

  it('拼图的「暂停」只在盘面阶段（选范围阶段没有可暂停的东西）', () => {
    expect(testButtonsVisible('puzzle', { started: true, board: false }).pause).toBe(false);
    expect(testButtonsVisible('puzzle', { started: true, board: true }).pause).toBe(true);
  });
});

describe('搜索框 / 结算卡片 / 三个生命周期谓词', () => {
  it('搜索框：无尽常驻、输入仅测试中、其余没有', () => {
    expect(showsSearchBox('endless', false)).toBe(true);
    expect(showsSearchBox('self', false)).toBe(false);
    expect(showsSearchBox('self', true)).toBe(true);
    expect(showsSearchBox('click', true)).toBe(false);
    expect(showsSearchBox(undefined, true)).toBe(false);
  });

  it('重置弹结算卡片的只有输入/点击/拼图（无尽闯关自成一套收尾）', () => {
    for (const m of ['self', 'click', 'puzzle'] as const) expect(usesSettlementCard(m), m).toBe(true);
    for (const m of ['endless', 'free', 'board', 'admin'] as const) expect(usesSettlementCard(m), m).toBe(false);
    expect(usesSettlementCard(undefined)).toBe(false);
  });

  it('isNonMapMode / isAnalysisMode / isTwoPhaseMode 互斥且覆盖全部模式', () => {
    for (const m of ALL) {
      const flags = [isNonMapMode(m), isAnalysisMode(m), isTwoPhaseMode(m)].filter(Boolean).length;
      expect(flags, m).toBeLessThanOrEqual(1);
    }
    expect(ALL.filter(isNonMapMode).sort()).toEqual(['admin', 'board']);
    expect(ALL.filter(isAnalysisMode)).toEqual(['free']);
    expect(ALL.filter(isTwoPhaseMode)).toEqual(['puzzle']);
  });
});
