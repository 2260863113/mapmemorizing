/**
 * 测验模式（输入 / 点击）的**会话状态探针视图**（运行时验收探针用）。
 *
 * 为什么需要这一层：验收探针必须读到会话状态机的 protected / private 成员 —— 正确与错误
 * 集合、进度格、错误回滚计数、当前范围与出题顺序、BFS 前沿队列。TypeScript 的可见性只在
 * 编译期生效，旧做法是探针侧写匿名类型再 `as unknown as` 强转，**不受编译器保护**：
 * 基类一改名，`tsc` 与单测都不报错，探针却在验收时静默读到 `undefined`。
 *
 * 现在集中到 `MapQuizMode.diagnostics()` / `InputMode.orderDiagnostics()`：方法体在类内部，
 * 成员改名 / 删除 / 改签名会让 `tsc` 直接报错。
 *
 * 与渲染器的诊断视图不同，这里是**可写**的：探针需要构造场景（把范围压到某大洲跑完整个
 * 顺序序列、强制开启错误回滚、清空 BFS 队列），并在断言结束后还原。因此每个可变成员都是
 * get + set 成对出现。
 */
import type { Continent, SubregionId, Unit } from '../types';
import type { OrderMode, ProgressSegment, QuestionNaming } from './types';

export interface QuizSessionDiagnostics {
  // ==================== 进度与会话状态（可写：探针构造场景后必须还原） ====================
  green: Set<string>;
  red: Set<string>;
  question: string | null;
  results: ProgressSegment[];
  fail: number;
  started: boolean;
  order: string[];

  // ==================== 范围 ====================
  scopeProvince: string | null;
  worldContinent: Continent | null;
  worldSubregion: SubregionId | null;
  orderMode: OrderMode;
  /** 题面/标签取名口径（国名/首都、中文/英文、省名/简称）。 */
  naming: QuestionNaming;

  // ==================== 错误回滚 ====================
  errorRollback: boolean;
  /** 错误回滚中已计入第一次答错的单位。 */
  rollbackCounted: Set<string>;
  /** 错误回滚展示中，暂不接受作答。 */
  rollbacking: boolean;

  // ==================== 操作 ====================
  activePool(): Unit[];
  worldScopedPool(): Unit[];
  persist(): void;
  start(continueSaved: boolean): void;
  answer(correct: boolean, scored: boolean, timedOut?: boolean): void;
}

/**
 * 输入模式独有的**顺序出题**状态（BFS 前沿队列）。
 *
 * 为什么单独一个入口：`InputMode` 的这三个字段是子类私有的，而基类的
 * `diagnostics()` 已由基类实现；再写一个入口比用原型链拼接两个视图更好读。
 */
export interface QuizOrderDiagnostics {
  /** BFS 前沿队列的种子（上一题答对的单位）。 */
  lastGreen: string | null;
  bfsQueue: string[];
  /** 队列所属范围签名：范围一变就丢弃队列重新播种。 */
  bfsDomain: string;
}
