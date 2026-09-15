/**
 * 拼图模式（puzzle，2026-09 新增，见 CONTEXT.md「拼图模式」与 docs/adr/0006）。
 *
 * **两个阶段**（用户口径）：
 *   1. **选范围（有地图）**：进模式时屏幕上仍是完整地图（按当前粒度渲染，简单档带名称标签）。
 *      顶部「世界/省级/市级」切粒度；世界档另有「全世界/各大洲」与次区域两行。
 *      点地图上的单位**下钻**（省级/市级 → 该省地级市；世界 → 大洲 → 次区域），点空白**退回上一层**。
 *      这一阶段出「开始」卡片，副标题写明当前范围。
 *   2. **拼图（无地图）**：点「开始」后地图隐藏、画布清空，只放当前范围的碎片；拖出即 1:1 真值
 *      大小、可放任意位置；**松手时**相邻两片若接近其真值相对位置（≤15px）就精确对齐并为组，
 *      此后整组一起拖；全部碎片吸成一整块即获胜。结束后难度按钮重新出现，「重置」回到开始卡片。
 *
 * 范围口径与点击/输入模式**共用同一套哨兵**（`PROVINCE_NATION_SCOPE` / `WORLD_NATION_SCOPE` /
 * 大洲哨兵 / 次区域哨兵 / 省 adcode），于是大洲与次区域两行分段按钮、`isNationLikeScope` 等
 * 现成逻辑直接可用。
 *
 * 不提交排行榜（服务端白名单仍是 self/click/endless）；难度（简单/困难）只影响是否显示名称，
 * 运行中收起且不允许切换。
 */
import type { AppData, Continent, Mode, RoundResult, SubregionId } from '../types';
import { CONTINENTS } from '../types';
import type { ModeCtx } from './types';
import { BaseMode } from './baseMode';
import { t } from '../i18n';
import { modeTitle } from './capabilities';
import {
  buildProvinceAdjacency,
  canDrillProvince,
  continentFromScope,
  continentScope,
  drillTargetOfUnit,
  provinceShortName,
  PROVINCE_NATION_SCOPE,
  subregionFromScope,
  subregionScope,
  WORLD_NATION_SCOPE,
  type Granularity,
} from '../province';
import { hasSubregions } from '../subregions';
import { MAP_THEMES } from '../map/theme';
import { buildPieces, countScopePieces, familyOf, type PuzzlePieceDef, type PuzzleScope } from '../puzzle/pieces';
import { buildPuzzleAdjacency } from '../puzzle/adjacency';
import { PuzzleState, SNAP_TOLERANCE_PX, type DropResult } from '../puzzle/state';
import { PuzzleView, type PuzzleThemeColors } from '../puzzle/view';
import { project, unitScale, type PuzzleFamily } from '../puzzle/projection';
import { loadPuzzleDifficulty, savePuzzleDifficulty, type ModeSettingsPanel } from '../modeSettings';
import { loadStoredGranularity, saveStoredGranularity } from './granularityStore';
import { puzzleStatus, setHint, showStartCard, toast } from '../ui/dom';

/** 难度：简单 = 显示名称；困难 = 不显示（用户口径：难度只管标签，且运行中锁定）。 */
export type PuzzleDifficulty = 'easy' | 'hard';

/** 拼图阶段：scope = 选范围（显示地图）；board = 拼图盘面（隐藏地图）。 */
export type PuzzlePhase = 'scope' | 'board';

/** 计时刷新间隔（毫秒）。 */
const TICK_MS = 200;

/**
 * 拼图排行榜：**只有这两个范围可提交**（用户口径）——
 * 世界全国（194 国）与市级全国（340 个地级单位）。其余范围（省级全国、大洲、次区域、下钻某省）
 * 中途退出不弹结算、也不进榜。
 */
export function isPuzzleLeaderboardScope(scope: string | null): boolean {
  return scope === null || scope === WORLD_NATION_SCOPE;
}

