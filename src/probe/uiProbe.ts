/**
 * 外壳 UI 状态的验收探针（round3：主题 / 边界深浅 / 标签显隐 / 粒度能力位）。
 *
 * 只读快照，不修改任何状态。标签数量直接调渲染器的数据构造器，量的是
 * 「这一次到底会画出多少个标签」，而不是某个开关的布尔值。
 */
import type { RenderState } from '../types';
import type { AppDiagnostics } from '../appDiagnostics';

export function uiProbe(a: AppDiagnostics) {
  const { renderer, settings, freeMode } = a;
  /** 渲染器的只读诊断视图（活值）。 */
  const d = renderer.diagnostics();

  return {
    round3Ui() {
      const state = d.lastState;
      const countOf = (fn: ((s: RenderState) => unknown[]) | null) =>
        state && fn ? fn(state).length : null;
      /**
       * 各标签系列实际画出的**文本**：标签数据每行是 `{ name, value: [lng, lat, text, color, …] }`，
       * 取 `value[2]` 即最终画在画布上的字。验收脚本靠它断言「标签显示的是首都名 / 单字简称」——
       * 只看数量或 state 上的布尔位都不足以证明这件事。
       */
      const textsOf = (fn: ((s: RenderState) => unknown[]) | null) => {
        if (!state || !fn) return null;
        return fn(state).map((row) => {
          const value = (row as { value?: unknown[] }).value;
          return Array.isArray(value) ? String(value[2] ?? '') : '';
        });
      };

      return {
        mode: a.current?.id ?? null,
        granularity: a.current?.getGranularity?.() ?? null,
        freeGranularity: freeMode.getGranularity(),
        settings: { ...settings },
        boundaries: {
          city: d.cityBoundaryTone,
          province: d.provinceBoundaryTone,
          world: d.worldBoundaryTone,
        },
        view: {
          worldMode: d.worldMode,
          provinceMode: d.provinceMode,
          provinceModeDrill: d.provinceModeDrill,
          provinceModeInset: d.provinceModeInset,
          drilledProvince: renderer.currentProvince(),
        },
        zoom: d.zoom,
        labelMode: d.labelMode,
        /** 各标签系列实际会画出的标签数量（0 = 一个都不显示）。 */
        labelCounts: {
          city: countOf(d.buildLabelData),
          province: countOf(d.buildProvinceLabelData),
          world: countOf(d.buildWorldLabelData),
        },
        /** 各标签系列实际会画出的文本（顺序与数据一致）。 */
        labelTexts: {
          city: textsOf(d.buildLabelData),
          province: textsOf(d.buildProvinceLabelData),
          world: textsOf(d.buildWorldLabelData),
        },
        labels: state
          ? {
              hideLabels: state.hideLabels === true,
              showAllLabels: state.showAllLabels === true,
              showAllProvinceLabels: state.showAllProvinceLabels === true,
              worldShowAllLabels: state.worldShowAllLabels === true,
              labelZoomThreshold: state.labelZoomThreshold ?? null,
              worldLabelZoomThreshold: state.worldLabelZoomThreshold ?? null,
            }
          : null,
      };
    },
  };
}
