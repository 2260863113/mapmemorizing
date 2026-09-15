import type { Mode, Unit } from '../types';
import type { ModeCtx, OrderMode } from './types';
import { t } from '../i18n';
import { formatElapsedSeconds } from '../ui/format';
import { pickWrongNext, type WrongOrderState } from './wrongOrder';
import { loadClickErrorRollback, saveClickErrorRollback, type ModeSettingsPanel } from '../modeSettings';
import { canDrillProvince, drillTargetOfUnit } from '../province';
import { MapQuizMode } from './mapQuizMode';
import { modeTitle } from './capabilities';
import { showStartCard } from '../ui/dom';
import { escapeAttr } from '../ui/html';

/**
 * 点击模式：根据顶部题目提示，在地图上点击对应的地图单位。
 * - 市级粒度（默认不再默认）：全国地级市 / 单省地级市练习（原版）。
 * - 省级粒度：全国 34 个省级单元的练习（地图为省级视图，不含地级边界/标签），
 *   省级答题只计入省级熟练度（与地级熟练度隔离）。
 * - 粒度选择：仅全国视图（scopeProvince=null）可切换；测试开始后锁定隐藏。
 */
/**
 * 国旗档要预取的"接下来几道题"（用户口径 2026-09：只缓存接下来两个国旗）。
 * 进缓存的图 = 当前题 + 接下来这道 + 再下一道 = 3 张，与 `flagPreload` 的 3 并发正好对上。
 */
const FLAG_LOOKAHEAD = 2;

export class ClickMode extends MapQuizMode {
  readonly id: Mode = 'click';
  readonly title = modeTitle('click');

  constructor(ctx: ModeCtx) {
    super(ctx);
  }

  // ==================== 差异点实现 ====================

  protected storagePrefix() { return 'click'; }
  protected defaultOrderMode(): OrderMode { return 'random'; }
  protected parseOrderMode(raw: string | null): OrderMode {
    return raw === 'wrong' ? 'wrong' : 'random';
  }
  protected loadErrorRollback() { return loadClickErrorRollback(); }
  protected saveErrorRollback(v: boolean) { saveClickErrorRollback(v); }
  protected wrongToast(name: string, _timedOut: boolean) {
    return t('click.correctAnswer', { name });
  }
  protected summaryHtml(elapsedMs: number) {
    let stat: string;
    if (this.isProvinceNation()) {
      stat = t('click.summaryProvince', { ok: this.ok, fail: this.fail, time: formatElapsedSeconds(elapsedMs), total: this.ok + this.fail });
    } else if (this.isWorldNation()) {
      stat = t('click.summaryWorld', { ok: this.ok, fail: this.fail, time: formatElapsedSeconds(elapsedMs), total: this.ok + this.fail });
    } else {
      stat = t('click.summary', { ok: this.ok, fail: this.fail, time: formatElapsedSeconds(elapsedMs), total: this.ok + this.fail });
    }
    return t('click.complete') + '<div class="sum-stats">' + stat + '</div>';
  }

  // ==================== 点击特有：设置 / 判题 ====================

  getModeSettings(): ModeSettingsPanel | null {
    return {
      title: modeTitle('click'),
      toggles: [{ key: 'error-rollback', label: t('settings.errorRollback'), value: this.errorRollback }],
      onChange: (key, value) => {
        if (key === 'error-rollback') {
          this.errorRollback = value;
          saveClickErrorRollback(value);
        }
      },
    };
  }

  onSubmit() {}
  onInput() {}