/**
 * 提交门槛：**至少吸附过一片**才算成绩（用户口径）。
 *
 * 「已拼」起始就是 1（口径：1 + 吸附次数），所以「已拼 ≥ 2」= 至少发生过一次吸附；
 * 否则开局立刻退出也能提交一条「已拼 1/340」的垃圾成绩。
 */
export const PUZZLE_MIN_SUBMIT = 2;

/** 毫秒 → mm:ss。 */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

export class PuzzleMode extends BaseMode {
  id: Mode = 'puzzle';
  title = modeTitle('puzzle');

  private pieces: PuzzlePieceDef[] = [];
  private state: PuzzleState | null = null;
  private view: PuzzleView | null = null;
  /** 视图绑定的 state 实例：范围/开局会新建 state，视图必须跟着重建。 */
  private viewState: PuzzleState | null = null;
  private difficulty: PuzzleDifficulty = loadPuzzleDifficulty();

  private granularity: Granularity = this.loadGranularity();
  /**
   * 当前范围哨兵（与点击模式同一套编码）：
   * 省级档 = `PROVINCE_NATION_SCOPE`；世界档 = 世界/大洲/次区域哨兵；
   * 市级档 = null（全国）或省 adcode（下钻该省的地级市）。
   */
  private scope: string | null = PROVINCE_NATION_SCOPE;

  /** 一局进行中（开始 → 获胜/重置）。 */
  private started = false;
  /** 已获胜（盘面保留在屏幕上，直到「重置」或再来一局）。 */
  private finished = false;
  private paused = false;
  private entered = false;

  private elapsedMs = 0;
  private runStart = 0;
  private tickTimer: number | null = null;
  private provinceAdjacencyCache: Map<string, string[]> | null = null;

  constructor(private ctx: ModeCtx) {
    super();
  }

  // ==================== 粒度与范围 ====================

  private loadGranularity(): Granularity {
    return loadStoredGranularity('puzzle', 'province'); // 首访默认省级
  }

  private persistGranularity() {
    saveStoredGranularity('puzzle', this.granularity);
  }

  getGranularity(): Granularity {
    return this.granularity;
  }

  /**
   * 切粒度：回到该粒度的全国范围（运行中不允许——此时按钮已收起）。
   *
   * 已经在该粒度上时**也有效**：若当前停在某个下钻范围（如市级档下的某省），点同级按钮 = 回到全国，
   * 于是粒度行本身就是"退出下钻"的出口（否则用户会以为按钮坏了）。
   */
  setGranularity(g: Granularity) {
    if (this.boardPhase()) return;
    const nation = this.nationScopeFor(g);
    const changed = this.granularity !== g;
    if (!changed && this.scope === nation) return; // 已经是"该粒度的全国"，无事可做
    this.granularity = g;
    this.persistGranularity();
    this.scope = nation;
    this.enter();
  }

  private nationScopeFor(g: Granularity): string | null {
    if (g === 'world') return WORLD_NATION_SCOPE;
    if (g === 'province') return PROVINCE_NATION_SCOPE;
    return null; // 市级全国
  }

  getScopeProvince(): string | null {
    return this.scope;
  }

  /**
   * 世界档的洲范围（供「全世界/各大洲」行高亮）。次区域哨兵里不含大洲，需反查一次——
   * 否则选中次区域后洲行会掉高亮，且 `setWorldMode(continent=null, subregion)` 会被渲染器
   * 当成"没有大洲"而忽略次区域（地图退回全世界，空白返回也失效）。
   */
  getWorldContinent(): Continent | null {
    const cont = continentFromScope(this.scope);
    if (cont) return cont;
    const sub = subregionFromScope(this.scope);
    return sub ? this.continentOfSubregion(sub) : null;
  }

  /** 世界档的次区域范围（供次区域行高亮）。 */
  getWorldSubregion(): SubregionId | null {
    return subregionFromScope(this.scope);
  }

  setWorldContinent(c: Continent | null) {
    if (this.boardPhase() || this.granularity !== 'world') return;
    this.scope = c ? continentScope(c) : WORLD_NATION_SCOPE;
    this.enter();
  }

