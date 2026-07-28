import { describe, it, expect } from 'vitest';
import { wholeMonthKeys } from './chargeback.js';

const d = (iso: string): Date => new Date(iso);

/**
 * wholeMonthKeys is the gate for the enforcement-counter reconciliation arm (audit M42): the arm may
 * only fire when the report window is exactly whole UTC months, else the per-day/rolling counter rows
 * would over-count. A boundary bug here either raises false 'counter ledger drift' on normal reports
 * or hides a genuine divergence — both erode trust in the money path, so it's unit-pinned.
 */
describe('wholeMonthKeys — month-alignment gate (audit M42)', () => {
  it('exact single whole month → the one month key', () => {
    expect(wholeMonthKeys(d('2026-06-01T00:00:00.000Z'), d('2026-07-01T00:00:00.000Z'))).toEqual([
      '2026-06',
    ]);
  });

  it('multi-month whole window → every month key, in order, incl. a year rollover', () => {
    expect(wholeMonthKeys(d('2026-11-01T00:00:00.000Z'), d('2027-02-01T00:00:00.000Z'))).toEqual([
      '2026-11',
      '2026-12',
      '2027-01',
    ]);
  });

  it('start not on a month boundary → null (arm skipped)', () => {
    expect(wholeMonthKeys(d('2026-06-02T00:00:00.000Z'), d('2026-07-01T00:00:00.000Z'))).toBeNull();
  });

  it('end not on a month boundary (the now+1s / MTD case) → null', () => {
    expect(wholeMonthKeys(d('2026-06-01T00:00:00.000Z'), d('2026-06-15T12:00:00.000Z'))).toBeNull();
  });

  it('a non-midnight boundary (off by a second) → null, never a false alignment', () => {
    expect(wholeMonthKeys(d('2026-06-01T00:00:01.000Z'), d('2026-07-01T00:00:00.000Z'))).toBeNull();
  });

  it('inverted / empty range → null', () => {
    expect(wholeMonthKeys(d('2026-07-01T00:00:00.000Z'), d('2026-06-01T00:00:00.000Z'))).toBeNull();
    expect(wholeMonthKeys(d('2026-06-01T00:00:00.000Z'), d('2026-06-01T00:00:00.000Z'))).toBeNull();
  });
});
