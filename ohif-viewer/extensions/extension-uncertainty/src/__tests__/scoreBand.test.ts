import { scoreBand, bandTailwindClass, DEFAULT_BAND_THRESHOLDS } from '../utils/scoreBand';

describe('scoreBand', () => {
  it('uses default thresholds: med=0.15, high=0.35', () => {
    expect(DEFAULT_BAND_THRESHOLDS).toEqual({ medium: 0.15, high: 0.35 });
  });

  it('classifies cleanly inside each band', () => {
    expect(scoreBand(0.05)).toBe('low');
    expect(scoreBand(0.20)).toBe('medium');
    expect(scoreBand(0.40)).toBe('high');
  });

  it('treats thresholds as ">=" inclusive (matches FastAPI)', () => {
    expect(scoreBand(0.15)).toBe('medium');
    expect(scoreBand(0.35)).toBe('high');
  });

  it('returns null for null/undefined score', () => {
    expect(scoreBand(null)).toBeNull();
    expect(scoreBand(undefined)).toBeNull();
  });

  it('returns null for non-finite score (NaN, Infinity)', () => {
    expect(scoreBand(Number.NaN)).toBeNull();
    expect(scoreBand(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('throws when high < medium', () => {
    expect(() => scoreBand(0.5, { medium: 0.5, high: 0.2 })).toThrow();
  });

  it('respects custom thresholds', () => {
    const t = { medium: 0.05, high: 0.10 };
    expect(scoreBand(0.04, t)).toBe('low');
    expect(scoreBand(0.07, t)).toBe('medium');
    expect(scoreBand(0.20, t)).toBe('high');
  });
});

describe('bandTailwindClass', () => {
  it('returns distinct class strings per band', () => {
    const high = bandTailwindClass('high');
    const med = bandTailwindClass('medium');
    const low = bandTailwindClass('low');
    const none = bandTailwindClass(null);
    const all = [high, med, low, none];
    // All distinct
    expect(new Set(all).size).toBe(4);
    // Sanity-check the colour signal: high -> red, low -> green
    expect(high).toContain('red');
    expect(low).toContain('emerald');
  });
});
