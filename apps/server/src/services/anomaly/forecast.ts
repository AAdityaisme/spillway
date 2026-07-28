/**
 * Budget forecast math (19 §4; ADR-040). Pure functions only — no I/O. `days_remaining` is a
 * float (fractional days); every bigint x float product goes through Number+Math.round, same
 * discipline the spec's own `projected = mtd + BigInt(Math.round(...))` formula uses (§4.1) —
 * never `parseFloat` on a money value itself.
 */

import type { AnomalyScope } from './baseline.js';

/** Cold-start floor (§4.1): fewer than 3 completed day-rows → no reliable run rate. */
export const MIN_RUN_RATE_SAMPLES = 3;

export function hasSufficientRunRateHistory(samplesMicro: bigint[]): boolean {
  return samplesMicro.length >= MIN_RUN_RATE_SAMPLES;
}

/** 3-day (or configured window) trailing mean of completed day-rows. */
export function dailyRunRateMicro(samplesMicro: bigint[]): bigint {
  if (samplesMicro.length === 0)
    throw new RangeError('dailyRunRateMicro requires at least one sample');
  return samplesMicro.reduce((a, b) => a + b, 0n) / BigInt(samplesMicro.length);
}

/** Days in `now`'s UTC calendar month (day 0 of next month = last day of this month). */
export function daysInMonthUtc(now: Date): number {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
}

/** Fraction of today (UTC) already elapsed, 0..1. */
export function fracTodayDoneUtc(now: Date): number {
  const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return (now.getTime() - dayStart) / 86_400_000;
}

/** §4.1 partial-day days_remaining: whole future days + the UN-ELAPSED fraction of today —
 * `mtd_micro` already holds today's partial spend, so this must not double-count or drop it. */
export function daysRemainingUtc(now: Date): number {
  const daysInPeriod = daysInMonthUtc(now);
  const dayOfMonth = now.getUTCDate();
  return daysInPeriod - dayOfMonth + (1 - fracTodayDoneUtc(now));
}

/** §4.1 projected end-of-month spend: mtd + trailing rate x remaining (fractional) days. */
export function projectedEomMicro(
  mtdMicro: bigint,
  dailyRunRateMicroValue: bigint,
  daysRemaining: number,
): bigint {
  return mtdMicro + BigInt(Math.round(Number(dailyRunRateMicroValue) * daysRemaining));
}

/** §4.2 fire condition — silent once mtd already reached the limit; `budget_threshold` (17)
 * owns that state so the two signals never double-fire on the same crossing. */
export function forecastFires(
  mtdMicro: bigint,
  projectedEomMicroValue: bigint,
  limitMicro: bigint,
  buffer: number,
): boolean {
  const bufferedLimitMicro = BigInt(Math.round(Number(limitMicro) * buffer));
  return mtdMicro < limitMicro && projectedEomMicroValue > bufferedLimitMicro;
}

/** §4.2 overshoot-date — only meaningful when `forecastFires` is true (guarantees the day
 * lands on or before month end, per the invariant in §4.2; the clamp is a documented safety net). */
export function overshootDay(
  now: Date,
  remainingBudgetMicro: bigint,
  dailyRunRateMicroValue: bigint,
  daysInPeriod: number,
): number {
  const daysToOvershoot = Number(remainingBudgetMicro) / Number(dailyRunRateMicroValue);
  const overshootDate = new Date(now.getTime() + daysToOvershoot * 86_400_000);
  return Math.min(overshootDate.getUTCDate(), daysInPeriod);
}

/** 'YYYY-MM' — the `period_key` a `budget_forecast` event dedupes against (§4.3). */
export function monthPeriodKey(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** §4.3 dedupe key — fire-once-per-scope-per-month. A cleared-then-recrossed projection does
 * not re-fire the same month because this key is identical for both scans. */
export function forecastDedupeKey(scope: AnomalyScope, monthKey: string): string {
  return `budget_forecast:${scope.scopeType}:${scope.scopeId}:${monthKey}`;
}
