import type { Unit } from '../types';
import { t } from '../i18n';

/**
 * 错题出题状态：记录本轮范围内是否存在历史错题（负分）以及是否已弹出"错题已出完"提示。
 * 状态写入模式进度 localStorage（wrongToastShown），避免暂停/刷新后重复弹出。
 */
export interface WrongOrderState {
  scopeHadNegative: boolean; // 本轮范围内是否存在负分（历史错题）
  toastShown: boolean; // 本轮是否已弹过"错题已出完"
}

/** 初始化：用轮次开始时持久化的熟练度分计算范围内是否存在负分（避免本轮新产生的负分误触发）。 */
export function initWrongOrderState(scopeUnits: readonly Unit[], scoreOf: (u: Unit) => number): WrongOrderState {
  return {
    scopeHadNegative: scopeUnits.some((u) => scoreOf(u) < 0),
    toastShown: false,
  };
}

/**
 * 从剩余题目中选出熟练度分最低的（负分最负在前；同分靠稳定排序保持数据文件顺序 = 任意选择）。
 * 当范围存在错题且首次选中非负分题目（负→非负边界）时弹一次提示。
 */
export function pickWrongNext(
  pool: readonly Unit[],
  scoreOf: (u: Unit) => number,
  state: WrongOrderState,
  toast: (msg: string) => void,
): Unit {
  const sorted = [...pool].sort((a, b) => scoreOf(a) - scoreOf(b));
  const next = sorted[0];
  if (next && !state.toastShown && state.scopeHadNegative && scoreOf(next) >= 0) {
    state.toastShown = true;
    toast(t('wrongOrder.finished'));
  }
  return next;
}
