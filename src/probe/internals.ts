/**
 * 探针与应用之间的**类型化入口**。
 *
 * 历史（为什么这里曾经很危险）：旧实现把「读应用内部 private 成员」的断言散落在 760 行的
 * 各个方法里，用 40 个互不相关、成员一律可选的匿名类型 + `?.()` 调用表达。后果是生产侧
 * 改名时 `tsc` 与单测都不报错，探针却在运行时静默少读一个字段、或干脆不执行那一步
 * —— 你会以为「验收过了」。实测：把 `MapRenderer.worldNameToIso` 改名，探针相关编译错误为 0。
 *
 * 现在探针侧**没有任何强转**。应用侧在类内部提供了四份**编译器可校验**的诊断视图：
 *   `AppController.diagnostics()`   —— 装配出的各内部对象
 *   `MapRenderer.diagnostics()`     —— 相机 / 视图模式 / 世界面命中表 / 渲染状态
 *   `MapQuizMode.diagnostics()`     —— 测验会话状态（可写：探针要构造并还原场景）
 *   `InputMode.orderDiagnostics()`  —— 顺序出题的 BFS 前沿队列
 * 方法体都在类内部，成员改名会让 `tsc` 在**生产文件**里直接报错。
 *
 * 本文件只保留探针侧的少量便利函数。
 */
import type { AppDiagnostics } from '../appDiagnostics';
import type { AppController } from '../appController';
import type { Granularity } from '../province';

/** 取出应用的诊断视图。零强转：`AppController.diagnostics()` 是公开且类型明确的。 */
export function probeInternals(app: AppController): AppDiagnostics {
  return app.diagnostics();
}

/** 探针从 JS 侧（`page.evaluate` 的参数）收到的是字符串，在此收窄成 `Granularity`。 */
export function asGranularity(value: string): Granularity {
  return value as Granularity;
}
