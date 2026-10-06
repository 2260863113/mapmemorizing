import type { Mode, Unit } from '../types';
import type { ModeCtx, OrderMode } from './types';
import { t } from '../i18n';
import { formatElapsedSeconds } from '../ui/format';
import { pickWrongNext } from './wrongOrder';
import {
  loadSelfAutoFollow,
  loadSelfErrorRollback,
  loadSelfRequireEnter,
  saveSelfAutoFollow,
  saveSelfErrorRollback,
  saveSelfRequireEnter,
  type ModeSettingsPanel,
} from '../modeSettings';
import { canDrillProvince, drillTargetOfUnit } from '../province';
import { modeTitle } from './capabilities';
import { activeChoiceOf } from './naming';
import { cityFollowScale, worldFollowScale } from '../map/followScale';
import { MapQuizMode } from './mapQuizMode';
import type { QuizOrderDiagnostics } from './quizDiagnostics';
import { bfsStep } from './bfsOrder';
import { WorldMatcher } from '../worldNames';
import { showStartCard } from '../ui/dom';

/**
 * 答错后「下一题自动跟随」的延后时长（2026-10 需求 4）。
 *
 * 导出是为了让单测与验收探针能引用同一个数（与 `mapQuizMode.ts` 的 `ROLLBACK_RED_MS` 同一套路），
 * 避免测试里再抄一份 1000 之后与实现漂移。
 */
export const SELF_WRONG_FOLLOW_DELAY_MS = 1000;

/**
 * 输入模式（BFS 扩张）：
 * - 市级（全国/单省）：随机起点作为当前题目（蓝色）→ 输入名称；答对变绿、答错标红，随后继续扩张。
 *   顺序模式下出题走**严格广度优先**（bfsOrder.ts），且**优先选队列里与上一题相邻的地区**
 *   （2026-09 需求 9）；随机/错题模式各按自己的口径选题。
 * - 省级（全国）：出题池为 34 个省级单元，BFS 在省-省邻接上扩张；省级答题只计入省级熟练度。
 * - 世界（全国）：出题池为 195 个国家单元，BFS 在国家-国家邻接上扩张；国家答题只计入国家熟练度。
 * - 自动跟随（自由跟随）：出题后镜头聚焦该题，倍率 = 渲染器按省/面积算的**基准** × **系数**
 *   （中国地级与世界普通国 ×0.75、非洲 ×0.5；面积极小、几乎难以察觉的国家**不乘系数**，
 *   直接用世界跟随上限）。2026-09 需求 8 修订版，见 `map/followScale.ts`。
 */
export class InputMode extends MapQuizMode {
  readonly id: Mode = 'self';
  readonly title = modeTitle('self');
  private lastGreen: string | null = null;
  /**
   * 延后跟随（2026-10 需求 4）：答错后**下一题**的自动跟随要等这么久。
   *
   * 只在「未开错误回滚 + 开了自动跟随」时生效（回滚模式会重问同一题，不存在"跟到下一题"的问题）。
   * 1000ms 是用户给定值：旧行为是答错后镜头立刻被下一题拽走，用户根本来不及看红显与正确答案。
   */
  private followDelayMs = 0;
  /** 延后跟随的定时器（换题/暂停/重置/重开时取消，见 cancelFollowDelay）。 */
  private followDelayTimer: number | null = null;
  /**
   * 上一个**已作答**的单位（对错都算）——顺序模式「邻接优先」的参考点（2026-09 需求 9）。
   *
   * 为什么不用 `lastGreen`：它只在答对时更新，而「跟上一个输入的地区相邻」跟的是**用户刚答完的那题**
   * ——答错也说明他此刻在那一带，若只在答对时更新，答错后的下一题会突然跳回上一次答对的地方。
   */
  private lastAnswered: string | null = null;
  private activeProvince: string | null = null;
  /** BFS 前沿队列（顺序模式）：队首是下一题，队尾是刚发现的邻居。 */
  private bfsQueue: string[] = [];
  /** 当前 BFS 域（'world' / 'province' / 'city:<省 adcode>'）；换域即重新播种。 */
  private bfsDomain = '';
  private requireEnter = loadSelfRequireEnter(); // 按下 Enter 确认
  private autoFollow = loadSelfAutoFollow(); // 自动跟随（倍率固定默认值）
  private worldMatcher: WorldMatcher;

