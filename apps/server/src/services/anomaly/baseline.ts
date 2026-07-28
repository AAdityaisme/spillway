/**
 * Anomaly v2 baseline math (19 §2.3/§2.4/§2.6/§2.7/§2.8; ADR-040). Pure functions only — no
 * I/O. Money stays bigint micro-USD end to end (`money.ts` rule); the only floats are the MAD
 * robust-CV ratio and the customer-facing `ratio`/ severity bands, which are unitless.
 */

export type ScopeType = 'org' | 'team' | 'virtual_key' | 'provider';

export interface AnomalyScope {
  scopeType: ScopeType;
  scopeId: string;
}

export type BaselineMethod = 'weekday_median' | 'flat_mean_7d';

export interface Baseline {
  baselineMicro: bigint;
  madMicro: bigint; // 0n in flat-mean mode (MAD not computed, §2.4)
  madRatio: number; // 1.4826 * mad / baseline (robust CV); 0 if baseline 0 or flat-mean
  sampleCount: number;
  method: BaselineMethod;
}

export type Severity = 'info' | 'warning' | 'critical';

/** Median of a non-empty bigint (micro-USD) sample. Even count → floor-mean of the two middles. */
export function median(values: bigint[]): bigint {
  if (values.length === 0) throw new RangeError('median requires at least one sample');
  const s = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const n = s.length;
  const mid = n >> 1;
  // n odd: middle element is exact by construction; even: both middles exist (n>=2).
  return n % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2n;
}

/** Median Absolute Deviation about a given median (micro-USD). */
export function mad(values: bigint[], med: bigint): bigint {
  return median(values.map((v) => (v >= med ? v - med : med - v)));
}

/** §2.4 — weekday-median mode takes the raw median + MAD; flat-mean mode (7-27 day transition,
 * or the sparse-history fallback) skips MAD entirely (madMicro=0n, madRatio=0). */
export function computeBaseline(samplesMicro: bigint[], method: BaselineMethod): Baseline {
  if (samplesMicro.length === 0)
    throw new RangeError('computeBaseline requires at least one sample');
  const baselineMicro =
    method === 'weekday_median'
      ? median(samplesMicro)
      : samplesMicro.reduce((a, b) => a + b, 0n) / BigInt(samplesMicro.length);
  const madMicro = method === 'weekday_median' ? mad(samplesMicro, baselineMicro) : 0n;
  const madRatio =
    method === 'weekday_median' && baselineMicro > 0n
      ? (1.4826 * Number(madMicro)) / Number(baselineMicro)
      : 0;
  return { baselineMicro, madMicro, madRatio, sampleCount: samplesMicro.length, method };
}

/** Ratio bands (ADR-040): 3-5x info, 5-10x warning, >10x critical. */
export function severityForRatio(ratio: number): Severity {
  if (ratio > 10) return 'critical';
  if (ratio >= 5) return 'warning';
  return 'info';
}

/** MAD data-quality modulation: a corrupted (noisy) baseline may not page critical. */
export function dataQuality(b: Baseline): {
  quality: 'stable' | 'noisy';
  confidence: 'high' | 'low';
} {
  const noisy = b.method === 'weekday_median' && b.madRatio > 0.5;
  const confidence: 'high' | 'low' = noisy || b.sampleCount < 4 ? 'low' : 'high';
  return { quality: noisy ? 'noisy' : 'stable', confidence };
}

/** A low-confidence (noisy/sparse) baseline is capped one tier below critical. MAD never gates
 * detection (§2.6) — it only caps delivery urgency here. */
export function effectiveSeverity(raw: Severity, confidence: 'high' | 'low'): Severity {
  return confidence === 'low' && raw === 'critical' ? 'warning' : raw;
}

/** today_usd / baseline_usd, 2dp (§2.7). A zero baseline (min_usd floor firing alone) has no
 * finite ratio — the caller decides how to render that edge; this never throws. */
export function ratio(todayMicro: bigint, baselineMicro: bigint): number {
  if (baselineMicro <= 0n) return Number.POSITIVE_INFINITY;
  return Math.round((Number(todayMicro) / Number(baselineMicro)) * 100) / 100;
}

export interface AnomalyFireConfig {
  multiplier: number; // alerts.config for kind='anomaly', default 3
  minUsdMicro: bigint; // default $5
}

/** §2.6 fire threshold — max(multiplier x baseline, min_usd). MAD does NOT gate this (§2.6);
 * multiplier x baseline is computed via Number because multiplier is a float config value. */
export function fireThresholdMicro(baselineMicro: bigint, config: AnomalyFireConfig): bigint {
  const scaled = BigInt(Math.round(Number(baselineMicro) * config.multiplier));
  return scaled > config.minUsdMicro ? scaled : config.minUsdMicro;
}

/** §2.6 fire condition: today's counter strictly exceeds the threshold. */
export function anomalyFires(todayMicro: bigint, thresholdMicro: bigint): boolean {
  return todayMicro > thresholdMicro;
}

/** §2.3 baseline-mode table. A property of history_days, recomputed every run — never stored. */
export type BaselineMode = 'excluded' | 'flat_mean_7d' | 'weekday_median';

export function selectBaselineMode(historyDays: number): BaselineMode {
  if (historyDays < 7) return 'excluded';
  if (historyDays < 28) return 'flat_mean_7d';
  return 'weekday_median';
}

export type WeekdaySampleDecision = 'use_weekday' | 'fallback_flat_mean';

/** §2.3 sparse-history fallback: fewer than 2 surviving same-weekday samples (post self-poison
 * exclusion, §2.5) abandons weekday-median for this run — never fire off a single-sample
 * baseline. >=2 survivors use the median as usual; `dataQuality` already caps confidence low
 * at sampleCount<4, so no separate "low-confidence" branch is needed here. */
export function resolveWeekdaySampleCount(survivingSampleCount: number): WeekdaySampleDecision {
  return survivingSampleCount >= 2 ? 'use_weekday' : 'fallback_flat_mean';
}

/** §2.2 — at utc_hour=0 today's day-counter is near-zero regardless of real usage, so the
 * anomaly + anomaly_confirmed steps skip. Forecast (§4) has no such gate: it depends on
 * completed prior days and mtd, both stable at midnight. */
export function isUtcMidnightSkip(now: Date): boolean {
  return now.getUTCHours() === 0;
}

/** §2.8 dedupe key — one fire per (scope, day) per calendar day. */
export function anomalyDedupeKey(scope: AnomalyScope, todayPeriodKey: string): string {
  return `anomaly:${scope.scopeType}:${scope.scopeId}:${todayPeriodKey}`;
}