  setWorldSubregion(s: SubregionId | null) {
    if (this.boardPhase() || this.granularity !== 'world') return;
    const continent = this.getWorldContinent();
    if (!continent) return;
    this.scope = s ? subregionScope(s) : continentScope(continent);
    this.enter();
  }

  isProvinceNation(): boolean {
    return this.granularity === 'province' && this.scope === PROVINCE_NATION_SCOPE;
  }

  isWorldNation(): boolean {
    return this.granularity === 'world' && this.scope === WORLD_NATION_SCOPE;
  }

  /** 当前范围的可读名（开始卡片副标题用）：带上片数与单位口径，让人一眼看清要拼什么。 */
  scopeLabel(): string {
    const count = countScopePieces(this.ctx.data, this.puzzleScope());
    if (this.granularity === 'world') {
      const sub = subregionFromScope(this.scope);
      if (sub) {
        const name = this.ctx.data.subregions.find((x) => x.id === sub)?.name ?? t('common.world');
        return t('puzzle.scopeSubregion', { name, count });
      }
      const cont = continentFromScope(this.scope);
      if (cont) {
        const name = CONTINENTS.find((c) => c.id === cont)?.name ?? t('common.world');
        return t('puzzle.scopeContinent', { name, count });
      }
      return t('puzzle.scopeWorld', { count });
    }
    if (this.granularity === 'province') return t('puzzle.scopeProvinceNation');
    if (this.scope) return t('puzzle.scopeCityOf', { name: provinceShortName(this.ctx.data, this.scope), count });
    return t('puzzle.scopeCityNation', { count });
  }

  /** 哨兵 → 碎片构建用的范围描述。 */
  private puzzleScope(): PuzzleScope {
    return {
      granularity: this.granularity,
      family: this.family(),
      province: this.granularity === 'city' && this.scope ? this.scope : undefined,
      continent: this.granularity === 'world' ? (this.getWorldContinent() ?? undefined) : undefined,
      subregion: this.granularity === 'world' ? (this.getWorldSubregion() ?? undefined) : undefined,
    };
  }

  private family(): PuzzleFamily {
    return familyOf(this.granularity);
  }

  // ==================== 地图下钻（选范围阶段） ====================

  /**
   * 点地图上的单位 = **收窄范围**（世界：国家→大洲→次区域；中国侧：省级档点省 / 市级档点地级单位 → 该省地级市）。
   *
   * 三条边界（用户口径）：① 唯一层级的京津沪渝/港澳台不下钻（只有 1 片，没有意义）；
   * ② 大洋洲不再细分次区域（`hasSubregions` 已按 `NO_SUBREGION_DRILL` 关闭）；
   * ③ **市级档点地级单位必须真的收窄到它所属的省** —— 否则 renderer 的兜底下钻只动了地图视图，
   * 拼图范围仍是「全国 340 个」（用户报的缺陷：看起来下钻了，范围没变）。
   */
  onUnitClick(adcode: string): boolean {
    if (this.boardPhase()) return false;
    if (this.granularity === 'world') {
      const country = this.ctx.data.countries.find((c) => c.iso === adcode);
      if (!country) return false;
      if (this.getWorldContinent() !== country.continent) {
        this.scope = continentScope(country.continent);
        this.enter();
        return true;
      }
      if (!hasSubregions(this.ctx.data, country.continent)) return true; // 该洲不细分，点击不再下钻
      const sr = this.ctx.data.isoSubregion[adcode];
      if (sr && this.getWorldSubregion() !== sr) {
        this.scope = subregionScope(sr);
        this.enter();
        return true;
      }
      return false;
    }
    // 中国侧：省级档点的是省（粒度切到市级），市级档点的是地级单位（收窄到它所属的省）
    const target = this.granularity === 'province' ? adcode : drillTargetOfUnit(this.ctx.data, adcode);
    if (!canDrillProvince(target)) {
      this.ctx.toast(t('common.noDrillSingleUnit'));
      return true;
    }
    if (!this.ctx.data.provinces.some((p) => p.adcode === target)) return false;
    if (this.scope === target) return true; // 已在该省，不重复下钻
    this.granularity = 'city';
    this.persistGranularity();
    this.scope = target;
    this.enter();
    return true;
  }

