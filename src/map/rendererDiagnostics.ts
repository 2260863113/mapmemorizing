/**
 * `MapRenderer` 的**只读诊断视图**（运行时验收探针用）。
 *
 * 为什么需要这一层：验收探针必须读到渲染器的私有状态 —— 相机（center/zoom）、当前
 * 地图档位与视图模式、世界面命中判定表、最近一次渲染状态。而 TypeScript 的 `private`
 * 只在编译期生效、运行时照常可达，旧做法是探针侧写一个匿名类型再 `as unknown as` 强转。
 * 那层断言**不受编译器保护**：渲染器一改名，`tsc` 与单测都不报错，探针却在验收时静默
 * 读到 `undefined`（已实测：把 `worldNameToIso` 改名，探针相关编译错误为 0）。
 *
 * 现在把这些成员集中到 `MapRenderer.diagnostics()` **一个方法**里。方法体在类内部，
 * 因此每个成员的改名 / 删除 / 类型变化都会让 `tsc` 直接报错，而不是让探针悄悄失效。
 *
 * 约定：视图是**只读**的（探针只观察，不改渲染器状态）；返回的 getter 读的是**活值**，
 * 因此探针在应用启动时取一次即可长期持有。
 */
import type { BoundaryTone, Continent, RenderState, SubregionId } from '../types';
import type { GeoPoint } from './geometry';
import type { ViewportWindow } from './follow';

export interface MapRendererDiagnostics {
  // ==================== ECharts 实例与渲染状态 ====================
  /** ECharts 实例。探针只调 `getOption()` 读回**真正生效**的配置（不是我们以为写进去的）。 */
  readonly chart: { getOption: () => unknown };
  /** 最近一次 `render()` 收到的状态：标签显隐断言的来源。 */
  readonly lastState: RenderState | null;

  // ==================== 相机 ====================
  readonly zoom: number;
  readonly center: [number, number];

  // ==================== 视图模式与档位 ====================
  readonly labelMode: 'none' | 'city';
  readonly worldMode: boolean;
  readonly provinceMode: boolean;
  readonly provinceModeDrill: boolean;
  readonly provinceModeInset: boolean;
  readonly worldContinent: Continent | null;
  readonly worldSubregion: SubregionId | null;

  // ==================== 边界深浅（读回设置是否真的生效） ====================
  readonly cityBoundaryTone: BoundaryTone;
  readonly provinceBoundaryTone: BoundaryTone;
  readonly worldBoundaryTone: BoundaryTone;

  // ==================== 世界面命中判定表 ====================
  /** 世界面 name → iso_a3。 */
  readonly worldNameToIso: Map<string, string>;
  /** 装饰面 name 集合（灰显、不响应）。 */
  readonly worldDecorativeNames: Set<string>;
  /** 被「忽略极小国家」设置排除的面 name 集合。 */
  readonly worldExcludedNames: Set<string>;
  readonly isoContinent: Map<string, Continent>;
  /** iso → 标签锚点（主面质心）：跟随落点断言的实际基准。 */
  readonly worldLabelAnchors: Map<string, GeoPoint>;

  // ==================== 相机与跟随钳制的内部计算 ====================
  /** 当前 geo 视图（center/zoom 的实际生效值）。 */
  currentGeoView(): { center: [number, number]; zoom: number };
  /** 直接驱动镜头动画（探针用来把相机摆到指定位置）。 */
  animateViewTo(center: [number, number], zoom: number): void;
  /** 当前取景边界（越出即露出纯背景）。 */
  framingExtent(): [number, number, number, number];
  /** 当前视口在数据坐标系里的矩形与像素比。 */
  viewportWindow(): ViewportWindow | null;

  // ==================== 高亮与标签数据 ====================
  /** 让某单位闪烁高亮（截图用）。 */
  flash(adcode: string): void;
  /** 各标签系列**实际会画出**的标签数量（0 = 一个都不显示）。 */
  buildLabelData(state: RenderState): unknown[];
  buildProvinceLabelData(state: RenderState): unknown[];
  buildWorldLabelData(state: RenderState): unknown[];
}
