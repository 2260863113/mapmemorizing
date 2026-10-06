/**
 * 管理端的运行时验收探针（本轮：日志记录 + 游玩统计两个子视图的**折线图**）。
 *
 * 只读快照，不修改面板状态：折线图这类"画没画出来"的需求，单测只能覆盖 option 的构造，
 * 覆盖不到「ECharts 真的建了实例、真的画了 24 个点、鼠标挪上去真的弹出访问量」。
 * 故这里把面板的只读诊断视图摊平成一份 JSON，并把**标记点的页面像素**交给验收脚本，
 * 由脚本派发真实鼠标事件（`Input.dispatchMouseEvent`）。
 *
 * `adminTraffic()` / `adminTrafficPointPixel()` 的名字与返回结构**保持冻结**（既有验收脚本依赖）；
 * 游玩统计另开 `adminPlays()` / `adminPlaysPointPixel()`，两者读的是同一份面板诊断视图。
 */
import type { AppDiagnostics } from '../appDiagnostics';

export function adminProbe(a: AppDiagnostics) {
  const panel = a.adminPanel;
  /** 面板的只读诊断视图（活值：getter 直接读当前字段）。 */
  const d = panel.diagnostics();

  return {
    /** 流量看板快照：范围 / 粒度 / 点数 / 读回的 option / 图表尺寸 / 空态。 */
    adminTraffic() {
      const readback = d.trafficReadback();
      return {
        view: d.view,
        range: d.trafficRange,
        unit: d.trafficUnit,
        mounted: d.trafficMounted,
        pointCount: d.trafficPointCount,
        counts: d.trafficCounts,
        labels: d.trafficLabels,
        canvasCount: d.trafficCanvasCount(),
        height: d.trafficHeight(),
        emptyVisible: d.trafficEmptyVisible,
        rect: d.trafficRect(),
        /** ECharts 真正生效的 option：系列类型 / x 轴刻度 / 数据 */
        option: readback,
      };
    },

    /**
     * 第 index 个数据点的**页面像素**（脚本据此把鼠标挪到标记点上）。
     * 取不到（未挂载 / 索引越界 / 点在视口外）时返回 `null`，由脚本判定失败原因。
     */
    adminTrafficPointPixel(index: number) {
      return d.trafficPointClientPixel(index);
    },

    /** 游玩统计看板快照：与 `adminTraffic()` 同形，只是容器是 `#admin-plays`。 */
    adminPlays() {
      const readback = d.playsReadback();
      return {
        view: d.view,
        range: d.trafficRange,
        unit: d.playsUnit,
        mounted: d.playsMounted,
        pointCount: d.playsPointCount,
        counts: d.playsCounts,
        labels: d.playsLabels,
        canvasCount: d.playsCanvasCount(),
        height: d.playsHeight(),
        emptyVisible: d.playsEmptyVisible,
        rect: d.playsRect(),
        option: readback,
      };
    },

    /** 第 index 个游玩数据点的页面像素（脚本据此悬停验证 tooltip 口径是「次游玩」）。 */
    adminPlaysPointPixel(index: number) {
      return d.playsPointClientPixel(index);
    },
  };
}