  /**
   * 点空白 = 退回上一层（世界：次区域→大洲→世界；下钻某省→市级全国）。
   *
   * 顺带兜底**视图与范围不同步**的情况：若地图被别处下钻了（`renderer.currentProvince()`）而本模式的范围
   * 还是全国，也一并 `enter()` 把地图退回全国 —— 否则空白点击会像"没反应"。
   */
  onBackToNation() {
    if (this.boardPhase()) return; // 盘面阶段地图已隐藏，这里只是防御
    if (this.granularity === 'world') {
      const sub = subregionFromScope(this.scope);
      if (sub) {
        const cont = this.continentOfSubregion(sub);
        this.scope = cont ? continentScope(cont) : WORLD_NATION_SCOPE;
        this.enter();
        return;
      }
      if (continentFromScope(this.scope)) {
        this.scope = WORLD_NATION_SCOPE;
        this.enter();
      }
      return;
    }
    if (this.granularity === 'city') {
      if (this.scope || this.ctx.renderer.currentProvince()) {
        this.scope = null;
        this.enter(); // 市级全国范围：地图一并退回全国（renderScopeMap 会清掉下钻省）
      }
    }
  }

  private continentOfSubregion(sub: SubregionId): Continent | null {
    return this.ctx.data.subregions.find((s) => s.id === sub)?.continent ?? null;
  }

  // ==================== 生命周期 ====================

  /** 盘面阶段 = 一局进行中或已获胜（此时地图隐藏、画布显示）。 */
  private boardPhase(): boolean {
    return this.started || this.finished;
  }

  puzzlePhase(): PuzzlePhase {
    return this.boardPhase() ? 'board' : 'scope';
  }

  enter() {
    this.entered = true;
    if (!this.boardPhase()) {
      // 选范围阶段：拆掉画布、丢弃上一局状态、显示地图与开始卡片
      this.teardownView();
      this.state = null;
      this.pieces = [];
      this.renderScopeMap();
      this.renderStartCard();
      puzzleStatus('');
      this.ctx.syncChrome?.();
      return;
    }
    this.ensureState();
    this.showBoard(false);
    setHint('');
    if (!this.paused) this.startTimer();
    this.ctx.syncChrome?.();
  }

  exit() {
    this.entered = false;
    this.clearTick();
    this.ctx.renderer.setProvinceMode(false, { inset: false });
  }

  /** 选范围阶段的地图：灰面 + 名称标签（困难档隐藏名称），省级全国带港澳放大框。 */
  private renderScopeMap() {
    const hideLabels = this.difficulty === 'hard';
    if (this.granularity === 'world') {
      this.ctx.renderer.setWorldMode(true, this.getWorldContinent(), this.getWorldSubregion());
      this.ctx.renderer.render({
        colorOf: () => 'gray',
        hideLabels,
        worldShowAllLabels: !hideLabels,
        worldLabelZoomThreshold: 0,
        disableTooltip: true,
      });
      return;
    }
    if (this.granularity === 'province') {
      this.ctx.renderer.setProvinceMode(true, { inset: true, allowDrill: false });
      this.ctx.renderer.render({
        colorOf: () => 'gray',
        hideLabels,
        showAllProvinceLabels: !hideLabels,
        disableTooltip: true,
      });
      return;
    }
    this.ctx.renderer.setProvinceMode(false, { inset: false });
    if (this.scope) this.ctx.renderer.drillToProvince(this.scope);
    // ⚠ 必须显式回全国：市级视图里 `setProvinceMode(false)` 会**提前 return**（已经是这个状态），
    // 于是 renderer 里残留的下钻省不会被清掉 —— 范围已经是"全国 340"，地图却还锁在某个省上。
    // 加 `currentProvince()` 判断是**防重入**：backToNation 会触发 onViewChange → 模式 refresh() →
    // 又回到这里，只有第一次（下钻省确实存在时）才需要真的退，之后立刻变成 no-op。
    else if (this.ctx.renderer.currentProvince()) this.ctx.renderer.backToNation();
    this.ctx.renderer.render({
      colorOf: () => 'gray',
      hideLabels,
      showAllLabels: !hideLabels,
      labelZoomThreshold: 0,
      disableTooltip: true,
    });
  }

