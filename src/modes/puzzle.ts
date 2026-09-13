/**
 * 拼图模式（puzzle，2026-09 新增，见 CONTEXT.md「拼图模式」与 docs/adr/0006）。
 *
 * 玩法：进入时画面上没有地图，左侧三个玻璃态卡槽里各装一片省级单位（plus 40% 几何）；
 * 拖出后是 1:1 真值大小，可放在任意位置；**松手时**相邻两片若接近其真值相对位置（≤15px）
 * 就精确对齐合成一组，此后整组一起拖；34 片吸成一整块即获胜。
 *
 * 本轮只做**全国省级**：粒度分段按钮保留三档，点世界/市级只提示"暂未开放"。
 * 难度（简单/困难）只影响是否显示省名。计时从点「开始」起算，暂停/切走都不累计。
 */
import type { Mode } from '../types';
import type { ModeCtx } from './types';
import { BaseMode } from './baseMode';
import { t } from '../i18n';
import type { Granularity } from '../province';
import { buildProvinceAdjacency } from '../province';
import { MAP_THEMES } from '../map/theme';
import { buildPieces, type PuzzlePieceDef } from '../puzzle/pieces';
import { buildPuzzleAdjacency } from '../puzzle/adjacency';
import { PuzzleState, SNAP_TOLERANCE_PX, type DropResult } from '../puzzle/state';
import { PuzzleView, type PuzzleThemeColors } from '../puzzle/view';
import { PUZZLE_SPAN_LNG, project } from '../puzzle/projection';
import { loadPuzzleDifficulty, savePuzzleDifficulty, type ModeSettingsPanel } from '../modeSettings';
import { puzzleStatus, setHint, showSummary, toast } from '../ui/dom';

/** 难度：简单 = 显示省名；困难 = 不显示（用户口径：难度只管标签）。 */
export type PuzzleDifficulty = 'easy' | 'hard';

/** 默认视角：整幅中国 bbox 宽 ≈ 视口宽 × 1.15（略大于视口，便于把碎片推到四周）。 */
const DEFAULT_WIDTH_RATIO = 1.15;

/** 计时刷新间隔（毫秒）。 */
const TICK_MS = 200;

/** 毫秒 → mm:ss。 */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

export class PuzzleMode extends BaseMode {
  id: Mode = 'puzzle';
  title = t('mode.puzzle.title');

  private pieces: PuzzlePieceDef[] = [];
  private state: PuzzleState | null = null;
  private view: PuzzleView | null = null;
  private difficulty: PuzzleDifficulty = loadPuzzleDifficulty();
  private granularity: Granularity = 'province';

  private started = false;
  private paused = false;
  private entered = false;
  private finished = false;

  /** 计时：只在"已开始且未被暂停且在模式内"时累加。 */
  private elapsedMs = 0;
  private runStart = 0;
  private tickTimer: number | null = null;
  private statusPlaced = 0;

  constructor(private ctx: ModeCtx) {
    super();
  }

  // ==================== 生命周期 ====================

  enter() {
    this.entered = true;
    // 拼图不用地图：顺手把港澳放大框收起来（它由渲染器驱动，不随 #map 一起隐藏）
    this.ctx.renderer.setProvinceMode(false, { inset: false });
    this.ensureState();
    this.mountView();
    if (!this.started) {
      this.setHint_(t('puzzle.readyHint'));
      this.showStartCard();
    } else {
      this.setHint_(t('puzzle.playHint'));
      if (!this.paused) this.startTimer();
    }
    this.refresh();
  }

  exit() {
    this.entered = false;
    this.stopTimer();
    this.view?.setEnabled(false);
  }

  /** 该模式没有排行榜/熟练度，refresh 只负责把视角与配色跟上当前窗口与主题。 */
  refresh() {
    if (!this.entered) return;
    const rect = this.puzzleEl()?.getBoundingClientRect();
    if (rect && rect.width > 0) this.view?.refreshScale();
    this.view?.refreshStyle();
    this.view?.setEnabled(this.started && !this.paused);
    this.renderStatus();
  }

