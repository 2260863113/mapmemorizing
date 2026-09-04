import { describe, it, expect, vi } from 'vitest';
import { initWrongOrderState, pickWrongNext } from './wrongOrder';
import type { Unit } from '../types';

function u(adcode: string): Unit {
  return { adcode, name: adcode, shortName: adcode, province: 'P', provinceAdcode: 'p1', center: [0, 0], neighbors: [], decorative: false };
}

describe('initWrongOrderState', () => {
  it('detects whether scope had a negative score at round start', () => {
    const units = [u('a'), u('b')];
    const scores = new Map([['a', -2], ['b', 5]]);
    expect(initWrongOrderState(units, (x) => scores.get(x.adcode) ?? 0).scopeHadNegative).toBe(true);
    expect(initWrongOrderState([u('b')], (x) => scores.get(x.adcode) ?? 0).scopeHadNegative).toBe(false);
  });
});

describe('pickWrongNext', () => {
  it('picks lowest score first', () => {
    const units = [u('a'), u('b'), u('c')];
    const scores = new Map([['a', 3], ['b', -4], ['c', -1]]);
    const next = pickWrongNext(units, (x) => scores.get(x.adcode) ?? 0, initWrongOrderState(units, (x) => scores.get(x.adcode) ?? 0), vi.fn());
    expect(next.adcode).toBe('b');
  });

  it('toasts once when crossing from negative to non-negative', () => {
    const units = [u('a'), u('b')];
    const scores = new Map([['a', 1], ['b', 2]]);
    const state = initWrongOrderState(units, (x) => scores.get(x.adcode) ?? 0);
    state.scopeHadNegative = true;
    const toast = vi.fn();
    pickWrongNext(units, (x) => scores.get(x.adcode) ?? 0, state, toast);
    expect(toast).toHaveBeenCalledTimes(1);
    pickWrongNext(units, (x) => scores.get(x.adcode) ?? 0, state, toast);
    expect(toast).toHaveBeenCalledTimes(1); // not again
  });
});
