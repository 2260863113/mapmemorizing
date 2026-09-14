/**
 * 拼图模式（2026-09 新增）的运行时验收探针。
 *
 * 拼图的验收点几乎全是**运行时行为**：选范围阶段的地图下钻、开始后画布清空、
 * 拖拽与磁吸、组面积决定的上下层、难度分档容差、获胜与重置。这些都只能在真实
 * 浏览器里驱动真实指针事件才能断言，故探针直连 `PuzzleMode` 的公开接口。
 *
 * 注：`PuzzleMode` 上仍留着 8 个 `debug*` 方法（供探针驱动真实开局 / 摆片 / 自动拼完）。
 * 把它们移出生产类的代价是暴露 `state` / `view` / `baseScale()` / `family()` 等更多内部，
 * 反而扩大耦合面，故保留并在 P2 阶段随模式层去重一并评估。
 */
import type { PuzzleDifficulty } from '../modes/puzzle';
import { asGranularity } from './internals';
import type { AppDiagnostics } from '../appDiagnostics';

export function puzzleProbe(a: AppDiagnostics) {
  const { puzzleMode } = a;

  return {
    /** 拼图模式只读快照：卡槽 / 已放置数 / 组结构 / 计时 / 视图变换。 */
    puzzle() {
      return { mode: a.current?.id ?? null, ...puzzleMode.snapshot() };
    },

    /** 探针用：直接开一局（等价于点「开始」）。`debugStart` 自带「已开局则不重开」守卫。 */
    puzzleStart() {
      puzzleMode.debugStart();
      return true;
    },

    /** 探针用：重开一局（清空画布、重新打乱卡槽）。 */
    puzzleRestart() {
      puzzleMode.debugRestart();
      return true;
    },

    /** 探针用：把剩余碎片按真值位置一次性放下（验证「拼成一整块 → 获胜」流程）。 */
    puzzleAutoSolve() {
      return puzzleMode.debugAutoSolve();
    },

    /** 探针用：切难度（等价于点「简单/困难」）。 */
    puzzleDifficulty(d: PuzzleDifficulty) {
      puzzleMode.debugSetDifficulty(d);
      return true;
    },

    /** 探针用：切范围（等价于点「世界/省级/市级」、大洲行或下钻某单位）。 */
    puzzleSetScope(granularity: string, scope: string | null) {
      return puzzleMode.debugSetScope(asGranularity(granularity), scope);
    },

    /** 探针用：模拟「点空白返回上一层」（等价于地图空白点击后的模式回调）。 */
    puzzleBack() {
      puzzleMode.onBackToNation?.();
      return true;
    },

    /** 探针用：模拟「点地图上的某个单位」（renderer 只把 adcode 转给模式，这条就是那条路径）。 */
    puzzleUnit(adcode: string) {
      const handled = puzzleMode.onUnitClick(adcode) === true;
      return { handled, snapshot: puzzleMode.snapshot() };
    },

    /** 探针用：把某片放到指定拼图 px 处（验证吸附判定，不经过指针）。 */
    puzzlePlaceAt(adcode: string, x: number, y: number) {
      return puzzleMode.debugPlaceAt(adcode, x, y);
    },

    /** 探针用：某片「真值位置」在拼图 px 下的坐标。 */
    puzzleTruePosition(adcode: string) {
      return puzzleMode.debugTruePosition(adcode);
    },
  };
}
