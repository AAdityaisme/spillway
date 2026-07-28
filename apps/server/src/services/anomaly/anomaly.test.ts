import { describe, it, expect } from 'vitest';
import {
  median,
  computeBaseline,
  severityForRatio,
  dataQuality,
  effectiveSeverity,
  ratio,
  fireThresholdMicro,
  anomalyFires,
  selectBaselineMode,
  resolveWeekdaySampleCount,
  isUtcMidnightSkip,
  anomalyDedupeKey,
} from './baseline.js';
import {
  hasSufficientRunRateHistory,
  dailyRunRateMicro,
  daysRemainingUtc,
  projectedEomMicro,
  forecastFires,
  monthPeriodKey,
  forecastDedupeKey,
} from './forecast.js';
import { hoursElapsedUtc, projectedEodMicro, gateB, confirmedDedupeKey } from './queries.js';

const usd = (n: number): bigint => BigInt(Math.round(n * 1_000_000));

/** Anomaly v2 math (Part II §19 §2/§4; ADR-040) — the §10 bands, pure. */
describe('anomaly baseline (§2)', () => {
  it('median: odd exact, even floor-mean', () => {
    expect(median([usd(1), usd(3), usd(2)])).toBe(usd(2));
    expect(median([usd(2), usd(4)])).toBe(usd(3));
  });

  it('weekday_median computes MAD + robust CV; flat_mean skips MAD', () => {
    const wm = computeBaseline([usd(10), usd(12), usd(11), usd(100)], 'weekday_median');
    expect(wm.method).toBe('weekday_median');
    expect(wm.madMicro).toBeGreaterThan(0n);
    const fm = computeBaseline([usd(10), usd(20)], 'flat_mean_7d');
    expect(fm.madMicro).toBe(0n);
    expect(fm.baselineMicro).toBe(usd(15));
  });

  it('severity bands 3-5 info / 5-10 warning / >10 critical', () => {
    expect(severityForRatio(4)).toBe('info');
    expect(severityForRatio(5)).toBe('warning');
    expect(severityForRatio(11)).toBe('critical');
  });

  it('a noisy baseline (high MAD) caps a critical down to warning', () => {
    // spread sample → MAD/baseline ≈ 0.74 > 0.5 → noisy → low confidence
    const noisy = computeBaseline([usd(10), usd(20), usd(40), usd(80)], 'weekday_median');
    expect(noisy.madRatio).toBeGreaterThan(0.5);
    const { confidence } = dataQuality(noisy);
    expect(confidence).toBe('low');
    expect(effectiveSeverity('critical', confidence)).toBe('warning');
  });

  it('fire threshold = max(multiplier×baseline, min_usd); strictly-exceeds fires', () => {
    const t = fireThresholdMicro(usd(10), { multiplier: 3, minUsdMicro: usd(5) });
    expect(t).toBe(usd(30));
    expect(anomalyFires(usd(31), t)).toBe(true);
    expect(anomalyFires(usd(30), t)).toBe(false);
    // min_usd floor dominates a tiny baseline
    expect(fireThresholdMicro(usd(0.5), { multiplier: 3, minUsdMicro: usd(5) })).toBe(usd(5));
  });

  it('baseline mode by history; sparse weekday falls back to flat mean', () => {
    expect(selectBaselineMode(5)).toBe('excluded');
    expect(selectBaselineMode(14)).toBe('flat_mean_7d');
    expect(selectBaselineMode(30)).toBe('weekday_median');
    expect(resolveWeekdaySampleCount(1)).toBe('fallback_flat_mean');
    expect(resolveWeekdaySampleCount(2)).toBe('use_weekday');
  });

  it('UTC-midnight hour skips the anomaly step; ratio + dedupe key', () => {
    expect(isUtcMidnightSkip(new Date('2026-07-07T00:30:00Z'))).toBe(true);
    expect(isUtcMidnightSkip(new Date('2026-07-07T09:00:00Z'))).toBe(false);
    expect(ratio(usd(30), usd(10))).toBe(3);
    expect(ratio(usd(1), 0n)).toBe(Number.POSITIVE_INFINITY);
    expect(anomalyDedupeKey({ scopeType: 'org', scopeId: 'o1' }, '2026-07-07')).toBe(
      'anomaly:org:o1:2026-07-07',
    );
  });
});

describe('anomaly forecast (§4)', () => {
  it('cold-start floor: <3 completed days → no run rate', () => {
    expect(hasSufficientRunRateHistory([usd(1), usd(2)])).toBe(false);
    expect(hasSufficientRunRateHistory([usd(1), usd(2), usd(3)])).toBe(true);
    expect(dailyRunRateMicro([usd(3), usd(6), usd(9)])).toBe(usd(6));
  });

  it('projects EOM and fires only when projected exceeds the buffered limit (mtd under limit)', () => {
    const now = new Date('2026-07-15T12:00:00Z'); // ~15.5 days remaining in a 31-day month
    const remaining = daysRemainingUtc(now);
    expect(remaining).toBeGreaterThan(15);
    expect(remaining).toBeLessThan(17);
    const projected = projectedEomMicro(usd(500), usd(100), remaining);
    expect(projected).toBeGreaterThan(usd(2000));
    expect(forecastFires(usd(500), projected, usd(1000), 0.9)).toBe(true);
    // already at/over the limit → silent (budget_threshold owns that crossing)
    expect(forecastFires(usd(1000), projected, usd(1000), 0.9)).toBe(false);
  });

  it('forecast dedupe key is per-scope-per-month', () => {
    expect(monthPeriodKey(new Date('2026-07-15T12:00:00Z'))).toBe('2026-07');
    expect(forecastDedupeKey({ scopeType: 'team', scopeId: 't1' }, '2026-07')).toBe(
      'budget_forecast:team:t1:2026-07',
    );
  });
});

/** §3.2 anomaly_confirmed AND-gate — pure helpers (M35). */
describe('anomaly_confirmed gate (§3.2, M35)', () => {
  it('hoursElapsedUtc returns fractional hours since UTC midnight', () => {
    // 09:00 UTC → 9 hours elapsed exactly
    expect(hoursElapsedUtc(new Date('2026-07-07T09:00:00Z'))).toBeCloseTo(9, 5);
    // 12:30 UTC → 12.5 hours
    expect(hoursElapsedUtc(new Date('2026-07-07T12:30:00Z'))).toBeCloseTo(12.5, 5);
  });

  it('projectedEodMicro scales today spend by (24 / hoursElapsed)', () => {
    // $100 spent in 12 hours → projected $200 EOD
    const today = usd(100);
    const projected = projectedEodMicro(today, 12);
    expect(projected).toBe(usd(200));
  });

  it('gateB fires when projected exceeds the threshold, not fires at or below', () => {
    const threshold = usd(500);
    expect(gateB(usd(501), threshold)).toBe(true);
    expect(gateB(usd(500), threshold)).toBe(false);
    expect(gateB(usd(499), threshold)).toBe(false);
  });

  it('confirmedDedupeKey is per virtual-key per day', () => {
    expect(confirmedDedupeKey('vk-1', '2026-07-07')).toBe('anomaly_confirmed:vk-1:2026-07-07');
    expect(confirmedDedupeKey('vk-2', '2026-07-08')).toBe('anomaly_confirmed:vk-2:2026-07-08');
  });
});
