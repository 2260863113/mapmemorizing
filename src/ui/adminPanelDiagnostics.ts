/**
 * `AdminPanel` 的**只读诊断视图**（流量看板的运行时验收探针用）。
 *
 * 为什么需要这一层：验收脚本要断言的三件事都藏在面板内部 —— 「图表真的挂了几个 canvas」
 * 「真正画出来的点数是 24/7/30」「某个标记点在页面上的哪个像素」。旧做法是探针侧写匿名类型
 * 再 `as unknown as` 强转，那层断言不受编译器保护（成员一改名就静默读到 `undefined`）。
 *
 * 现在集中到 `AdminPanel.diagnostics()`：方法体在类内部，改名/删字段会让 `tsc` 直接报错。
 * 约定同 `map/rendererDiagnostics.ts`：视图**只读**（不触发渲染、不改面板状态），
 * getter 读的是**活值**，因此探针取一次即可长期持有。
 */
export interface AdminPanelDiagnostics {
  /** 当前子视图。 */
  readonly view: 'users' | 'logs' | 'announcements';
  /** 流量看板当前范围（探针断言"点按钮真的改了范围"）。 */
  readonly trafficRange: 'day' | 'week' | 'month';
  /** 图表实例是否还活着（断言"离开面板/重建 DOM 时销毁了"）。 */
  readonly trafficMounted: boolean;
  /** 当前粒度（服务端返回的 `unit`）。 */
  readonly trafficUnit: 'hour' | 'day';
  /** 当前点序列的长度（24 / 7 / 30）。 */
  readonly trafficPointCount: number;
  readonly trafficCounts: number[];
  readonly trafficLabels: string[];
  /** 图表容器内的 canvas 数量（反复切 tab 不该累积）。 */
  trafficCanvasCount(): number;
  /** 图表容器高度（像素）：断言"没有塌成 0 高"。 */
  trafficHeight(): number;
  /** 读回 ECharts **真正生效**的 option（系列类型 / x 轴刻度 / 数据 / 主题色），不是"我们以为写进去的"。 */
  trafficReadback(): { type: string; xAxis: string[]; counts: number[]; lineColor: string; tooltipBg: string } | null;
  /** 第 index 个数据点在**页面坐标**下的像素位置（脚本据此派发真实鼠标事件）；取不到返回 null。 */
  trafficPointClientPixel(index: number): [number, number] | null;
  /** 图表容器在页面坐标下的矩形。 */
  trafficRect(): { left: number; top: number; width: number; height: number } | null;
  /** 空态文案是否可见。 */
  readonly trafficEmptyVisible: boolean;
}
