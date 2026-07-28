import { describe, expect, it } from 'vitest';
import {
  compactUsd,
  formatCount,
  keyPrefix,
  monthLabel,
  pct,
  recentMonths,
  usd,
} from './format.js';

describe('usd', () => {
  it('formats decimal strings to 2dp', () => {
    expect(usd('1234.567890')).toBe('$1,234.57');
    expect(usd('0.836000')).toBe('$0.84');
  });
  it('keeps sub-cent values precise instead of rounding to $0.00', () => {
    expect(usd('0.0018')).toBe('$0.0018');
  });
  it('honors precise mode', () => {
    expect(usd('0.020000', { precise: true })).toBe('$0.0200');
  });
  it('renders em dash for null/undefined/garbage', () => {
    expect(usd(null)).toBe('—');
    expect(usd(undefined)).toBe('—');
    expect(usd('not-money')).toBe('—');
  });
});

describe('compactUsd', () => {
  it('compacts thousands and millions', () => {
    expect(compactUsd('12400')).toBe('$12.4k');
    expect(compactUsd('1200000')).toBe('$1.2M');
  });
  it('passes small values through to usd()', () => {
    expect(compactUsd('99.5')).toBe('$99.50');
  });
});

describe('formatCount', () => {
  it('abbreviates counts', () => {
    expect(formatCount(999)).toBe('999');
    expect(formatCount(1234)).toBe('1.2k');
    expect(formatCount(2_500_000)).toBe('2.5M');
    expect(formatCount(null)).toBe('—');
  });
});

describe('pct / monthLabel / keyPrefix', () => {
  it('formats API-computed percentages', () => {
    expect(pct(13.33)).toBe('13.3%');
    expect(pct(null)).toBe('—');
  });
  it('labels periods', () => {
    expect(monthLabel('2026-07')).toBe('July 2026');
    expect(monthLabel('garbage')).toBe('garbage');
  });
  it('ellipsizes key prefixes', () => {
    expect(keyPrefix('mk-live-Ab3d')).toBe('mk-live-Ab3d…');
    expect(keyPrefix(null)).toBe('—');
  });
});

describe('recentMonths', () => {
  it('returns YYYY-MM values newest first', () => {
    const months = recentMonths(3);
    expect(months).toHaveLength(3);
    for (const m of months) expect(m).toMatch(/^\d{4}-\d{2}$/);
    expect(months[0]! > months[2]!).toBe(true);
  });
});
