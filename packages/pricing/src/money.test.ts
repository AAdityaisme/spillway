import { describe, it, expect } from 'vitest';
import { parseUsd, parseNonNegativeUsd, formatUsd, addUsd, subUsd, compareUsd } from './money.js';

describe('money (decimal-safe USD — ADR-019e)', () => {
  it('parses decimal strings into exact micro-USD', () => {
    expect(parseUsd('1')).toBe(1_000_000n);
    expect(parseUsd('0.000001')).toBe(1n);
    expect(parseUsd('20.00')).toBe(20_000_000n);
    expect(parseUsd('-3.5')).toBe(-3_500_000n);
  });

  it('truncates beyond 6 dp without float drift', () => {
    expect(parseUsd('0.0000019')).toBe(1n); // 7th decimal dropped, no rounding-up bug
  });

  it('round-trips through formatUsd at fixed precision', () => {
    expect(formatUsd(parseUsd('12.34'))).toBe('12.340000');
    expect(formatUsd(parseUsd('0.1'))).toBe('0.100000');
    expect(formatUsd(-3_500_000n)).toBe('-3.500000');
  });

  it('accumulates without the 0.1 + 0.2 float problem', () => {
    const sum = addUsd(parseUsd('0.1'), parseUsd('0.2'));
    expect(formatUsd(sum)).toBe('0.300000');
  });

  it('compares exactly at the budget-enforcement boundary', () => {
    const spent = parseUsd('20.000000');
    const limit = parseUsd('20.000000');
    expect(compareUsd(spent, limit)).toBe(0); // spent >= limit → blocked
    expect(compareUsd(addUsd(spent, 1n), limit)).toBe(1);
    expect(compareUsd(subUsd(spent, 1n), limit)).toBe(-1);
  });

  it('accepts JS numbers via fixed-precision conversion', () => {
    expect(parseUsd(20)).toBe(20_000_000n);
    expect(() => parseUsd(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it('rejects malformed input', () => {
    expect(() => parseUsd('abc')).toThrow(RangeError);
    expect(() => parseUsd('1.2.3')).toThrow(RangeError);
  });

  // ── L44: parseNonNegativeUsd — price field boundary ──────────────────────────
  describe('parseNonNegativeUsd (L44)', () => {
    it('parses zero and positive amounts', () => {
      expect(parseNonNegativeUsd('0')).toBe(0n);
      expect(parseNonNegativeUsd('1.5')).toBe(1_500_000n);
      expect(parseNonNegativeUsd('0.000001')).toBe(1n);
    });

    it('rejects negative price strings — typo/attack would create credits', () => {
      expect(() => parseNonNegativeUsd('-1.0')).toThrow(RangeError);
      expect(() => parseNonNegativeUsd('-0.000001')).toThrow(RangeError);
    });

    it('rejects malformed input the same way parseUsd does', () => {
      expect(() => parseNonNegativeUsd('abc')).toThrow(RangeError);
    });
  });
});