  onUnitClick(adcode: string) {
    if (this.paused || this.rollbacking) return true;
    // 世界粒度：未开始点击国家 → 逐层下钻（世界→大洲→次区域）；已开始 → 直接判题（国家为最小单元）
    if (this.isWorldNation()) {
      if (!this.started || !this.question) {
        const c = this.ctx.data.countries.find((x) => x.iso === adcode);
        if (c) this.drillFromWorldNation(c.continent, c.iso);
        return true;
      }
      this.answer(adcode === this.question, true);
      return true;
    }
    // 省级全国：未开始时单击某省 → 下钻该省（变成该省地级市级练习；返回全国后回省级全国）
    if (this.isProvinceNation() && !this.started) {
      this.drillFromProvinceNation(adcode);
      return true;
    }
    if (!this.started || !this.question) {
      // 市级全国未开始时点地级市：renderer 会自动下钻到它的省 —— 但唯一层级的
      // 京津沪渝/港澳台没有下级单位，必须拦在这里（用户口径：一律不下钻）
      if (!canDrillProvince(drillTargetOfUnit(this.ctx.data, adcode))) {
        this.ctx.toast(t('common.noDrillSingleUnit'));
        return true;
      }
      return false;
    }
    // 省级单省视图点击（scope 省，地级单位）与市级全国：按地图单位命中判断
    const clicked = this.ctx.byAdcode.get(adcode);
    if (clicked && this.scopeProvince !== null && clicked.provinceAdcode !== this.scopeProvince) return true;
    this.answer(adcode === this.question, true);
    return true;
  }

  // ==================== 出题 ====================

  ask(unit: Unit) {
    this.question = unit.adcode;
    this.showQuestionHint(unit);
    this.refresh();
    this.persist();
  }

  nextUnit(pool: Unit[]): Unit {
    if (!this.needsLookahead()) {
      this.lookahead = []; // 非国旗档不留预选（它只为预取国旗而存在）
      return this.pickNextOf(pool);
    }
    // 消费预选：仍要确认它还在池内（换池/重置会清空预选，这里再兜一层保险）——
    // 不在就当场重选，最坏情况只是那一题的国旗等一次网络，不会出错的题。
    const planned = this.lookahead.find((u) => pool.some((p) => p.adcode === u.adcode));
    const u = planned ?? this.pickNextOf(pool);
    this.lookahead = this.planAhead(pool, u, FLAG_LOOKAHEAD);
    return u;
  }

  // ==================== 国旗档的预选（"只缓存接下来两个"的前提） ====================

  /**
   * 已经定下来的后续题（队首 = 下一题，最多 `FLAG_LOOKAHEAD` 道）。
   *
   * ## 为什么需要预选
   * 用户口径（2026-09）：「不一次性全量缓存，仅仅缓存接下来两个国旗」。而点击模式的下一题是**答对那一刻**
   * 才随机/按分数选出来的，不提前定下来就无从知道该缓存哪两面 —— 只有两条路：全量缓存（上一版做法，
   * 世界全国 194 面 1.21MB）或每题等一次网络（这就是用户看到的"每换一题等约 0.5 秒"）。
   * 于是把选题**提前一步**：出一道题的同时把后面两道定下来，于是哪两面要预取变成确定的事。
   *
   * ## 预选与"届时真选"是否一致（这是本机制的正确性前提）
   * · 「错题」顺序：`pickWrongNext` 取池内熟练度分最低者；而**分数只在单位被作答时改变，被作答就离开池子**，
   *   故剩余池内各单位的相对顺序在预选与消费之间不可能变 → 预选结果与届时重选**逐字相同**（等价性可证）。
   * · 「随机」顺序：池子相同、均匀抽取 → 分布相同，只是抽签提前了一次。
   * · 预演绝无副作用：`pickWrongNext` 唯一的副作用是弹"错题已出完"提示，故预演传**状态副本 + 空提示函数**。
   * · 消费时按 adcode **重新校验是否还在池内**，不在则当场重选（见 `nextUnit`）。
   *
   * ## 为什么"保留旧预选"而不是每题重新抽签
   * 新计划先把仍然有效的旧预选原样留下、再补足到两道。否则每题都把下一题的抽签重来一次，
   * 上一次预取的那张图就白取了（缓存命中率归零，等于每题多请求一张）——"接下来两面确定、必然命中"也就没了。
   */
  private lookahead: Unit[] = [];

  /** 只有「世界全国 + 国旗」档需要预选：其它口径的题面根本不加载图片。 */
  private needsLookahead(): boolean {
    return this.isWorldNation() && this.naming.world === 'flag';
  }

  /**
   * 选下一题（真实路径）。
   * `state` / `toast` 可注入是为了让 `planAhead` 复用同一份选择逻辑做**无副作用预演**。
   */
  private pickNextOf(pool: Unit[], state: WrongOrderState = this.wrongOrder, toast = this.ctx.toast): Unit {
    if (this.orderMode === 'wrong') return pickWrongNext(pool, this.scoreOf, state, toast);
    return this.ctx.randomUnit(pool);
  }