  refresh() {
    if (!this.entered) return;
    if (!this.boardPhase()) {
      this.renderScopeMap();
      return;
    }
    this.view?.refreshScale();
    this.view?.refreshStyle();
    this.view?.setEnabled(this.started && !this.paused);
    this.renderStatus();
  }

  hasProgress() {
    return false;
  }

  // ==================== 开始 / 暂停 / 重置 ====================

  /** 选范围阶段的开始卡片（骨架与其它三个模式共用 `ui/dom.showStartCard`）。 */
  private renderStartCard() {
    showStartCard({
      id: 'puzzle-start',
      title: modeTitle('puzzle'),
      subtitle: t('puzzle.startSubtitle', { scope: this.scopeLabel() }),
      onStart: () => this.startRun(),
    });
  }

  /** 点「开始」：按当前范围建碎片、隐藏地图、启动计时。 */
  private startRun() {
    this.started = true;
    this.finished = false;
    this.paused = false;
    this.elapsedMs = 0;
    this.pieces = [];
    this.state = null;
    this.ensureState();
    if (!this.state) {
      // 该范围没有可拼碎片（理论上不会发生）：退回选范围，别留在空白盘面上
      this.started = false;
      this.enter();
      return;
    }
    this.showBoard(true);
    setHint('');
    this.startTimer();
    this.renderStatus();
    this.ctx.setTestRunning?.(true); // 盘面运行时收起排行榜侧栏（与测验一致）
    this.ctx.syncChrome?.();
  }

  /** 完成卡片的「再来一局」：同范围内重新打乱并立刻开跑。 */
  private restartRun() {
    this.state?.start();
    this.started = true;
    this.finished = false;
    this.paused = false;
    this.elapsedMs = 0;
    this.showBoard(true);
    this.startTimer();
    this.renderStatus();
    this.ctx.setTestRunning?.(true);
    this.ctx.syncChrome?.();
  }

  /** 「重置」= 回到开始卡片：清空画布、回到选范围阶段（地图重新出现）。 */
  private resetToStartCard() {
    this.started = false;
    this.finished = false;
    this.paused = false;
    this.elapsedMs = 0;
    this.clearTick();
    this.ctx.setTestRunning?.(false); // 回到开始卡片：展开排行榜侧栏
    this.enter(); // 选范围分支会拆掉画布、丢弃 state、渲染地图并出开始卡片
  }

  private onDrop(result: DropResult) {
    this.renderStatus();
    if (!result.complete || this.finished) return;
    this.finish();
  }

  /** 获胜：补三沙（仅省级档有）→ 缩到整图 → 弹完成卡片（可提交的范围带「提交成绩」）。 */
  private finish() {
    this.finished = true;
    this.started = false;
    this.commitElapsed();
    this.clearTick();
    this.ctx.setTestRunning?.(false); // 结束后展开排行榜侧栏
    this.view?.revealSeaIslets();
    // 补完三沙后取景要连带它们一起装进来（否则「自动补上」看不见），故允许比用户可操作的最小倍率更小
    window.setTimeout(() => this.view?.fitAll(56, true, { includeSeaIslets: true, minZoom: 0.3 }), 260);
    window.setTimeout(() => {
      this.ctx.showSummary(
        `<div class="puzzle-done-title">${t('puzzle.doneTitle')}</div>` +
          `<div class="sum-stats">${t('puzzle.doneTime', { time: formatClock(this.elapsedMs) })}</div>`,
        () => this.restartRun(),
        this.collectResult() ?? undefined, // 可提交范围：完成卡片上直接给「提交成绩」
        t('puzzle.again'),
      );
    }, 900);
    this.renderStatus();
    this.ctx.syncChrome?.(); // 结束后难度按钮重新出现（运行中收起）
  }

