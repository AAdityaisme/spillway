import { Registry, Histogram, Counter, Gauge, collectDefaultMetrics } from 'prom-client';

/**
 * prom-client registry + the full metrics catalog (12-operations §6.3). Module-level singletons —
 * created once per process, exposed at GET /metrics (token-protected in prod, §3.2). Two layers:
 *  1. the raw instruments (registered on `registry`), and
 *  2. thin `record*` producer helpers (below the instruments) that the data-plane/jobs call sites
 *     invoke. The helpers centralize the L49 CARDINALITY GUARD: provider/model labels accept ONLY
 *     concrete post-route candidate (catalog) values — a client alias / free-text / missing value
 *     collapses to 'unknown' in exactly ONE place (`pm()` below), so no request can mint unbounded
 *     label series. Keeping the guard in the helper (not scattered at call sites) is the single
 *     source of truth the audit asked for. All helper calls are throw-safe: static label sets +
 *     finite numeric values → prom-client never throws, so a producer can never fault the request
 *     path (12-operations §6.3 hot-path constraint).
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

// ────────────────────────────────────────────────────────────────────────────
// Request-path catalog (12-operations §6.3). Names / label sets / histogram buckets are copied
// verbatim from the §6.3 table — do not add or drop a label without updating that table.
// ────────────────────────────────────────────────────────────────────────────

/** Every request through the data plane, by terminal status. */
export const requestsTotal = new Counter({
  name: 'spillway_requests_total',
  help: 'Every request through the data plane',
  labelNames: ['status', 'provider', 'model', 'endpoint'] as const,
  registers: [registry],
});

/** End-to-end request latency (served requests). */
export const requestDurationMs = new Histogram({
  name: 'spillway_request_duration_ms',
  help: 'End-to-end request latency',
  labelNames: ['provider', 'model', 'stream'] as const,
  buckets: [50, 100, 250, 500, 1000, 2500, 5000, 10_000],
  registers: [registry],
});

/** Time-to-first-token on streaming requests. */
export const ttftMs = new Histogram({
  name: 'spillway_ttft_ms',
  help: 'Time-to-first-token on streaming requests',
  labelNames: ['provider', 'model'] as const,
  buckets: [50, 100, 200, 500, 1000, 2500],
  registers: [registry],
});

/** Cumulative metered spend (USD). org_id is coarse — DB is the per-key drilldown (§6.3). */
export const spendUsdTotal = new Counter({
  name: 'spillway_spend_usd_total',
  help: 'Cumulative spend (USD)',
  labelNames: ['org_id', 'provider', 'model'] as const,
  registers: [registry],
});

/** Token counts by type. */
export const tokensTotal = new Counter({
  name: 'spillway_tokens_total',
  help: 'Token counts',
  labelNames: ['type', 'provider', 'model'] as const,
  registers: [registry],
});

/** Blocked requests, by reason + the scope the block applies at. */
export const blocksTotal = new Counter({
  name: 'spillway_blocks_total',
  help: 'Blocked requests',
  labelNames: ['reason', 'scope_type'] as const,
  registers: [registry],
});

/** Fallback activations (per candidate advance in the dispatch chain). */
export const fallbacksTotal = new Counter({
  name: 'spillway_fallbacks_total',
  help: 'Fallback activations (per candidate advance in the fallback chain)',
  labelNames: ['from_provider', 'from_model', 'reason'] as const,
  registers: [registry],
});

/** Client-disconnected mid-stream (usage_estimated rows). */
export const streamAbortsTotal = new Counter({
  name: 'spillway_stream_aborts_total',
  help: 'Client-disconnected mid-stream',
  labelNames: ['provider', 'model'] as const,
  registers: [registry],
});

/** Upstream provider error responses. */
export const providerErrorsTotal = new Counter({
  name: 'spillway_provider_errors_total',
  help: 'Upstream provider error responses',
  labelNames: ['provider', 'http_status', 'spillway_code'] as const,
  registers: [registry],
});

/**
 * Hours since last successful pricing-sync (§6.3). Producer is /readyz's pricing-freshness check
 * (§6.4 Alert 2: `pricing_age_hours`), which computes `now - MAX(model_prices.synced_at)` — a
 * global, once-per-scrape figure, NOT a per-request/per-candidate one. That computation lives on
 * the health/readyz path (out of this lane) and the request hot path must not add a synced_at read
 * (§6.3 hot-path constraint / "no new query"); the instrument is exported so that owner sets it via
 * `setPricingStalenessHours`. Registered here so the series exists on the scrape from boot.
 */
export const pricingStalenessHours = new Gauge({
  name: 'spillway_pricing_staleness_hours',
  help: 'Hours since last successful pricing-sync (set by /readyz)',
  registers: [registry],
});

/** Policy LRU cache hits (auth bundle fill avoided). */
export const policyCacheHitsTotal = new Counter({
  name: 'spillway_policy_cache_hits_total',
  help: 'Policy LRU cache hits',
  registers: [registry],
});

/** Policy LRU cache misses (triggers a DB bundle load). */
export const policyCacheMissesTotal = new Counter({
  name: 'spillway_policy_cache_misses_total',
  help: 'Policy LRU cache misses (triggers DB load)',
  registers: [registry],
});

/** Current number of open SSE connections. */
export const activeSseStreams = new Gauge({
  name: 'spillway_active_sse_streams',
  help: 'Current number of open SSE connections',
  registers: [registry],
});

