import { sql } from 'drizzle-orm';
import type { Tx } from '../../db/tenancy.js';

/**
 * Error-rate alert producer (13-build-order §M5.3; 19 §5 registry kind `error_rate`). A user-configured
 * `error_rate` alert fires when an org's request error rate over a trailing window crosses a threshold.
 *
 * The kind registry marks the producer 'reconcile', but a WINDOWED rate is inherently periodic (you
 * cannot decide "≥10% over the last 15 min" from a single reconcile), so it runs on the same leased
 * hourly scan cadence as anomaly detection (scheduler runAnomalyScanJob). Firing mirrors the anomaly
 * producer: an `alert_events` row keyed by (alert_id, dedupe_key) — the window bucket dedupes repeats.
 */

export interface ErrorRateConfig {
  threshold_pct: number; // fire when error rate ≥ this
  window_minutes: number; // trailing evaluation window
  min_requests: number; // sample floor — never fire on a handful of requests
}

const DEFAULTS: ErrorRateConfig = { threshold_pct: 10, window_minutes: 15, min_requests: 20 };

const clamp = (v: unknown, d: number, min: number, max: number): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : d;
  return Math.min(max, Math.max(min, n));
};

/** Tolerant config read — clamps to sane bounds so a malformed alert config can never misfire. */
export function errorRateConfig(raw: unknown): ErrorRateConfig {
  const c = (raw ?? {}) as Partial<ErrorRateConfig>;
  return {
    threshold_pct: clamp(c.threshold_pct, DEFAULTS.threshold_pct, 0.01, 100),
    window_minutes: clamp(c.window_minutes, DEFAULTS.window_minutes, 1, 1440),
    min_requests: clamp(c.min_requests, DEFAULTS.min_requests, 1, 1_000_000),
  };
}

/** One event per alert per window bucket → repeated scans inside the window don't re-fire. */
export function errorRateDedupeKey(alertId: string, now: Date, windowMinutes: number): string {
  const bucket = Math.floor(now.getTime() / (windowMinutes * 60_000));
  return `error_rate:${alertId}:${bucket}`;
}

export interface ErrorRateEval {
  fires: boolean;
  errorRatePct: number;
  total: number;
  errors: number;
}

/** errorRate = status='error' / status IN ('ok','error') over the window (blocked/rate_limited excluded,
 *  matching the KPI definition). Fires only above the sample floor AND the threshold. */
export async function evaluateErrorRate(
  tx: Tx,
  orgId: string,
  cfg: ErrorRateConfig,
  now: Date,
): Promise<ErrorRateEval> {
  const sinceIso = new Date(now.getTime() - cfg.window_minutes * 60_000).toISOString();
  const [row] = (await tx.execute(sql`
    SELECT count(*) FILTER (WHERE status = 'error')::int AS errors,
           count(*) FILTER (WHERE status IN ('ok','error'))::int AS total
      FROM requests
     WHERE org_id = ${orgId}::uuid AND created_at >= ${sinceIso}`)) as unknown as {
    errors: number;
    total: number;
  }[];
  const errors = row?.errors ?? 0;
  const total = row?.total ?? 0;
  const pct = total > 0 ? (errors / total) * 100 : 0;
  return {
    fires: total >= cfg.min_requests && pct >= cfg.threshold_pct,
    errorRatePct: Math.round(pct * 100) / 100,
    total,
    errors,
  };
}

export interface ErrorRateAlert {
  id: string;
  orgId: string;
  config: unknown;
}

/** Read enabled `error_rate` alerts cross-org (jobs-role tx, like anomaly scope selection). */
export async function fetchEnabledErrorRateAlerts(tx: Tx): Promise<ErrorRateAlert[]> {
  const rows = (await tx.execute(sql`
    SELECT id, org_id, config FROM alerts WHERE kind = 'error_rate' AND enabled = true`)) as unknown as {
    id: string;
    org_id: string;
    config: unknown;
  }[];
  return rows.map((r) => ({ id: r.id, orgId: r.org_id, config: r.config }));
}

/**
 * Evaluate ONE error_rate alert and fire a deduped alert_event if it crosses. Runs inside a per-org
 * `withOrg` app-role tx (org GUC set) — mirroring the anomaly producer — so the requests read and the
 * alert_events insert are RLS-scoped, not a cross-org jobs-role write. Returns true iff a NEW event
 * fired (deduped repeats return false).
 */
export async function evaluateAndFireErrorRate(
  tx: Tx,
  alert: ErrorRateAlert,
  now: Date,
): Promise<boolean> {
  const cfg = errorRateConfig(alert.config);
  const ev = await evaluateErrorRate(tx, alert.orgId, cfg, now);
  if (!ev.fires) return false;
  const payload = {
    event_type: 'error_rate',
    scope_type: 'org',
    scope_id: alert.orgId,
    error_rate_pct: ev.errorRatePct,
    total_requests: ev.total,
    error_count: ev.errors,
    threshold_pct: cfg.threshold_pct,
    window_minutes: cfg.window_minutes,
    severity: ev.errorRatePct >= cfg.threshold_pct * 2 ? 'critical' : 'warning',
  };
  const inserted = (await tx.execute(sql`
    insert into alert_events (org_id, alert_id, fired_at, dedupe_key, payload)
    values (${alert.orgId}, ${alert.id}, now(), ${errorRateDedupeKey(alert.id, now, cfg.window_minutes)},
            ${JSON.stringify(payload)}::jsonb)
    on conflict (alert_id, dedupe_key) do nothing
    returning id`)) as unknown as { id: string }[];
  return inserted.length > 0;
}