  /**
   * 本局成绩（结算/提交用）。
   *
   * 口径：`correct` = 顶部显示的**已拼**个数（1 + 吸附次数），`totalUnits` = 范围总片数，
   * `wrong` 恒为 0（拼图没有"答错"）。**只有可提交范围、且已拼 ≥ 2 时**才返回成绩。
   */
  collectResult(): RoundResult | null {
    const state = this.state;
    if (!state || !this.boardPhase()) return null;
    if (!isPuzzleLeaderboardScope(this.scope)) return null;
    const placed = state.assembledCount();
    if (placed < PUZZLE_MIN_SUBMIT) return null;
    return {
      mode: 'puzzle',
      scopeProvince: this.scope,
      scopeLabel: this.scopeLabel(),
      totalUnits: state.totalCount(),
      correct: placed,
      wrong: 0,
      elapsedMs: Math.round(this.elapsedMs),
      finishedAt: Date.now(),
    };
  }

  /** 当前是否处于「可提交排行榜」的范围（外壳据此决定「重置」要不要弹结算卡片）。 */
  isRankedScope(): boolean {
    return isPuzzleLeaderboardScope(this.scope);
  }

  pause() {
    if (!this.started) return;
    this.commitElapsed();
    this.paused = true;
    this.clearTick();
    this.view?.setEnabled(false);
  }

  resume() {
    if (!this.started || !this.paused) return;
    this.paused = false;
    this.startTimer();
    this.view?.setEnabled(true);
  }

  isPaused() {
    return this.paused;
  }

  onEnd() {
    this.pause();
  }

  onReset() {
    this.resetToStartCard();
    toast(t('puzzle.restarted'));
  }

  isStarted() {
    return this.started;
  }

  // ==================== 计时 ====================

  private elapsed(): number {
    return this.started && !this.paused ? this.elapsedMs + (performance.now() - this.runStart) : this.elapsedMs;
  }

  private commitElapsed() {
    if (!this.started || this.paused) return;
    this.elapsedMs += performance.now() - this.runStart;
    this.runStart = performance.now();
  }