// ── producer helpers ────────────────────────────────────────────────────────

const UNKNOWN = 'unknown';

/**
 * L49 CARDINALITY GUARD (single source of truth). provider/model labels are only ever fed the
 * concrete post-route candidate (catalog) provider+model — NEVER the caller's `requestedModel`
 * alias or any free-text. A null/empty value (an error settled before a candidate was chosen, or a
 * block with no served candidate) collapses to 'unknown' so a client cannot mint unbounded series.
 */
function pm(
  provider: string | null | undefined,
  model: string | null | undefined,
): {
  provider: string;
  model: string;
} {
  return { provider: provider || UNKNOWN, model: model || UNKNOWN };
}

/** Structural token shape (matches @spillway/pricing CanonicalUsage) — avoids a pkg import here. */
interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  reasoningTokens: number;
}

/** requests_total — one increment per terminal request outcome. `provider`/`model` are the served
 *  candidate for ok/error, and 'unknown' for pre-dispatch blocks/rate-limits (no served candidate). */
export function recordRequestCompletion(
  status: 'ok' | 'error' | 'blocked' | 'rate_limited',
  provider: string | null | undefined,
  model: string | null | undefined,
  endpoint: string,
): void {
  requestsTotal.inc({ status, ...pm(provider, model), endpoint });
}

/** request_duration_ms — end-to-end latency of a served request. */
export function observeRequestDuration(
  provider: string | null | undefined,
  model: string | null | undefined,
  stream: boolean,
  ms: number,
): void {
  requestDurationMs.observe({ ...pm(provider, model), stream: String(stream) }, ms);
}

/** ttft_ms — time to first streamed byte. */
export function observeTtft(
  provider: string | null | undefined,
  model: string | null | undefined,
  ms: number,
): void {
  ttftMs.observe(pm(provider, model), ms);
}

/** spend_usd_total — metered spend for one billed settle. Converts from bigint micro-USD to a
 *  float for the metric ONLY (observability-grade); the ledger stays bigint micro-USD (ADR-019e). */
export function recordSpendUsd(
  orgId: string,
  provider: string | null | undefined,
  model: string | null | undefined,
  costMicroUsd: bigint | null,
): void {
  if (costMicroUsd === null || costMicroUsd <= 0n) return;
  spendUsdTotal.inc({ org_id: orgId, ...pm(provider, model) }, Number(costMicroUsd) / 1_000_000);
}

/** tokens_total — per-type token counts for one billed settle (skip zero to avoid empty series). */
export function recordTokens(
  provider: string | null | undefined,
  model: string | null | undefined,
  usage: TokenUsage,
): void {
  const labels = pm(provider, model);
  const cacheWrite = usage.cacheWrite5mTokens + usage.cacheWrite1hTokens;
  if (usage.inputTokens > 0) tokensTotal.inc({ type: 'input', ...labels }, usage.inputTokens);
  if (usage.outputTokens > 0) tokensTotal.inc({ type: 'output', ...labels }, usage.outputTokens);
  if (usage.cachedReadTokens > 0)
    tokensTotal.inc({ type: 'cached_read', ...labels }, usage.cachedReadTokens);
  if (cacheWrite > 0) tokensTotal.inc({ type: 'cache_write', ...labels }, cacheWrite);
  if (usage.reasoningTokens > 0)
    tokensTotal.inc({ type: 'reasoning', ...labels }, usage.reasoningTokens);
}

/** blocks_total — one increment per blocked request. `reason`/`scopeType` are server-side enums. */
export function recordBlock(reason: string, scopeType: string): void {
  blocksTotal.inc({ reason, scope_type: scopeType });
}

/** fallbacks_total — one increment per dispatch candidate advance. `from*` are the candidate we
 *  fell FROM (catalog values); `reason` is a fixed error-class/code enum. */
export function recordFallback(fromProvider: string, fromModel: string, reason: string): void {
  fallbacksTotal.inc({ from_provider: fromProvider, from_model: fromModel, reason });
}

/** stream_aborts_total — client hung up mid-stream. */
export function recordStreamAbort(
  provider: string | null | undefined,
  model: string | null | undefined,
): void {
  streamAbortsTotal.inc(pm(provider, model));
}

/** provider_errors_total — an upstream non-2xx we mapped. `httpStatus` is a bounded int, `code` a
 *  SpillwayError-code enum; `provider` is the served candidate's (catalog) provider. */
export function recordProviderError(
  provider: string | null | undefined,
  httpStatus: number,
  spillwayCode: string,
): void {
  providerErrorsTotal.inc({
    provider: provider || UNKNOWN,
    http_status: String(httpStatus),
    spillway_code: spillwayCode,
  });
}

/** active_sse_streams — bump on hijack, drop on stream teardown (must be balanced by the caller). */
export function sseStreamOpened(): void {
  activeSseStreams.inc();
}
export function sseStreamClosed(): void {
  activeSseStreams.dec();
}

/** policy_cache_{hits,misses}_total — auth bundle cache outcome. */
export function policyCacheHit(): void {
  policyCacheHitsTotal.inc();
}
export function policyCacheMiss(): void {
  policyCacheMissesTotal.inc();
}

/** pricing_staleness_hours — set by /readyz (see the gauge's WHY note). */
export function setPricingStalenessHours(hours: number): void {
  pricingStalenessHours.set(hours);
}