  constructor(ctx: ModeCtx) {
    super(ctx);
    this.worldMatcher = new WorldMatcher(ctx.data.countries, ctx.data.countryNames);
  }

  // ==================== 差异点实现 ====================

  protected storagePrefix() { return 'self'; }
  protected defaultOrderMode(): OrderMode { return 'sequential'; }
  protected parseOrderMode(raw: string | null): OrderMode {
    return raw === 'random' || raw === 'wrong' ? raw : 'sequential';
  }
  protected loadErrorRollback() { return loadSelfErrorRollback(); }
  protected saveErrorRollback(v: boolean) { saveSelfErrorRollback(v); }
  protected wrongToast(name: string, timedOut: boolean) {
    return timedOut ? t('self.timeoutAnswer', { name }) : t('self.correctAnswer', { name });
  }
  protected summaryHtml(elapsedMs: number) {
    let stat: string;
    if (this.isProvinceNation()) {
      stat = t('self.summaryProvince', { ok: this.ok, fail: this.fail, time: formatElapsedSeconds(elapsedMs), total: this.ok + this.fail });
    } else if (this.isWorldNation()) {
      stat = t('self.summaryWorld', { ok: this.ok, fail: this.fail, time: formatElapsedSeconds(elapsedMs), total: this.ok + this.fail });
    } else {
      stat = t('self.summary', { ok: this.ok, fail: this.fail, time: formatElapsedSeconds(elapsedMs), total: this.ok + this.fail });
    }
    return t('self.complete') + '<div class="sum-stats">' + stat + '</div>';
  }

  // ==================== 输入特有：设置 / 判题 ====================

  getModeSettings(): ModeSettingsPanel | null {
    return {
      title: modeTitle('self'),
      toggles: [
        { key: 'require-enter', label: t('settings.requireEnter'), value: this.requireEnter },
        { key: 'error-rollback', label: t('settings.errorRollback'), value: this.errorRollback },
        { key: 'auto-follow', label: t('settings.autoFollow'), value: this.autoFollow },
      ],
      onChange: (key, value) => {
        if (key === 'require-enter') {
          this.requireEnter = value;
          saveSelfRequireEnter(value);
          this.ctx.search.setRequireEnter(value);
        } else if (key === 'error-rollback') {
          this.errorRollback = value;
          saveSelfErrorRollback(value);
        } else if (key === 'auto-follow') {
          this.autoFollow = value;
          saveSelfAutoFollow(value);
        }
      },
    };
  }

  /**
   * 提交答案（按 Enter /「确定」）。
   *
   * 2026-09 需求 7：**空输入框按 Enter 也算一次提交**，按答错处理。
   * 旧实现在这里 `!v.trim()` 早退（"空输入什么都没发生"），用户口径是要它明确地算错：
   * 按下 Enter 是一个**动作**，动作就该有后果——否则玩家会以为 Enter 坏了（尤其是
   * 想跳过不认识的地名时，他连点几次都没反应）。答案本身为空串，不参与匹配。
   *
   * 注意只改这一处：`onInput`（边打边匹配）仍然要求非空，否则每次清空输入框都会自动判错。
   */
  onSubmit(v: string) {
    if (this.paused || this.rollbacking || !this.question) return;
    if (!v.trim()) {
      this.answer(false, true); // 空 Enter = 明确提交一个空答案，计为答错
      return;
    }
    const best = this.matchInput(v);
    this.answer(!!best && best === this.question, true);
  }

  onInput(v: string) {
    if (this.paused || this.rollbacking || !this.question || !v.trim()) return;
    const best = this.matchInput(v);
    if (best === this.question) this.answer(true, true);
  }

