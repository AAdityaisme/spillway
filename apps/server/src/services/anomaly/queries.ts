import { sql } from 'drizzle-orm';
import { parseUsd } from '@spillway/pricing';
import type { Tx } from '../../db/tenancy.js';
import type { AnomalyScope } from './baseline.js';

/**
 * Anomaly/forecast SQL primitives (Part II §19 §2/§3/§4). Each function is one fetch — the hourly
 * anomaly-scan job composes them. `now` is threaded in explicitly (never `now()` inside the SQL) so a
 * single run scans against one consistent instant and the primitives are deterministically testable.
 */

export interface OrgScope extends AnomalyScope {
  orgId: string;
}

function utcPeriodKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** §2.4/§2.5 weekday-median sample fetch. Self-poison NOT-IN excludes any day this scope already
 * fired an `anomaly` event for (forecast/confirmed events don't poison). ORDER BY DESC LIMIT 4. */
export async function fetchWeekdaySamples(tx: Tx, scope: OrgScope, now: Date): Promise<bigint[]> {
  const todayKey = utcPeriodKey(now);
  const dow = now.getUTCDay();
  const rows = (await tx.execute(sql`
    SELECT spent_usd FROM spend_counters
    WHERE scope_type = ${scope.scopeType} AND scope_id = ${scope.scopeId}
      AND period_key ~ '^\\d{4}-\\d{2}-\\d{2}$' AND period_key < ${todayKey}
      AND EXTRACT(DOW FROM period_key::date) = ${dow}
      AND period_key NOT IN (
        SELECT ae.payload->>'period_key' FROM alert_events ae
        WHERE ae.org_id = ${scope.orgId} AND ae.payload->>'event_type' = 'anomaly'
          AND ae.payload->>'scope_type' = ${scope.scopeType}
          AND ae.payload->>'scope_id' = ${scope.scopeId}::text
          AND ae.payload->>'period_key' IS NOT NULL)
    ORDER BY period_key DESC LIMIT 4`)) as unknown as { spent_usd: string }[];
  return rows.map((r) => parseUsd(r.spent_usd));
}

/** §2.4 flat-mean sample fetch — weekday fetch minus the DOW predicate, LIMIT 7. */
export async function fetchFlatMeanSamples(tx: Tx, scope: OrgScope, now: Date): Promise<bigint[]> {
  const todayKey = utcPeriodKey(now);
  const rows = (await tx.execute(sql`
    SELECT spent_usd FROM spend_counters
    WHERE scope_type = ${scope.scopeType} AND scope_id = ${scope.scopeId}
      AND period_key ~ '^\\d{4}-\\d{2}-\\d{2}$' AND period_key < ${todayKey}
      AND period_key NOT IN (
        SELECT ae.payload->>'period_key' FROM alert_events ae
        WHERE ae.org_id = ${scope.orgId} AND ae.payload->>'event_type' = 'anomaly'
          AND ae.payload->>'scope_type' = ${scope.scopeType}
          AND ae.payload->>'scope_id' = ${scope.scopeId}::text
          AND ae.payload->>'period_key' IS NOT NULL)
    ORDER BY period_key DESC LIMIT 7`)) as unknown as { spent_usd: string }[];
  return rows.map((r) => parseUsd(r.spent_usd));
}

/** §2.3 per-scope completed-day history count — drives selectBaselineMode. */
export async function fetchHistoryDays(tx: Tx, scope: AnomalyScope, now: Date): Promise<number> {
  const todayKey = utcPeriodKey(now);
  const rows = (await tx.execute(sql`
    SELECT count(DISTINCT period_key)::int AS history_days FROM spend_counters
    WHERE scope_type = ${scope.scopeType} AND scope_id = ${scope.scopeId}
      AND period_key ~ '^\\d{4}-\\d{2}-\\d{2}$' AND period_key < ${todayKey}`)) as unknown as {
    history_days: number;
  }[];
  return rows[0]?.history_days ?? 0;
}

/** §2.6 today-counter read — a scope with no row today reads as 0, not an error. */
export async function fetchTodayCounterMicro(
  tx: Tx,
  scope: AnomalyScope,
  now: Date,
): Promise<bigint> {
  const todayKey = utcPeriodKey(now);
  const rows = (await tx.execute(sql`
    SELECT COALESCE(spent_usd, 0) AS today_usd FROM spend_counters
    WHERE scope_type = ${scope.scopeType} AND scope_id = ${scope.scopeId}
      AND period_key = ${todayKey}`)) as unknown as { today_usd: string }[];
  return rows[0] ? parseUsd(rows[0].today_usd) : 0n;
}

/** §4.1 trailing run-rate sample fetch — last `windowDays` completed day-rows (default 3). */
export async function fetchRunRateSamples(
  tx: Tx,
  scope: AnomalyScope,
  now: Date,
  windowDays = 3,
): Promise<bigint[]> {
  const todayKey = utcPeriodKey(now);
  const rows = (await tx.execute(sql`
    SELECT spent_usd FROM spend_counters
    WHERE scope_type = ${scope.scopeType} AND scope_id = ${scope.scopeId}
      AND period_key ~ '^\\d{4}-\\d{2}-\\d{2}$' AND period_key < ${todayKey}
    ORDER BY period_key DESC LIMIT ${windowDays}`)) as unknown as { spent_usd: string }[];
  return rows.map((r) => parseUsd(r.spent_usd));
}

/** §3.2(a) — did a `burst` event fire today (UTC) for this key? The short-window half of the gate. */
export async function fetchBurstFiredToday(
  tx: Tx,
  orgId: string,
  virtualKeyId: string,
  now: Date,
): Promise<boolean> {
  const dayStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  ).toISOString();
  const rows = (await tx.execute(sql`
    SELECT 1 FROM alert_events
    WHERE org_id = ${orgId} AND payload->>'event_type' = 'burst'
      AND payload->>'virtual_key_id' = ${virtualKeyId} AND fired_at >= ${dayStart}
    LIMIT 1`)) as unknown as unknown[];
  return rows.length > 0;
}