  hasProgress() {
    return false;
  }

  // ==================== 开始 / 暂停 / 重置 ====================

  private showStartCard() {
    const actions = `<button id="puzzle-start" class="start-action">${t('common.start')}</button>`;
    setHint(
      `<div class="start-panel"><div class="start-title">${t('puzzle.startTitle')}</div>` +
        `<div class="start-subtitle">${t('puzzle.startSubtitle')}</div>${actions}</div>`,
    );
    const btn = document.getElementById('puzzle-start') as HTMLButtonElement | null;
    if (btn) btn.onclick = () => this.startRun();
  }

  /** 点「开始」：不重新打乱（卡槽里的预览就是这一局的起手），只启动计时与拖拽。 */
  private startRun() {
    this.started = true;
    this.finished = false;
    this.paused = false;
    this.elapsedMs = 0;
    this.startTimer(); // 内部会把 runStart 设为此刻
    this.setHint_(t('puzzle.playHint'));
    this.renderBoard();
    this.renderStatus();
  }

  /** 重开一局：重新打乱 + 计时归零（「重置」与完成卡片的「再来一局」都走这里）。 */
  private restartRun() {
    this.state?.start();
    this.view?.refreshStyle();
    this.view?.resetView();
    this.startRun();
  }

  private mountView() {
    const el = this.puzzleEl();
    if (!el) return;
    if (!this.view) {
      this.view = new PuzzleView({
        container: el,
        state: this.state!,
        baseScale: () => this.baseScale(),
        labels: () => this.difficulty === 'easy',
        theme: () => this.themeColors(),
        onDrop: (result) => this.onDrop(result),
        toast,
      });
      this.view.mount();
      this.view.resetView();
      return;
    }
    this.view.setEnabled(this.started && !this.paused);
  }

  private renderBoard() {
    this.view?.refreshStyle();
    this.view?.setEnabled(this.started && !this.paused);
  }

  private onDrop(result: DropResult) {
    this.renderStatus();
    if (!result.complete || this.finished) return;
    this.finish();
  }

  /** 获胜：补上三沙岛礁 → 缩到整图 → 弹完成卡片。 */
  private finish() {
    this.finished = true;
    this.started = false;
    this.stopTimer();
    this.view?.revealSeaIslets();
    // 补完三沙后取景要连带它们一起装进来（否则那句"自动补上"用户根本看不见），
    // 因而允许比用户可操作的最小倍率更小一点。
    window.setTimeout(() => this.view?.fitAll(56, true, { includeSeaIslets: true, minZoom: 0.3 }), 260);
    window.setTimeout(() => {
      showSummary(
        `<div class="puzzle-done-title">${t('puzzle.doneTitle')}</div>` +
          `<div class="sum-stats">${t('puzzle.doneTime', { time: formatClock(this.elapsedMs) })}</div>`,
        () => this.restartRun(),
        undefined,
        t('puzzle.again'),
      );
      this.setHint_('');
    }, 900);
  }

  pause() {
    if (!this.started) return;
    this.commitElapsed(); // 先把刚才这一段并入累计，再置暂停（顺序反了会丢掉整段）
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

  /** 「重置」= 重开一局（重新打乱、计时归零）。 */
  onReset() {
    this.restartRun();
    toast(t('puzzle.restarted'));
  }

  isStarted() {
    return this.started;
  }

  // ==================== 计时 ====================

  /** 当前已用时间：暂停/停止时是累计值，运行中再加上当前这一段。 */
  private elapsed(): number {
    return this.started && !this.paused ? this.elapsedMs + (performance.now() - this.runStart) : this.elapsedMs;
  }

  /** 把正在跑的一段并入累计值（暂停/切走/获胜都要先调它，否则这段时间会丢或被算错）。 */
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
    this.runStart = performance.now(); // 重新起算：暂停期间的时间不累计
    this.tickTimer = window.setInterval(() => this.renderStatus(), TICK_MS);
  }