  /**
   * 输入匹配：省级全国 → 省名/省会/简称各自的判据；世界全国 → 国名/首都各自的判据；
   * 市级 → 地级单位匹配。
   *
   * 三种档的判据**不在这个类里**：它们跟着"考什么"一起声明在口径注册表
   * （`src/modes/naming.ts` 的 `judge`），这里只做"取当前档 → 交给它判 → 没有就走地级匹配"。
   * 加一档口径因此不用碰输入模式。
   */
  private matchInput(v: string): string | null {
    const field = this.isProvinceNation() ? 'province' : this.isWorldNation() ? 'world' : null;
    if (field) {
      const choice = activeChoiceOf(field, this.naming);
      if (choice.judge) {
        return choice.judge(v, {
          data: this.ctx.data,
          pool: this.activePool(),
          question: this.question,
          worldMatcher: this.worldMatcher,
        });
      }
    }
    return this.ctx.matcher.bestUnit(v)?.adcode ?? null;
  }

  onUnitClick(adcode: string) {
    if (this.paused || this.rollbacking) return true;
    if (this.started) {
      this.ctx.toast(t('common.underTestNoDrill'));
      return true;
    }
    // 世界粒度：未开始时单击国家 → 逐层下钻（世界→大洲→次区域；已在本范围内则保持）
    if (this.isWorldNation()) {
      const c = this.ctx.data.countries.find((x) => x.iso === adcode);
      if (c) this.drillFromWorldNation(c.continent, c.iso);
      return true;
    }
    // 省级全国：未开始时单击某省 → 下钻该省（变成该省地级输入练习；返回全国后回省级全国）
    if (this.isProvinceNation()) {
      this.drillFromProvinceNation(adcode);
      return true;
    }
    /* 市级模式未开始时单击地级市：由 renderer 自动下钻（返回非 true 即可）。
       唯一层级的京津沪渝/港澳台没有下级单位，必须拦在这里，否则 renderer 会钻成"1 个单位的省"。 */
    if (!canDrillProvince(drillTargetOfUnit(this.ctx.data, adcode))) {
      this.ctx.toast(t('common.noDrillSingleUnit'));
      return true;
    }
  }

  // ==================== 出题：BFS 扩张 ====================

  ask(u: Unit) {
    this.question = u.adcode;
    this.refresh();
    // 省级全国保持全国视野不聚焦；世界全国按面积决定缩放、中国地级按省标定阶梯，
    // 两者再各自乘**系数**（2026-09 需求 8 修订版：通用 ×0.75、非洲 ×0.5）。
    //
    // ⚠ 这个参数的语义已经换过两次，务必按当前定义读：第一版是「被渲染器忽略的绝对倍率 12」，
    //   第二版是「额外加成（+2/+6）」，**现在是倍率系数（×0.75/×0.5，缺省 1 = 不动基准）**。
    //   真正的乘法与夹取都在渲染器里（`renderer.focusUnit/focusWorldCountry` → `scaleFollowZoom`）；
    //   这里只回答"乘多少"。面积极小的国家由渲染器判定并改用跟随上限，模式侧不掺和。
    //
    // 「延后跟随」（2026-10 需求 4）：上一题答错且用户没开错误回滚时，`focusNext` 延后
    // `SELF_WRONG_FOLLOW_DELAY_MS` 再执行 —— 题面**立刻**换成新题（不受影响），只有镜头等一秒，
    // 让用户先看清红显与正确答案的位置。见 onWrong()。
    const delayMs = this.consumeFollowDelay();
    const focusNext = () => {
      // 定时器到期时重新校验状态：期间可能已经暂停/重置/切模式，那就不该再动镜头
      if (!this.autoFollow || !this.started || this.paused) return;
      if (this.isWorldNation()) {
        const continent = this.ctx.data.countries.find((c) => c.iso === u.adcode)?.continent;
        this.ctx.renderer.focusWorldCountry(u.adcode, worldFollowScale(continent));
      } else if (!this.isProvinceNation()) {
        this.ctx.renderer.focusUnit(u.adcode, cityFollowScale());
      }
    };
    this.cancelFollowDelay();
    if (this.autoFollow) {
      if (delayMs > 0) {
        this.followDelayTimer = window.setTimeout(() => {
          this.followDelayTimer = null;
          focusNext();
        }, delayMs);
      } else {
        focusNext();
      }
    }
    this.ctx.search.clear();
    this.ctx.search.focus();
    this.persist();
    this.ctx.showTimer(null);
  }

