import type { Mode, Unit } from '../types';
import type { ModeCtx, OrderMode } from './types';
import { t } from '../i18n';
import { normalizeProvince } from '../matcher';
import { formatElapsedSeconds } from '../ui/format';
import { pickWrongNext } from './wrongOrder';
import {
  loadSelfAutoFollow,
  loadSelfErrorRollback,
  loadSelfRequireEnter,
  SELF_FOLLOW_ZOOM,
  saveSelfAutoFollow,
  saveSelfErrorRollback,
  saveSelfRequireEnter,
  type ModeSettingsPanel,
} from '../modeSettings';
import { canDrillProvince, drillTargetOfUnit, isProvinceAbbrInput } from '../province';
import { MapQuizMode } from './mapQuizMode';
import type { QuizOrderDiagnostics } from './quizDiagnostics';
import { bfsStep } from './bfsOrder';
import { WorldMatcher } from '../worldNames';
import { showStartCard } from '../ui/dom';

/**
 * 输入模式（BFS 扩张）：
 * - 市级（全国/单省）：随机起点作为当前题目（蓝色）→ 输入名称；答对变绿，下一个题目 = 与上一个绿点相邻的单位（优先同省）；
 *   无相邻候选时回退最近的未测单位（岛屿等）；答错保持红色（错误标记）并继续扩张。
 * - 省级（全国）：出题池为 34 个省级单元，BFS 在省-省邻接上扩张；省级答题只计入省级熟练度。
 * - 世界（全国）：出题池为 195 个国家单元，BFS 在国家-国家邻接上扩张；国家答题只计入国家熟练度。
 */
export class InputMode extends MapQuizMode {
  readonly id: Mode = 'self';
  readonly title = t('mode.self.title');
  private lastGreen: string | null = null;
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
      title: t('mode.self.title'),
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

  onSubmit(v: string) {
    if (this.paused || this.rollbacking || !this.question || !v.trim()) return;
    const best = this.matchInput(v);
    this.answer(!!best && best === this.question, true);
  }

  onInput(v: string) {
    if (this.paused || this.rollbacking || !this.question || !v.trim()) return;
    const best = this.matchInput(v);
    if (best === this.question) this.answer(true, true);
  }

  /**
   * 输入匹配：省级全国 → 精确省名匹配（简称档只认简称）；世界全国 → 国家名匹配（国名档走 `bestMatch`，
   * 首都档走「是不是这一题的首都名」，见 `WorldMatcher.acceptsCapital` 的同形异国说明）；
   * 市级 → 地级单位匹配。
   */
  private matchInput(v: string): string | null {
    if (this.isProvinceNation()) {
      // 简称档：只认单字简称（含 蜀/黔/滇/秦/陇 等别名），不认省名 —— 见 province.isProvinceAbbrInput
      if (this.naming.province === 'abbr') {
        return this.provincePool.find((p) => isProvinceAbbrInput(this.ctx.data, p.adcode, v))?.adcode ?? null;
      }
      const ni = normalizeProvince(v);
      if (!ni) return null;
      for (const p of this.provincePool) {
        if (normalizeProvince(p.name) === ni || normalizeProvince(p.shortName) === ni) return p.adcode;
      }
      return null;
    }
    if (this.isWorldNation()) {
      if (this.naming.world === 'capital') return this.worldMatcher.acceptsCapital(this.question ?? '', v) ? this.question : null;
      return this.worldMatcher.bestMatch(v);
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
    // 省级全国保持全国视野不聚焦；世界全国与世界市级都按面积决定缩放（越小的国家放得越大）；
    // 其余（中国地级）用固定的 SELF_FOLLOW_ZOOM。
    if (this.autoFollow) {
      if (this.isWorldNation()) this.ctx.renderer.focusWorldCountry(u.adcode);
      else if (!this.isProvinceNation()) this.ctx.renderer.focusUnit(u.adcode, SELF_FOLLOW_ZOOM);
    }
    this.ctx.search.clear();
    this.ctx.search.focus();
    this.persist();
    this.ctx.showTimer(null);
  }

  nextUnit(pool: Unit[]): Unit {
    if (this.orderMode === 'random') return this.ctx.randomUnit(pool);
    if (this.orderMode === 'wrong') return pickWrongNext(pool, this.scoreOf, this.wrongOrder, this.ctx.toast);
    return this.pickNext(pool);
  }

  showStartHint() {
    showStartCard({
      id: 'self-start',
      title: t('self.startTitle'),
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
   * 世界档四种组合、省级档两种；地级沿用历史提示。
   */
  private placeholderForNaming(): string {
    if (this.isProvinceNation()) {
      return this.naming.province === 'abbr' ? t('self.abbrPlaceholder') : t('self.provincePlaceholder');
    }
    if (this.isWorldNation()) {
      const capital = this.naming.world === 'capital';
      const en = this.naming.lang === 'en';
      if (capital) return en ? t('self.capitalEnPlaceholder') : t('self.capitalPlaceholder');
      return en ? t('self.worldEnPlaceholder') : t('self.worldPlaceholder');
    }
    return t('self.placeholder');
  }

  /** 口径切换后占位提示要立刻反映新口径（暂停中保持「输入地名」，与切模式一致）。 */
  protected onNamingChanged() {
    if (!this.paused) this.ctx.search.setPlaceholder(this.placeholderForNaming());
  }

  protected resetSessionSpecific() {
    this.lastGreen = null;
    this.activeProvince = this.scopeProvince;
    this.bfsQueue = [];
    this.bfsDomain = '';
  }

  protected onEntered() { this.ctx.search.clear(); }
  protected onScopeChanged() { this.activeProvince = this.scopeProvince; this.bfsQueue = []; this.bfsDomain = ''; }
  protected onDrill(provinceAdcode: string) { this.activeProvince = provinceAdcode; this.bfsQueue = []; this.bfsDomain = ''; }
  protected onAnswerStart() { this.ctx.showTimer(null); }
  protected onCorrect(q: string) { this.lastGreen = q; }
  protected onRollbackRestored() { this.ctx.search.clear(); this.ctx.search.focus(); }
  protected onPause() { this.ctx.showTimer(null); }
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
      activeProvince: this.activeProvince,
      wrongToastShown: this.wrongOrder.toastShown,
      // BFS 队列一并持久化：刷新后继续按同一顺序出题，而不是重新播种
      bfsQueue: this.bfsQueue,
      bfsDomain: this.bfsDomain,
    };
  }
  protected restoreSessionSpecific(record: Record<string, unknown>) {
    this.lastGreen = typeof record.lastGreen === 'string' && this.green.has(record.lastGreen) ? record.lastGreen : null;
    this.activeProvince = typeof record.activeProvince === 'string' ? record.activeProvince : this.scopeProvince;
    // 旧存档没有这两个字段 → 空队列，bfsNext 会按 lastGreen 重新播种，不会出错
    this.bfsQueue = Array.isArray(record.bfsQueue) ? record.bfsQueue.filter((x): x is string => typeof x === 'string') : [];
    this.bfsDomain = typeof record.bfsDomain === 'string' ? record.bfsDomain : '';
  }

  // ==================== 输入特有：BFS 顺序出题 ====================

  /**
   * 顺序模式出题：**严格广度优先**（实现与「不可能出现空洞」的论证见 bfsOrder.ts）。
   *
   * 这里只负责按分支选定「池」与「BFS 域」，真正的排队逻辑在纯函数 bfsStep 里
   * （抽出去是为了让那条性质可被单测断言）。
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