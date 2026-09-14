/**
 * `AppController` 的**诊断装配视图**（运行时验收探针用）。
 *
 * 为什么需要这一层：验收探针要拿到应用装配出来的各个内部对象（渲染器、各模式、面板、
 * 设置、当前模式）。这些字段都是 private，旧做法是探针侧写一个匿名类型再
 * `as unknown as` 强转 —— 那层断言**不受编译器保护**，字段一改名探针就静默拿到
 * `undefined`。
 *
 * 现在集中到 `AppController.diagnostics()`：方法体在类内部，任何被改名 / 删除的字段都会
 * 让 `tsc` 直接报错。探针侧因此**完全不需要强转**，`?probe=1` 之外零成本（方法不会被调用）。
 */
import type { AppData, Settings } from './types';
import type { MapRenderer } from './map/renderer';
import type { AnalysisMode } from './modes/analysis';
import type { ClickMode } from './modes/click';
import type { InputMode } from './modes/input';
import type { PuzzleMode } from './modes/puzzle';
import type { ModeController } from './modes/types';
import type { QuizSessionDiagnostics } from './modes/quizDiagnostics';
import type { SidePanelController } from './ui/sidePanelController';

/**
 * 当前模式：只有测验模式（输入 / 点击）提供会话诊断视图，故 `diagnostics` 可选。
 * 不在 `ModeController` 上加这个方法——那是生产契约，不该被测试关注点污染。
 */
export type ProbeableMode = ModeController & { diagnostics?: () => QuizSessionDiagnostics };

export interface AppDiagnostics {
  renderer: MapRenderer;
  clickMode: ClickMode;
  selfMode: InputMode;
  freeMode: AnalysisMode;
  puzzleMode: PuzzleMode;
  data: AppData;
  settings: Settings;
  sidePanel: SidePanelController;
  /** 当前模式。切换模式会变，故实现为活值 getter。 */
  current: ProbeableMode | null;
  /** 重算外壳 chrome（按钮 / 分段行显隐）。 */
  syncModeChrome(): void;
}