  /** 取走「下一题是否延后跟随」的标记（消费一次即清，避免影响再下一题）。 */
  private consumeFollowDelay(): number {
    const delay = this.followDelayMs;
    this.followDelayMs = 0;
    return delay;
  }

  /** 取消尚未到期的延后跟随（换题/暂停/重置/重开时都要，否则镜头会在错的时候跳走）。 */
  private cancelFollowDelay() {
    if (this.followDelayTimer !== null) {
      window.clearTimeout(this.followDelayTimer);
      this.followDelayTimer = null;
    }
  }

  nextUnit(pool: Unit[]): Unit {
    if (this.orderMode === 'random') return this.ctx.randomUnit(pool);
    if (this.orderMode === 'wrong') return pickWrongNext(pool, this.scoreOf, this.wrongOrder, this.ctx.toast);
    return this.pickNext(pool);
  }

  showStartHint() {
    showStartCard({
      id: 'self-start',
      title: modeTitle('self'),
      subtitle: t('common.scopePrefix', { scope: this.scopeLabel() }),
      onStart: () => this.start(false),
    });
  }

  refresh() {
    this.ctx.renderer.render({
      colorOf: (adcode) => {
        if (this.green.has(adcode)) return 'green';
        if (this.question === adcode) return 'blue';
        if (this.red.has(adcode)) return 'red';
        return 'gray';
      },
      // 未开始（浏览态）：显示全量地名；开始后清空，只留已作答的绿/红（见 browseLabels.ts）
      ...this.browseLabelState(),
      // 省名标签 / 国名标签：与点击模式共用基类实现（原先两个子类各抄了一份）
      provinceLabel: this.provinceLabelOf(),
      worldLabel: this.worldLabelOf(),
    });
  }

  // ==================== 输入特有：钩子覆写 ====================

  protected configureSearch(paused: boolean) {
    // 省级/世界档的提示与粒度、口径有关（暂停中也保留，便于看清在练什么）；
    // 地级档暂停时统一显示「输入地名」（与切模式时一致，历史行为）
    const scoped = this.isProvinceNation() || this.isWorldNation();
    const placeholder = paused && !scoped ? t('self.placeholderFull') : this.placeholderForNaming();
    this.ctx.search.setPlaceholder(placeholder);
    this.ctx.search.setRequireEnter(this.requireEnter);
  }

  /**
   * 按当前粒度与取名口径给出占位提示（口径变了提示要跟着变，否则用户不知道该输入什么）。
   * 文案键来自口径注册表（每一档自己声明），故加一档不用改这里；地级沿用历史提示。
   */
  private placeholderForNaming(): string {
    const field = this.isProvinceNation() ? 'province' : this.isWorldNation() ? 'world' : null;
    if (field) {
      const key = activeChoiceOf(field, this.naming).placeholderKey?.(this.naming);
      if (key) return t(key);
    }
    return t('self.placeholder');
  }

  /** 口径切换后占位提示要立刻反映新口径（暂停中保持「输入地名」，与切模式一致）。 */
  protected onNamingChanged() {
    if (!this.paused) this.ctx.search.setPlaceholder(this.placeholderForNaming());
  }

  protected resetSessionSpecific() {
    this.lastGreen = null;
    this.lastAnswered = null;
    this.activeProvince = this.scopeProvince;
    this.bfsQueue = [];
    this.bfsDomain = '';
    // 新会话不该继承上一局的延后跟随（定时器与标记都要清）
    this.followDelayMs = 0;
    this.cancelFollowDelay();
  }