  private clearTick() {
    if (this.tickTimer !== null) {
      window.clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  private startTimer() {
    this.clearTick();
    this.runStart = performance.now();
    this.tickTimer = window.setInterval(() => this.renderStatus(), TICK_MS);
  }

  // ==================== 视图辅助 ====================

  private puzzleEl(): HTMLElement | null {
    return document.getElementById('puzzle');
  }

  /**
   * 拼图的 **1x 基准比例**：与地图页 zoom=1 **完全一致**（用户口径）。
   *
   * 地图 zoom=1 是把固定投影 bbox 装进容器的 80% 区域（见 `unitScale`），所以这里只依赖
   * **投影族 + 画布尺寸**，与当前范围大小无关 —— 于是拼图 1x 下的一片的像素尺寸，
   * 与地图 1x 下同一单位的尺寸相同；下钻小范围时 1x 会很小，靠滚轮放大（上限与地图一致的 28x）。
   */
  private baseScale(): number {
    const rect = this.puzzleEl()?.getBoundingClientRect();
    const width = rect && rect.width > 0 ? rect.width : 1280;
    const height = rect && rect.height > 0 ? rect.height : 720;
    return unitScale(this.family(), width, height);
  }

  /** 缩放角标（外壳用）：拼图阶段返回拼图自身倍率，其余时刻返回 null 走地图渲染器的值。 */
  getZoomDisplay(): number | null {
    return this.boardPhase() ? this.view?.zoomLevel() ?? 1 : null;
  }

  private themeColors(): PuzzleThemeColors {
    const map = MAP_THEMES[this.ctx.settings.darkMode ? 'dark' : 'light'];
    const tone =
      this.granularity === 'city'
        ? this.ctx.settings.cityBoundaryTone
        : this.granularity === 'world'
          ? this.ctx.settings.worldBoundaryTone
          : this.ctx.settings.provinceBoundaryTone;
    return { fill: map.fill.gray, stroke: map.boundary[tone], label: map.labelNeutral, halo: map.labelBg };
  }

  /** 建碎片与邻接（范围变化或开局时调用一次）。 */
  private ensureState() {
    if (this.state) return;
    const scope = this.puzzleScope();
    const pieces = buildPieces(this.ctx.data, scope);
    if (!pieces.length) {
      toast(t('puzzle.emptyScope'));
      return;
    }
    this.pieces = pieces;
    const adjacency = buildPuzzleAdjacency(pieces, (adcode) => this.neighboursOf(adcode, scope));
    // 磁吸容差按难度取（简单 10px / 困难 5px）：难度在运行中锁定，故开局建一次就够
    this.state = new PuzzleState(pieces, adjacency, SNAP_TOLERANCE_PX[this.difficulty]);
    this.state.start();
  }

  /** 某片的陆地邻居（按范围取不同来源：国家 / 省聚合 / 地级单位）。 */
  private neighboursOf(adcode: string, scope: PuzzleScope): string[] {
    if (scope.granularity === 'world') {
      return this.ctx.data.countries.find((c) => c.iso === adcode)?.neighbors ?? [];
    }
    if (scope.granularity === 'province') {
      if (!this.provinceAdjacencyCache) this.provinceAdjacencyCache = buildProvinceAdjacency(this.ctx.data);
      return this.provinceAdjacencyCache.get(adcode) ?? [];
    }
    return this.ctx.data.units.find((u) => u.adcode === adcode)?.neighbors ?? [];
  }

  /**
   * 显示盘面：**先让外壳把 `#puzzle` 显出来**再量尺寸。
   *
   * 顺序很关键：`#puzzle` 在选范围阶段是 `display:none`，此时 `getBoundingClientRect()` 宽度为 0，
   * 基比例与 `resetView()` 的居中都会算错（碎片被摆到视口外）。故先切类名
   * （同步触发样式/布局失效），再量尺寸、定视角。
   */
  private showBoard(reset: boolean) {
    // 盘面阶段要脱离地图态：省级全国的港澳放大框（#hkmac-inset）是独立 DOM，
    // 不退出省级模式它会一直浮在拼图画布上。
    this.ctx.renderer.setWorldMode(false, null, null);
    this.ctx.renderer.setProvinceMode(false, { inset: false });
    this.ctx.syncChrome?.();
    this.mountView();
    this.view?.refreshScale();
    if (reset) this.view?.resetView();
    this.view?.refreshStyle();
    this.view?.setEnabled(this.started && !this.paused);
  }

  private mountView() {
    const el = this.puzzleEl();
    if (!el || !this.state) return;
    if (this.view && this.viewState !== this.state) this.teardownView();
    if (!this.view) {
      this.viewState = this.state;
      this.view = new PuzzleView({
        container: el,
        state: this.state,
        baseScale: () => this.baseScale(),
        family: () => this.family(),
        labels: () => this.difficulty === 'easy',
        hints: () => this.difficulty === 'easy',
        theme: () => this.themeColors(),
        onDrop: (result) => this.onDrop(result),
        onZoom: () => this.ctx.syncChrome?.(), // 缩放角标跟着刷新
        toast,
      });
      this.view.mount();
      return;
    }
    this.view.setEnabled(this.started && !this.paused);
  }

  private teardownView() {
    this.view?.unmount();
    this.view = null;
    this.viewState = null;
  }

  private renderStatus() {
    const state = this.state;
    if (!this.boardPhase() || !state) {
      puzzleStatus('');
      return;
    }
    puzzleStatus(
      t('puzzle.status', { placed: state.assembledCount(), total: state.totalCount(), time: formatClock(this.elapsed()) }),
    );
  }

  // ==================== 模式接口 ====================

  getModeSettings(): ModeSettingsPanel | null {
    return null; // 难度用分段按钮，不开每模式设置浮层
  }

  getDifficulty(): PuzzleDifficulty {
    return this.difficulty;
  }

  setDifficulty(d: PuzzleDifficulty) {
    if (this.difficulty === d) return;
    if (this.started) return; // 运行中不允许切换
    this.difficulty = d;
    savePuzzleDifficulty(d);
    if (this.boardPhase()) this.view?.refreshStyle();
    else this.renderScopeMap(); // 选范围阶段：地图上的名称标签跟着难度变
    this.renderStatus();
  }

  // ==================== 探针用的只读快照 ====================

  snapshot() {
    return {
      started: this.started,
      paused: this.paused,
      finished: this.finished,
      phase: this.puzzlePhase(),
      difficulty: this.difficulty,
      granularity: this.granularity,
      scope: this.scope,
      scopeLabel: this.scopeLabel(),
      placed: this.state?.assembledCount() ?? 0,
      total: this.state?.totalCount() ?? 0,
      slots: [...(this.state?.slots ?? [])],
      groups: (this.state?.groups ?? []).map((g) => ({
        id: g.id,
        pieces: [...g.pieces],
        dx: Math.round(g.dx),
        dy: Math.round(g.dy),
      })),
      complete: this.state?.isComplete() ?? false,
      elapsedMs: Math.round(this.elapsed()),
      view: this.view?.debugState() ?? null,
    };
  }

  /** 探针用：直接改难度（等价于点分段按钮）。 */
  debugSetDifficulty(d: PuzzleDifficulty) {
    this.setDifficulty(d);
  }

  /** 探针用：直接开一局（等价于点「开始」）。 */
  debugStart() {
    if (!this.started) this.startRun();
  }

  /** 探针用：重开一局。 */
  debugRestart() {
    this.restartRun();
  }

  /** 探针用：切范围/粒度（等价于点分段按钮或地图下钻）。 */
  debugSetScope(granularity: Granularity, scope: string | null) {
    if (this.boardPhase()) return this.snapshot();
    this.granularity = granularity;
    this.scope = scope;
    this.persistGranularity();
    this.enter();
    return this.snapshot();
  }

  /** 探针用：把某片从卡槽/池子取出并放到指定拼图 px 位置（不经过指针，用于验证吸附）。 */
  debugPlaceAt(adcode: string, x: number, y: number) {
    const state = this.state;
    if (!state) return null;
    const def = state.def(adcode);
    if (!def) return null;
    const scale = this.baseScale();
    const group = state.takeAny(adcode);
    if (!group) return null;
    const origin = project(def.origin, scale, this.family());
    state.moveGroup(group.id, x - origin[0], y - origin[1]);
    const result = state.drop(group.id);
    this.view?.refreshStyle();
    this.renderStatus();
    if (result.complete && !this.finished) this.finish();
    return { ...result, groupId: group.id };
  }

  /** 探针用：某片真值位置在拼图 px 下的坐标。 */
  debugTruePosition(adcode: string) {
    const def = this.state?.def(adcode);
    if (!def) return null;
    const scale = this.baseScale();
    const [x, y] = project(def.origin, scale, this.family());
    return { x, y, scale };
  }

  /** 探针用：把剩余碎片按真值位置全部放下（验证获胜流程）。 */
  debugAutoSolve() {
    const state = this.state;
    if (!state) return false;
    for (const adcode of state.adcodes()) {
      const group = state.takeAny(adcode);
      if (!group) continue;
      state.moveGroup(group.id, 0, 0);
      state.drop(group.id);
    }
    this.view?.refreshStyle();
    this.renderStatus();
    if (state.isComplete() && !this.finished) this.finish();
    return state.isComplete();
  }
}

/** 供测试复用：按范围取碎片（不参与运行逻辑）。 */
export function puzzlePiecesForScope(data: AppData, scope: PuzzleScope): PuzzlePieceDef[] {
  return buildPieces(data, scope);
}