  private stopTimer() {
    this.commitElapsed();
    this.clearTick();
  }

  // ==================== 视图辅助 ====================

  private puzzleEl(): HTMLElement | null {
    return document.getElementById('puzzle');
  }

  private baseScale(): number {
    const rect = this.puzzleEl()?.getBoundingClientRect();
    const width = rect && rect.width > 0 ? rect.width : 1280;
    return (width * DEFAULT_WIDTH_RATIO) / PUZZLE_SPAN_LNG;
  }

  private themeColors(): PuzzleThemeColors {
    const map = MAP_THEMES[this.ctx.settings.darkMode ? 'dark' : 'light'];
    return {
      fill: map.fill.gray,
      stroke: map.boundary[this.ctx.settings.provinceBoundaryTone],
      label: map.labelNeutral,
      halo: map.labelBg,
    };
  }

  private ensureState() {
    if (this.state) return;
    this.pieces = buildPieces(this.ctx.data);
    const adjacency = buildPuzzleAdjacency(this.pieces, buildProvinceAdjacency(this.ctx.data));
    this.state = new PuzzleState(this.pieces, adjacency, SNAP_TOLERANCE_PX);
    // 进模式就把三个卡槽填上（用户口径：开始前卡槽已可见），点「开始」只是启动计时与拖拽
    this.state.start();
  }

  private setHint_(html: string) {
    setHint(html);
  }

  private renderStatus() {
    if (!this.started && !this.finished) {
      puzzleStatus('');
      return;
    }
    const placed = this.state?.placedCount() ?? 0;
    const total = this.state?.totalCount() ?? 0;
    this.statusPlaced = placed;
    puzzleStatus(
      t('puzzle.status', { placed, total, time: formatClock(this.elapsed()) }),
    );
  }

  // ==================== 模式接口（本轮只支持省级） ====================

  getModeSettings(): ModeSettingsPanel | null {
    return null; // 难度用分段按钮，不开每模式设置浮层
  }

  /** 顶部粒度按钮：只有省级可用，另两档提示"暂未开放"。 */
  getGranularity(): Granularity {
    return this.granularity;
  }

  setGranularity(g: Granularity) {
    if (g === 'province') {
      this.granularity = 'province';
      return;
    }
    toast(t('puzzle.notYet'));
  }

  getDifficulty(): PuzzleDifficulty {
    return this.difficulty;
  }

  setDifficulty(d: PuzzleDifficulty) {
    if (this.difficulty === d) return;
    this.difficulty = d;
    savePuzzleDifficulty(d);
    this.renderBoard();
    this.renderStatus();
  }

  // ==================== 探针用的只读快照 ====================

  snapshot() {
    return {
      started: this.started,
      paused: this.paused,
      finished: this.finished,
      difficulty: this.difficulty,
      granularity: this.granularity,
      placed: this.state?.placedCount() ?? 0,
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
    this.startRun();
  }

  /** 探针用：重开一局（等价于点两次「重置」）。 */
  debugRestart() {
    this.restartRun();
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
    const origin = project(def.origin, scale);
    state.moveGroup(group.id, x - origin[0], y - origin[1]);
    const result = state.drop(group.id);
    this.view?.refreshStyle();
    this.renderStatus();
    if (result.complete && !this.finished) this.finish();
    return { ...result, groupId: group.id };
  }

  /** 探针用：某片真值位置在拼图 px 下的坐标（把两片放到"接近正确"处时用）。 */
  debugTruePosition(adcode: string) {
    const def = this.state?.def(adcode);
    if (!def) return null;
    const scale = this.baseScale();
    const [x, y] = project(def.origin, scale);
    return { x, y, scale };
  }

  /** 探针用：把剩余碎片按真值位置全部放下（用于验证获胜流程）。 */
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