/** §3.2(b) hours elapsed today (UTC), always >0 (utc_hour=0 is skipped upstream, §2.2). */
export function hoursElapsedUtc(now: Date): number {
  const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return (now.getTime() - dayStart) / 1000 / 3600;
}

/** §3.2(b) projected end-of-day spend at the current run rate. */
export function projectedEodMicro(todayMicro: bigint, hoursElapsed: number): bigint {
  return BigInt(Math.round(Number(todayMicro) * (24 / hoursElapsed)));
}

/** §3.2(b) gate — reuses this scope's normal anomaly fire threshold (don't recompute the baseline). */
export function gateB(projectedEodMicroValue: bigint, fireThresholdMicroValue: bigint): boolean {
  return projectedEodMicroValue > fireThresholdMicroValue;
}

export interface ConfirmedGateResult {
  gateA: boolean;
  gateB: boolean;
  fireConfirmed: boolean;
  projectedEodMicro: bigint;
  hoursElapsed: number;
}

/** §3.2 full AND-gate for one key: gate_a (a burst fired today) AND gate_b (projected EOD exceeds
 * the scope's anomaly fire threshold). */
export async function evaluateConfirmedGate(
  tx: Tx,
  orgId: string,
  virtualKeyId: string,
  now: Date,
  todayMicro: bigint,
  fireThresholdMicroValue: bigint,
): Promise<ConfirmedGateResult> {
  const gateAResult = await fetchBurstFiredToday(tx, orgId, virtualKeyId, now);
  const hoursElapsed = hoursElapsedUtc(now);
  const projected = projectedEodMicro(todayMicro, hoursElapsed);
  const gateBResult = gateB(projected, fireThresholdMicroValue);
  return {
    gateA: gateAResult,
    gateB: gateBResult,
    fireConfirmed: gateAResult && gateBResult,
    projectedEodMicro: projected,
    hoursElapsed,
  };
}

/** §3.3 dedupe key — one `anomaly_confirmed` fire per key per UTC day. */
export function confirmedDedupeKey(virtualKeyId: string, todayPeriodKey: string): string {
  return `anomaly_confirmed:${virtualKeyId}:${todayPeriodKey}`;
}
