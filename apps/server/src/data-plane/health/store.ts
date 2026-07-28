/**
 * ProviderHealthStore — cross-request circuit breaker (15 §6, ADR-037). Ported from the red-teamed
 * lab. In-process Map behind an interface (ADR-016 Redis swap). resolveRoute reads an IMMUTABLE
 * snapshot as an argument and never mutates — mutation happens only in the dispatch executor's
 * failure feedback (§6.5). Keyed `provider:model`, global across every org in the process (a true
 * provider outage is learned once, shared by all; no org segment → no cross-org leakage).
 *
 * Gate: raw CONSECUTIVE-failure count (not percent-of-traffic — meaningless at low per-candidate
 * volume, §6.2). Only provider-fault retryable kinds count (§6.6); 4xx/auth excluded at healthKindFor.
 */

import type { ProviderName, ErrorClass } from '../routing/compile.js';

export type CandidateKey = `${ProviderName}:${string}`;
export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CandidateHealth {
  state: CircuitState;
  consecutiveFailures: number;
  windowStartMs: number;
  openedAt: number | null;
  cooldownUntilMs: number | null;
  consecutiveOpens: number;
}

export type HealthSnapshot = ReadonlyMap<CandidateKey, CandidateHealth>;
export type HealthFailureKind = 'rate_limit' | 'server' | 'timeout';

export interface ProviderHealthStore {
  snapshot(keys: CandidateKey[]): HealthSnapshot;
  recordFailure(key: CandidateKey, kind: HealthFailureKind, retryAfterMs?: number): void;
  recordSuccess(key: CandidateKey): void;
  /** A non-fault upstream RESPONSE (e.g. a 4xx client/content_policy error): the candidate is
   *  reachable, so a stored-open/half-open breaker must clear. Without this a half-open probe that
   *  returns a non-health class left the breaker stuck stored-open forever — one probe per request,
   *  never progressing (expanded-audit L18). A no-op when already closed. */
  recordReachable(key: CandidateKey): void;
}

// ── §6.2 defaults ───────────────────────────────────────────────────────────
const THRESHOLD = 5;
const WINDOW_MS = 60_000;
const BASE_COOLDOWN_MS = 30_000;
const MAX_COOLDOWN_MS = 300_000;

/** §6.3 cooldown: min(30s × 2^(opens-1), 300s) when no upstream Retry-After. */
function cooldownFor(consecutiveOpens: number): number {
  return Math.min(BASE_COOLDOWN_MS * 2 ** (consecutiveOpens - 1), MAX_COOLDOWN_MS);
}

/** Cooldown ms for an open: an explicit upstream Retry-After, else the computed backoff — BUT the
 *  explicit value is clamped to MAX_COOLDOWN_MS. Without the clamp a hostile/buggy upstream returning
 *  `Retry-After: 999999999` would pin this process-global provider:model breaker open for ~31 years,
 *  excluding the candidate for EVERY tenant until a restart (expanded-audit HIGH). */
function cooldownMs(retryAfterMs: number | undefined, consecutiveOpens: number): number {
  return retryAfterMs != null
    ? Math.min(retryAfterMs, MAX_COOLDOWN_MS)
    : cooldownFor(consecutiveOpens);
}

/** §6.6: which ErrorClass increments health, and as which kind. Others (client/auth/context_window/
 *  content_policy/null) return null → the caller must NOT recordFailure. */
export function healthKindFor(errorClass: ErrorClass): HealthFailureKind | null {
  switch (errorClass) {
    case 'rate_limit':
      return 'rate_limit';
    case 'server':
      return 'server';
    case 'timeout':
      return 'timeout';
    default:
      return null;
  }
}

/** Parse Retry-After → ms (§6.3). Accepts delta-seconds or an HTTP-date; null when absent/unparseable. */
export function parseRetryAfter(headers: Headers, now: number = Date.now()): number | null {
  const raw = headers.get('retry-after');
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    const delta = dateMs - now;
    return delta > 0 ? delta : 0;
  }
  return null;
}

function fresh(t: number): CandidateHealth {
  return {
    state: 'closed',
    consecutiveFailures: 0,
    windowStartMs: t,
    openedAt: null,
    cooldownUntilMs: null,
    consecutiveOpens: 0,
  };
}

/** Fired when a candidate's breaker OPENS (open=true) or clears via success (open=false). Lets the
 *  composition root emit the spillway_circuit_breaker_open gauge without coupling this pure,
 *  lab-ported store to prom-client (kept injectable so NoOp/tests stay dependency-free). */
export type BreakerStateListener = (key: CandidateKey, open: boolean) => void;

export class InMemoryProviderHealthStore implements ProviderHealthStore {
  readonly #map = new Map<CandidateKey, CandidateHealth>();
  readonly #now: () => number;
  readonly #onState: BreakerStateListener | undefined;

  constructor(now: () => number = Date.now, onState?: BreakerStateListener) {
    this.#now = now;
    this.#onState = onState;
  }

  snapshot(keys: CandidateKey[]): HealthSnapshot {
    const t = this.#now();
    const out = new Map<CandidateKey, CandidateHealth>();
    for (const key of keys) {
      const h = this.#map.get(key);
      if (h === undefined) {
        out.set(key, fresh(t));
        continue;
      }
      // §6.4: an open candidate past cooldown reads half-open (computed lazily, not stored).
      if (h.state === 'open' && h.cooldownUntilMs !== null && t >= h.cooldownUntilMs) {
        out.set(key, { ...h, state: 'half-open' });
      } else {
        out.set(key, { ...h });
      }
    }
    return out;
  }

  recordFailure(key: CandidateKey, _kind: HealthFailureKind, retryAfterMs?: number): void {
    const t = this.#now();
    const h = this.#map.get(key) ?? fresh(t);

    // A failure while stored-open = a failed half-open trial: re-open harsher (§6.4).
    if (h.state === 'open') {
      h.consecutiveOpens += 1;
      h.openedAt = t;
      h.cooldownUntilMs = t + cooldownMs(retryAfterMs, h.consecutiveOpens);
      this.#map.set(key, h);
      this.#onState?.(key, true); // still open (idempotent gauge set)
      return;
    }

    if (t - h.windowStartMs > WINDOW_MS) {
      h.consecutiveFailures = 0;
      h.windowStartMs = t;
    }
    h.consecutiveFailures += 1;
    const wasClosed = h.state === 'closed';
    if (h.consecutiveFailures >= THRESHOLD) {
      h.state = 'open';
      h.openedAt = t;
      h.consecutiveOpens += 1;
      h.cooldownUntilMs = t + cooldownMs(retryAfterMs, h.consecutiveOpens);
    }
    this.#map.set(key, h);
    if (wasClosed && h.state === 'open') this.#onState?.(key, true);
  }

  recordSuccess(key: CandidateKey): void {
    const t = this.#now();
    const prev = this.#map.get(key);
    this.#map.set(key, fresh(t));
    if (prev && prev.state !== 'closed') this.#onState?.(key, false);
  }

  recordReachable(key: CandidateKey): void {
    const prev = this.#map.get(key);
    // Only clears an open/half-open breaker — reachability alone (a 4xx) doesn't manufacture a health
    // record for a candidate that was never failing. Reuses the success reset (fresh/closed + gauge).
    if (prev !== undefined && prev.state !== 'closed') this.recordSuccess(key);
  }
}

/** NoOp store (tests / boot without config): every candidate reads closed. */
export class NoOpHealthStore implements ProviderHealthStore {
  snapshot(): HealthSnapshot {
    return new Map();
  }
  recordFailure(): void {}
  recordSuccess(): void {}
  recordReachable(): void {}
}
