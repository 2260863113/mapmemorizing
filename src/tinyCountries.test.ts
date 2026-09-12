import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyIgnoreTiny, ignoredIsos, isIgnoringTiny, setTinyCountriesForTest } from './tinyCountries';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readJson<T>(rel: string): T {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8')) as T;
}

const tiny = readJson<{ threshold: { anchorIso: string }; isos: string[] }>('public/data/tiny_countries.json');
const area = readJson<{ area: Record<string, number> }>('public/data/world_area.json');
const countries = readJson<{ countries: { iso: string; name: string }[] }>('public/data/countries.json');

describe('tiny country list (public/data/tiny_countries.json)', () => {
  it('excludes exactly the countries at or below the anchor area', () => {
    const anchor = area.area[tiny.threshold.anchorIso];
    const expected = Object.entries(area.area)
      .filter(([, a]) => a <= anchor)
      .map(([iso]) => iso)
      .sort();
    expect(tiny.isos.slice().sort()).toEqual(expected);
  });

  it('contains the anchor itself and stays a small minority of the pool', () => {
    expect(tiny.isos).toContain(tiny.threshold.anchorIso);
    expect(tiny.isos.length).toBeGreaterThan(0);
    expect(tiny.isos.length).toBeLessThan(countries.countries.length / 3);
  });

  it('has no Vatican and no country outside the answering pool', () => {
    expect(tiny.isos).not.toContain('VAT'); // 梵蒂冈已整体移出答题池
    const pool = new Set(countries.countries.map((c) => c.iso));
    for (const iso of tiny.isos) expect(pool.has(iso)).toBe(true);
  });
});

describe('countries.json after removing Vatican', () => {
  it('has 194 answering countries and no VAT', () => {
    expect(countries.countries.length).toBe(194);
    expect(countries.countries.some((c) => c.iso === 'VAT')).toBe(false);
  });

  it('keeps the area table, subregion map and country list mutually consistent', () => {
    const sub = readJson<{ byIso: Record<string, string> }>('public/data/subregions.json');
    const pool = countries.countries.map((c) => c.iso).sort();
    expect(Object.keys(area.area).sort()).toEqual(pool);
    expect(Object.keys(sub.byIso).sort()).toEqual(pool);
    expect(area.area.VAT).toBeUndefined();
    expect(sub.byIso.VAT).toBeUndefined();
  });

  it('keeps every area positive (needed for the inverse-zoom mapping)', () => {
    for (const [iso, a] of Object.entries(area.area)) {
      expect(a, `${iso} area`).toBeGreaterThan(0);
    }
  });
});

describe('tinyCountries runtime state', () => {
  afterEach(() => setTinyCountriesForTest(null));

  it('is inert by default (setting off → nothing excluded)', () => {
    expect(isIgnoringTiny()).toBe(false);
    expect(ignoredIsos().size).toBe(0);
  });

  it('excludes exactly the supplied list when the setting is on', () => {
    applyIgnoreTiny(true, ['MCO', 'NRU']);
    expect(isIgnoringTiny()).toBe(true);
    expect([...ignoredIsos()].sort()).toEqual(['MCO', 'NRU']);
  });

  it('clears the excluded set when the setting is turned off again', () => {
    applyIgnoreTiny(true, ['MCO', 'NRU']);
    applyIgnoreTiny(false, ['MCO']);
    expect(isIgnoringTiny()).toBe(false);
    expect(ignoredIsos().size).toBe(0);
  });

  it('returns an empty set (not undefined) so callers can always iterate', () => {
    const s = ignoredIsos();
    expect(s).toBeInstanceOf(Set);
    expect([...s]).toEqual([]);
    expect(s.has('FRA')).toBe(false);
  });

  it('replaces the set on each apply so a stale list cannot linger', () => {
    applyIgnoreTiny(true, ['MCO', 'NRU']);
    applyIgnoreTiny(true, ['MDV']);
    expect([...ignoredIsos()]).toEqual(['MDV']);
  });
});
