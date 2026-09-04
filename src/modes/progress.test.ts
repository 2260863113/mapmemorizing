import { describe, it, expect } from 'vitest';
import { progressOf, scopedUnits } from './progress';
import type { AppData, Unit } from '../types';

function u(adcode: string, provinceAdcode: string): Unit {
  return { adcode, name: adcode, shortName: adcode, province: 'P', provinceAdcode, center: [0, 0], neighbors: [], decorative: false };
}

describe('progressOf', () => {
  it('fills pending segments up to total', () => {
    expect(progressOf(3, [])).toEqual({ total: 3, segments: ['pending', 'pending', 'pending'] });
    expect(progressOf(3, ['green', 'red'])).toEqual({ total: 3, segments: ['green', 'red', 'pending'] });
  });
});

describe('scopedUnits', () => {
  const data: AppData = {
    units: [u('a1', 'p1'), u('a2', 'p1'), u('b1', 'p2')],
    allUnits: [],
    provinces: [],
    geoJson: null,
    provincesGeoJson: null,
    countries: [],
    worldGeoJson: null,
  };
  it('returns all units when scope is null', () => {
    expect(scopedUnits(data, null).map((x) => x.adcode)).toEqual(['a1', 'a2', 'b1']);
  });
  it('filters by province when scope set', () => {
    expect(scopedUnits(data, 'p1').map((x) => x.adcode)).toEqual(['a1', 'a2']);
  });
});
