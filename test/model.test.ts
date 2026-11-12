import { describe, expect, it } from 'vitest';
import { etaMinutes, marginMinutes, predictPreheat, scheduledStart } from '../src/model';

describe('predictPreheat', () => {
  it('defaults to 60 min with no history', () => {
    expect(predictPreheat([], 50, 194)).toEqual({ minutes: 60, method: 'default', runs: 0 });
  });

  it('scales one run by minutes per °F', () => {
    // 72 min for a 144°F climb = 0.5 min/°F; today's climb is 100°F
    const p = predictPreheat([{ startF: 50, targetF: 194, minutes: 72 }], 94, 194);
    expect(p.method).toBe('ratio');
    expect(p.minutes).toBeCloseTo(50);
  });

  it('fits a and b by least squares with 3+ runs', () => {
    // exact line: t = 10 + 0.4 * climb
    const runs = [100, 120, 140, 80].map((c) => ({ startF: 194 - c, targetF: 194, minutes: 10 + 0.4 * c }));
    const p = predictPreheat(runs, 64, 194);
    expect(p.method).toBe('fit');
    expect(p.a).toBeCloseTo(10);
    expect(p.b).toBeCloseTo(0.4);
    expect(p.minutes).toBeCloseTo(62);
  });

  it('falls back to the ratio when every run had the same climb', () => {
    const runs = [1, 2, 3].map(() => ({ startF: 60, targetF: 180, minutes: 60 }));
    expect(predictPreheat(runs, 60, 180).method).toBe('ratio');
  });

  it('uses only the 20 most recent runs', () => {
    const recent = Array.from({ length: 20 }, (_, i) => ({ startF: 194 - (80 + i * 3), targetF: 194, minutes: 0.5 * (80 + i * 3) }));
    const old = Array.from({ length: 10 }, (_, i) => ({ startF: 194 - (80 + i * 3), targetF: 194, minutes: 200 }));
    const p = predictPreheat([...recent, ...old], 94, 194);
    expect(p.runs).toBe(20);
    expect(p.minutes).toBeCloseTo(50);
  });
});

describe('scheduling', () => {
  it('margin is the larger of 10% and 5 min', () => {
    expect(marginMinutes(30)).toBe(5);
    expect(marginMinutes(80)).toBe(8);
  });

  it('start = hot by − prediction − margin', () => {
    const hotBy = Date.UTC(2026, 10, 7, 19, 0);
    expect(scheduledStart(hotBy, 60)).toBe(hotBy - 66 * 60_000);
  });
});

describe('eta', () => {
  it('is 0 when hot and shrinks with progress', () => {
    expect(etaMinutes([], 60, 194, 194)).toBe(0);
    expect(etaMinutes([], 60, 127, 194)).toBe(30);
  });
});
