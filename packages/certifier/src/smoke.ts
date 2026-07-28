import type { CapabilityId } from './matrix.js';

/**
 * Live-provider smoke runner (part-3/06 §layer-2). Runs nightly against real APIs, spend-capped per
 * provider (default $0.10/run) and result-per-capability into certifier_results. This file holds the
 * PURE, testable orchestration; the actual HTTP calls are injected (a real caller in CI, a mock in
 * tests) so the runner logic — budget capping, transient retry, PASS/FAIL/SKIP bookkeeping — is
 * verified without network. The live job is env-gated (skipped unless CERTIFIER keys are present).
 */

export type SmokeStatus = 'PASS' | 'FAIL' | 'SKIPPED_BUDGET' | 'SKIPPED_TRANSIENT';

export interface SmokeResult {
  provider: string;
  capability: CapabilityId;
  model: string;
  status: SmokeStatus;
  durationMs: number;
  costUsd: number;
  errorDetail: string | null;
}

export interface PlannedCall {
  capability: CapabilityId;
  model: string;
  /** Pre-flight cost estimate (computeCost on the PLANNED request) — the budget-cap-bypass guard. */
  estimatedCostUsd: number;
}

export const DEFAULT_SPEND_CAP_USD = 0.1;

/**
 * Budget planner (the runaway-spend guard): walk the planned calls in order, running each only while
 * the ACCUMULATED estimate stays within the cap — the moment adding the next call would exceed it, that
 * call and every remaining one are marked SKIPPED_BUDGET. A single call estimated over the whole cap is
 * skipped outright (never fired). Pure + deterministic.
 */
export function planWithinBudget(
  calls: readonly PlannedCall[],
  capUsd: number = DEFAULT_SPEND_CAP_USD,
): Array<{ call: PlannedCall; run: boolean }> {
  let spent = 0;
  return calls.map((call) => {
    if (spent + call.estimatedCostUsd > capUsd) return { call, run: false };
    spent += call.estimatedCostUsd;
    return { call, run: true };
  });
}

/** A retryable transient upstream error (429/5xx) — a nightly flake, NOT a capability regression. */
export function isTransient(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * Classify one capability attempt into a SmokeStatus. `attempt` runs the live call (injected). Retries
 * ONCE on a transient error before recording SKIPPED_TRANSIENT — a provider overload must not forge a
 * regression (the catalog keeps the last-known-good result).
 */
export async function runCapability(
  planned: { call: PlannedCall; run: boolean },
  provider: string,
  attempt: () => Promise<{ ok: boolean; status: number; costUsd?: number; error?: string }>,
): Promise<SmokeResult> {
  const base = {
    provider,
    capability: planned.call.capability,
    model: planned.call.model,
    durationMs: 0,
    costUsd: 0,
    errorDetail: null as string | null,
  };
  if (!planned.run) return { ...base, status: 'SKIPPED_BUDGET' };

  for (let tries = 0; tries < 2; tries++) {
    const r = await attempt();
    if (r.ok) return { ...base, status: 'PASS', costUsd: r.costUsd ?? 0 };
    if (!isTransient(r.status)) {
      return {
        ...base,
        status: 'FAIL',
        costUsd: r.costUsd ?? 0,
        errorDetail: r.error ?? `status ${r.status}`,
      };
    }
    // transient → retry once, then give up as SKIPPED_TRANSIENT (preserve last-known-good)
  }
  return { ...base, status: 'SKIPPED_TRANSIENT', errorDetail: 'transient error after retry' };
}