  protected onEntered() { this.ctx.search.clear(); }
  protected onScopeChanged() { this.activeProvince = this.scopeProvince; this.bfsQueue = []; this.bfsDomain = ''; }
  protected onDrill(provinceAdcode: string) { this.activeProvince = provinceAdcode; this.bfsQueue = []; this.bfsDomain = ''; }
  /**
   * 作答开始（`answer()` 第一步就打这里，此时 `this.question` 仍是刚答的那道题）：
   * 记下「上一个已作答单位」供**邻接优先**使用（2026-09 需求 9）。
   *
   * 放在这里而不是 `onCorrect` 里：对错都要更新（见 lastAnswered 的说明），
   * 而且这一处天然在判题**之前**——不会因为"先算对错、再忘了记"而漏更新。
   */
  protected onAnswerStart() {
    this.lastAnswered = this.question;
    this.ctx.showTimer(null);
  }
  protected onCorrect(q: string) { this.lastGreen = q; }
  /**
   * 答错后置位「延后跟随」（2026-10 需求 4）。
   *
   * 条件就是用户口径的两条：**没开错误回滚**（开了就重问同一题，不存在跟到下一题的问题）
   * **且开了自动跟随**（自动跟随关着时本来就不动镜头，延后没有意义）。
   * 置位只影响 `ask()` 里那一次镜头移动；题面、红显、toast 都照旧立刻发生。
   */
  protected onWrong(_q: string) {
    this.followDelayMs = !this.errorRollback && this.autoFollow ? SELF_WRONG_FOLLOW_DELAY_MS : 0;
  }
  protected onRollbackRestored() { this.ctx.search.clear(); this.ctx.search.focus(); }
  protected onPause() {
    this.ctx.showTimer(null);
    this.cancelFollowDelay(); // 暂停时别让一秒后的镜头在遮罩后面偷偷移动
  }
  protected beforeStartPool() { this.activeProvince = this.scopeProvince; }
  protected onStarted(first: Unit) {
    if (!this.activeProvince) this.activeProvince = first.provinceAdcode;
    this.ctx.updateProgress();
    this.ctx.setHint('');
  }
  protected canStart(): boolean { return !this.started && !this.paused; }
  protected canDoubleClickDrill(): boolean { return !this.paused; }
  protected legacyResults(): boolean { return true; }
  protected persistExtra(): Record<string, unknown> {
    return {
      lastGreen: this.lastGreen,
      // 邻接优先的参考点一并持久化：刷新后「上一题是谁」不丢，下一题不会突然跳走
      lastAnswered: this.lastAnswered,
      activeProvince: this.activeProvince,
      wrongToastShown: this.wrongOrder.toastShown,
      // BFS 队列一并持久化：刷新后继续按同一顺序出题，而不是重新播种
      bfsQueue: this.bfsQueue,
      bfsDomain: this.bfsDomain,
    };
  }
  protected restoreSessionSpecific(record: Record<string, unknown>) {
    this.lastGreen = typeof record.lastGreen === 'string' && this.green.has(record.lastGreen) ? record.lastGreen : null;
    this.lastAnswered = typeof record.lastAnswered === 'string' ? record.lastAnswered : null;
    this.activeProvince = typeof record.activeProvince === 'string' ? record.activeProvince : this.scopeProvince;
    // 旧存档没有这两个字段 → 空队列，bfsNext 会按 lastGreen 重新播种，不会出错
    this.bfsQueue = Array.isArray(record.bfsQueue) ? record.bfsQueue.filter((x): x is string => typeof x === 'string') : [];
    this.bfsDomain = typeof record.bfsDomain === 'string' ? record.bfsDomain : '';
  }

  // ==================== 输入特有：BFS 顺序出题 ====================

  /**
   * 顺序模式出题：**严格广度优先**（实现与「不可能出现空洞」的论证见 bfsOrder.ts）。
   *
   * 2026-09 需求 9：在同一层里**优先选与上一题相邻的地区**（lastAnswered =
   * 「上一个已作答单位」，对错都更新）。真正的挑选逻辑在纯函数 bfsStep 里，
   * 这里只负责按分支选定「池」与「BFS 域」，并把参考点传下去。
   */
  private bfsNext(domain: string, pool: Unit[], seedRef: [number, number]): Unit {
    // 换域（世界 / 省级全国 / 某一个省）就丢弃旧队列：不同域的邻接图不可混用
    if (domain !== this.bfsDomain) {
      this.bfsDomain = domain;
      this.bfsQueue = [];
    }
    const byAdcode = new Map(pool.map((u) => [u.adcode, u]));
    const step = bfsStep({
      ids: pool.map((u) => u.adcode),
      neighborsOf: (id) => byAdcode.get(id)?.neighbors ?? [],
      isDone: (id) => this.green.has(id) || this.red.has(id),
      queue: this.bfsQueue,
      seedRef,
      centerOf: (id) => byAdcode.get(id)?.center ?? seedRef,
      // 邻接优先的参考点：注意即使 lastAnswered 已被换范围切出本池，neighborsOf(lastId)
      // 仍能给出邻接关系（这正是「队列里有它的邻居就优先」需要的语义），bfsStep 只在队列里挑。
      lastId: this.lastAnswered,
    });
    this.bfsQueue = step.queue;
    const u = step.next ? byAdcode.get(step.next) : undefined;
    return u ?? pool[0];
  }

