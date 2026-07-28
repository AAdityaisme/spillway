import { sql } from 'drizzle-orm';
import type { Tx } from '../../db/tenancy.js';
import {
  computeBaseline,
  selectBaselineMode,
  resolveWeekdaySampleCount,
  fireThresholdMicro,
  anomalyFires,
  ratio,
  severityForRatio,
  dataQuality,
  effectiveSeverity,
  isUtcMidnightSkip,
  anomalyDedupeKey,
  type AnomalyFireConfig,
  type Baseline,
  type BaselineMethod,
  type Severity,
} from './baseline.js';
import {
  fetchWeekdaySamples,
  fetchFlatMeanSamples,
  fetchHistoryDays,
  fetchTodayCounterMicro,
  evaluateConfirmedGate,
  confirmedDedupeKey,
  type OrgScope,
} from './queries.js';

/**
 * Per-scope anomaly evaluation + fire (Part II §19 §2). Composes the SQL primitives + pure math for ONE
 * scope against one instant `now`. The hourly cron that enumerates scopes cross-org (asJobs) and calls
 * this per scope is the scheduler-wiring seam (deferred, like the poller cron); this is the unit the
 * loop body runs and the piece worth testing deterministically.
 */

export interface AnomalyEvaluation {
  fires: boolean;
  reason?: 'midnight_skip' | 'excluded' | 'no_samples' | 'under_threshold';
  severity?: Severity;
  ratio?: number;
  thresholdMicro?: bigint;
  todayMicro?: bigint;
  baseline?: Baseline;
}

function utcPeriodKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function evaluateAnomalyForScope(
  tx: Tx,
  scope: OrgScope,
  now: Date,
  config: AnomalyFireConfig,
): Promise<AnomalyEvaluation> {
  if (isUtcMidnightSkip(now)) return { fires: false, reason: 'midnight_skip' }; // §2.2

  const historyDays = await fetchHistoryDays(tx, scope, now);
  const mode = selectBaselineMode(historyDays);
  if (mode === 'excluded') return { fires: false, reason: 'excluded' };

  let samples: bigint[];
  let method: BaselineMethod;
  if (mode === 'weekday_median') {
    const weekday = await fetchWeekdaySamples(tx, scope, now);
    if (resolveWeekdaySampleCount(weekday.length) === 'use_weekday') {
      samples = weekday;
      method = 'weekday_median';
    } else {
      samples = await fetchFlatMeanSamples(tx, scope, now); // §2.3 sparse-weekday fallback
      method = 'flat_mean_7d';
    }
  } else {
    samples = await fetchFlatMeanSamples(tx, scope, now);
    method = 'flat_mean_7d';
  }
  if (samples.length === 0) return { fires: false, reason: 'no_samples' };

  const baseline = computeBaseline(samples, method);
  const todayMicro = await fetchTodayCounterMicro(tx, scope, now);
  const thresholdMicro = fireThresholdMicro(baseline.baselineMicro, config);
  if (!anomalyFires(todayMicro, thresholdMicro)) {
    return { fires: false, reason: 'under_threshold', thresholdMicro, todayMicro, baseline };
  }
  const r = ratio(todayMicro, baseline.baselineMicro);
  const { confidence } = dataQuality(baseline); // MAD caps urgency, never gates detection (§2.6)
  const severity = effectiveSeverity(severityForRatio(r), confidence);
  return { fires: true, severity, ratio: r, thresholdMicro, todayMicro, baseline };
}

/**
 * Evaluate + (on fire) write the deduped `anomaly` alert_event — one per (scope, day). The payload
 * carries the shape the automation matcher reads (event_type/scope/period_key/ratio). Returns the
 * evaluation. Runs inside the caller's withOrg tx.
 *
 * For virtual_key scopes that fire anomaly, also evaluates the §3.2 AND-gate (burst fired today AND
 * projected EOD exceeds threshold) and emits an `anomaly_confirmed` event when both conditions hold
 * (M35 — previously defined in queries.ts but never invoked by a producer).
 */
export async function runAnomalyScanForScope(
  tx: Tx,
  scope: OrgScope,
  now: Date,
  config: AnomalyFireConfig,
): Promise<AnomalyEvaluation> {
  const evaluation = await evaluateAnomalyForScope(tx, scope, now, config);
  if (!evaluation.fires) return evaluation;
  const periodKey = utcPeriodKey(now);
  const payload = {
    event_type: 'anomaly',
    scope_type: scope.scopeType,
    scope_id: scope.scopeId,
    period_key: periodKey,
    ratio: evaluation.ratio,
    severity: evaluation.severity,
    today_usd: String(evaluation.todayMicro),
  };
  await tx.execute(sql`
    insert into alert_events (org_id, alert_id, fired_at, dedupe_key, payload)
    values (${scope.orgId}, null, now(), ${anomalyDedupeKey(scope, periodKey)},
            ${JSON.stringify(payload)}::jsonb)
    on conflict (alert_id, dedupe_key) do nothing`);

  // §3.2 confirmed AND-gate: only meaningful for virtual_key scopes (burst events carry a
  // virtual_key_id). If the burst-today gate AND the projected-EOD gate both pass, emit a
  // deduped `anomaly_confirmed` event — one per (key, day). (M35)
  if (
    scope.scopeType === 'virtual_key' &&
    evaluation.todayMicro !== undefined &&
    evaluation.thresholdMicro !== undefined
  ) {
    const confirmed = await evaluateConfirmedGate(
      tx,
      scope.orgId,
      scope.scopeId,
      now,
      evaluation.todayMicro,
      evaluation.thresholdMicro,
    );
    if (confirmed.fireConfirmed) {
      const confirmedPayload = {
        event_type: 'anomaly_confirmed',
        scope_type: scope.scopeType,
        scope_id: scope.scopeId,
        period_key: periodKey,
        // 19 §3: the AND-gated confirmed signal is ALWAYS critical (high-confidence) and is NOT
        // subject to the low-confidence severity cap that modulates the plain `anomaly` event.
        severity: 'critical' as const,
        projected_eod_usd: String(confirmed.projectedEodMicro),
        hours_elapsed: confirmed.hoursElapsed,
        today_usd: String(evaluation.todayMicro),
      };
      await tx.execute(sql`
        insert into alert_events (org_id, alert_id, fired_at, dedupe_key, payload)
        values (${scope.orgId}, null, now(), ${confirmedDedupeKey(scope.scopeId, periodKey)},
                ${JSON.stringify(confirmedPayload)}::jsonb)
        on conflict (alert_id, dedupe_key) do nothing`);
    }
  }

  return evaluation;
}
