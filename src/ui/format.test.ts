import { describe, it, expect } from 'vitest';
import { formatElapsedSeconds, formatElapsedCentiseconds } from './format';

describe('formatElapsedSeconds', () => {
  it('formats mm:ss', () => {
    expect(formatElapsedSeconds(0)).toBe('00:00');
    expect(formatElapsedSeconds(1000)).toBe('00:01');
    expect(formatElapsedSeconds(60000)).toBe('01:00');
    expect(formatElapsedSeconds(61000)).toBe('01:01');
    expect(formatElapsedSeconds(599000)).toBe('09:59');
  });

  it('rounds to nearest second', () => {
    expect(formatElapsedSeconds(1499)).toBe('00:01');
    expect(formatElapsedSeconds(1500)).toBe('00:02');
  });
});

describe('formatElapsedCentiseconds', () => {
  it('formats mm:ss.cc', () => {
    expect(formatElapsedCentiseconds(0)).toBe('00:00.00');
    expect(formatElapsedCentiseconds(1000)).toBe('00:01.00');
    expect(formatElapsedCentiseconds(61000)).toBe('01:01.00');
    expect(formatElapsedCentiseconds(1234)).toBe('00:01.23');
  });
});