  private pickNext(pool: Unit[]): Unit {
    // 世界全国：在**当前范围**的国家邻接图上 BFS。
    // 注意 last/邻居都从 pool 取（不能从 worldPool 取）——否则下钻到某洲后
    // 会顺着邻接关系把别的洲的国家当成下一题，出现「出题国家在地图上没显示」。
    if (this.isWorldNation()) {
      const last = this.lastGreen ? pool.find((u) => u.adcode === this.lastGreen) ?? null : null;
      return this.bfsNext('world', pool, last?.center ?? [10, 25]);
    }
    // 省级全国：省-省邻接图上 BFS
    if (this.isProvinceNation()) {
      const last = this.lastGreen ? pool.find((u) => u.adcode === this.lastGreen) ?? null : null;
      return this.bfsNext('province', pool, last?.center ?? [104.5, 35]);
    }
    // 市级：保留「一个省练完再换省」的既有手感，省内在市-市邻接图上 BFS
    const last = this.lastGreen ? this.ctx.byAdcode.get(this.lastGreen) ?? null : null;
    if (!this.activeProvince || (!this.scopeProvince && !this.hasUnvisitedInProvince(this.activeProvince))) {
      this.activeProvince = this.pickNextProvince(last);
    }
    const province = this.activeProvince;
    const inProvince = this.unvisited().filter((u) => u.provinceAdcode === province);
    if (!inProvince.length) return this.unvisited()[0];
    const ref =
      last?.provinceAdcode === province
        ? last.center
        : this.ctx.data.provinces.find((p) => p.adcode === province)?.center ?? [104.5, 35];
    return this.bfsNext('city:' + province, inProvince, ref);
  }

  private hasUnvisitedInProvince(provinceAdcode: string) {
    return this.ctx.data.units.some((u) => u.provinceAdcode === provinceAdcode && !this.green.has(u.adcode) && !this.red.has(u.adcode));
  }

  private pickNextProvince(last: Unit | null): string {
    const provinces = this.ctx.data.provinces
      .filter((p) => this.hasUnvisitedInProvince(p.adcode))
      .sort((a, b) => dist2(a.center, last?.center ?? [104.5, 35]) - dist2(b.center, last?.center ?? [104.5, 35]));
    return provinces[0]?.adcode ?? this.unvisited()[0]?.provinceAdcode ?? '';
  }

  /**
   * 验收探针的**顺序出题状态视图**（见 `quizDiagnostics.ts` 的说明）。
   *
   * BFS 前沿队列是本类独有状态，基类的 `diagnostics()` 已由基类实现，故另开一个入口
   * （比用原型链把两个视图拼在一起更好读）。方法体在类内部，成员改名会让 `tsc` 报错。
   */
  orderDiagnostics(): QuizOrderDiagnostics {
    const self = this;
    return {
      get lastGreen() { return self.lastGreen; },
      set lastGreen(v: string | null) { self.lastGreen = v; },
      get lastAnswered() { return self.lastAnswered; },
      set lastAnswered(v: string | null) { self.lastAnswered = v; },
      get bfsQueue() { return self.bfsQueue; },
      set bfsQueue(v: string[]) { self.bfsQueue = v; },
      get bfsDomain() { return self.bfsDomain; },
      set bfsDomain(v: string) { self.bfsDomain = v; },
    };
  }
}

function dist2(a: [number, number], b: [number, number]): number {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
}