  /** 预演后续出题：在 `pool` 上选出 `count` 道题（`start` 是已确定的当前题，从池里剔除）。 */
  private planAhead(pool: Unit[], start: Unit | null, count: number): Unit[] {
    const rest = pool.filter((u) => u.adcode !== start?.adcode);
    const out: Unit[] = [];
    // 先原样保留仍然有效的旧预选（见类内说明：不然每题重新抽签会白取图）
    for (const u of this.lookahead) {
      if (out.length >= count) break;
      const at = rest.findIndex((p) => p.adcode === u.adcode);
      if (at < 0) continue;
      out.push(u);
      rest.splice(at, 1);
    }
    const state: WrongOrderState = { ...this.wrongOrder }; // 副本：预演不许把"已提示过"写进真实状态
    while (out.length < count && rest.length > 0) {
      const u = this.pickNextOf(rest, state, () => {}); // 空 toast：预演绝不弹提示
      const at = rest.findIndex((p) => p.adcode === u.adcode);
      if (at < 0) break; // 理论上不会发生（randomUnit/pickWrongNext 都从池内取）；防死循环
      out.push(u);
      rest.splice(at, 1);
    }
    return out;
  }

  /** 已确定的后续题（供基类排预取队列 = 当前 + 接下来两道）。 */
  protected flagLookaheadIds(): string[] {
    return this.lookahead.map((u) => u.adcode);
  }

  /** 新会话/换池：旧池的预选不能拿到新池里用。 */
  protected resetSessionSpecific() {
    this.lookahead = [];
  }

  /** 首题就要把"接下来两道"定下来 —— 否则第二题仍要等一次网络（首题之后才开始规划）。 */
  protected onStarted(first: Unit) {
    if (this.needsLookahead()) this.lookahead = this.planAhead(this.unvisited(), first, FLAG_LOOKAHEAD);
  }

  showStartHint() {
    showStartCard({
      id: 'click-start',
      title: modeTitle('click'),
      subtitle: t('click.startSubtitle', { scope: this.scopeLabel() }),
      onStart: () => this.start(false),
    });
  }

  refresh() {
    this.ctx.renderer.render({
      colorOf: (adcode) => {
        if (this.green.has(adcode)) return 'green';
        if (this.red.has(adcode)) return 'red';
        return 'gray';
      },
      disableTooltip: true,
      // 未开始（浏览态）：显示全量地名；开始后清空，只留已作答的绿/红（见 browseLabels.ts）
      ...this.browseLabelState(),
      // 省名标签 / 国名标签：与输入模式共用基类实现（原先两个子类各抄了一份）
      provinceLabel: this.provinceLabelOf(),
      worldLabel: this.worldLabelOf(),
    });
  }

  // ==================== 点击特有：钩子覆写 ====================

  protected onResume() {
    const unit = this.currentUnitOf(this.question);
    if (unit) this.showQuestionHint(unit);
    this.ctx.showStopwatch(this.stopwatch.elapsedMs());
  }
  protected onResetHook() { this.ctx.showStopwatch(null); }
  protected onCorrect(_q: string) { this.ctx.toast(t('click.correctToast')); }

  private showQuestionHint(unit: Unit) {
    // 题面用图片的那一档（世界档「国旗」）：给一张国旗图，用户点地图上对应的国家。
    // alt 必须为空 —— 写国名就等于把答案写在题面上；没有国旗资源时回落到国名题面。
    // 「哪一档的题面是图片」由口径注册表说话（`questionImage`），这里不认识"国旗"这个词。
    if (this.isWorldNation()) {
      const src = this.worldFlagSrc(unit.adcode);
      if (src) {
        this.ctx.setHint(
          '<div class="start-panel click-question flag-question"><img src="' + escapeAttr(src) + '" alt="" draggable="false" /></div>',
        );
        return;
      }
    }
    // 省级全国测验：顶部显示省全名 / 省会名 / 单字简称；世界全国测验：显示 国名/首都名 的 中/英文
    // （点击模式不在地图上高亮目标）。文本一律由基类的 displayNameOf 统一给出，避免与标签口径分叉。
    this.ctx.setHint('<div class="start-panel click-question"><div class="start-title">' + this.displayNameOf(unit) + '</div></div>');
  }
}