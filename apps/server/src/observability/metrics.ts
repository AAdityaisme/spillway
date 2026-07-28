import { Registry, Histogram, Counter, Gauge, collectDefaultMetrics } from 'prom-client';

/**
 * prom-client registry + the core instruments (12-operations §6.3). Module-level singletons —
 * created once per process, exposed at GET /metrics (token-protected in prod, §3.2). The full
 * request-path catalog (requests_total, ttft, tokens, blocks, fallbacks) lands with B9's load
 * instrumentation; these are the instruments that already have producers today.
 */

export const registry = new Registry();
collectDefaultMetrics({ register: registry });

/** Settle-tx duration (17 §4.6 SLO: p50 ≤ 5ms / p99 ≤ 15ms). */
export const reconcileDurationMs = new Histogram({
  name: 'spillway_reconcile_duration_ms',
  help: 'Reconcile settle transaction duration (commit-before-ack)',
  buckets: [1, 2, 5, 10, 15, 25, 50, 100, 250, 1000],
  registers: [registry],
});

/** The spend_write_lost alert hook — any increment is money not metered. */
export const spendWriteLostTotal = new Counter({
  name: 'spillway_spend_write_lost_total',
  help: 'Reconcile settles declared lost after retries (recovery record in logs)',
  registers: [registry],
});

export const jobRunsTotal = new Counter({
  name: 'spillway_job_runs_total',
  help: 'Background job completions',
  labelNames: ['job', 'ok'] as const,
  registers: [registry],
});

export const jobDurationMs = new Histogram({
  name: 'spillway_job_duration_ms',
  help: 'Background job execution time',
  labelNames: ['job'] as const,
  buckets: [10, 50, 100, 250, 1000, 5000, 30_000, 120_000],
  registers: [registry],
});

/** 17 §3.6 — 1 when >1 instance runs without the Redis invalidation bundle. */
export const policyCacheSingletonViolated = new Gauge({
  name: 'spillway_policy_cache_singleton_violated',
  help: 'Set to 1 when instance count > 1 while the policy cache is in-process only',
  registers: [registry],
});

/**
 * Circuit-breaker state per candidate (15 §6). 1 = open (provider being skipped), 0 = closed/half-open.
 * Without this a provider outage is invisible until someone triages Axiom logs; alert when any series
 * stays 1 for >60s (expanded-audit MED).
 */
export const circuitBreakerOpen = new Gauge({
  name: 'spillway_circuit_breaker_open',
  help: '1 while a provider:model circuit breaker is open (candidate skipped)',
  labelNames: ['provider', 'model'] as const,
  registers: [registry],
});

/**
 * Alert events that hit the delivery-attempt cap and are dead-lettered (no further retry). Any
 * increment means an operator alert was NOT delivered — page on it (expanded-audit HIGH; previously
 * such events were silently stuck undelivered forever with no signal).
 */
export const alertDeliveryDeadLetterTotal = new Counter({
  name: 'spillway_alert_delivery_dead_letter_total',
  help: 'Alert events dropped after exhausting delivery attempts (undelivered, no retry)',
  registers: [registry],
});
