import { evaluateGuardrails, type ConditionRunner } from './guardrails.js';
import type { AttributeActivation } from './condition-evaluator.js';
import type { CompiledPolicy, GuardrailOutcome } from './guardrail-types.js';
import type { Candidate } from '../routing/compile.js';

/**
 * PASS-2 guardrail re-check (red-team P0: "Spillway decides once, then the request drifts").
 *
 * PASS-1 (pipeline/guardrail-stage.ts `runGuardrails`) evaluates the compiled policies against the
 * model the CLIENT ASKED FOR — `request.model_resolved` there is the ALIAS head (guardrail-stage.ts
 * `buildRequestActivation`), computed BEFORE the routing layer runs. Everything after it can serve a
 * different model: a `rewrite_model` routing rule (routing/resolve.ts `applyAction`), the alias chain
 * TAIL that dispatch walks on a retryable failure, and BUDGET's on_exceed fallback alias. So a
 * `deny gpt-4o` policy was defeated by any rule rewriting an un-denied alias onto gpt-4o.
 *
 * This module re-evaluates ONLY the MODEL-DEPENDENT policies against a concrete post-routing
 * candidate. Two reasons the subset matters, both correctness rather than performance:
 *   1. A policy whose verdict cannot change with the served model would return the same answer, so
 *      re-running it is pure noise.
 *   2. `runGuardrails` already wrote the flag / allow_shadow decision-log rows from PASS-1's
 *      `outcome.flags` / `outcome.matched`. Re-running the whole evaluator would produce a SECOND
 *      set of matches for those same policies and double-count shadow accounting.
 *
 * `evaluateGuardrails` itself is reused UNCHANGED — the exhaustive deny-overrides loop (the F1 fix)
 * is not touched, it is simply run over a smaller policy list. Flags produced here are DISCARDED:
 * PASS-2 enforces terminal effects only (deny / require_approval), never annotations.
 */

/**
 * CEL attribute roots whose VALUE changes when routing picks a different candidate.
 * `request.model_requested` is deliberately absent — it is the client's string and is invariant
 * across the whole pipeline. `spend.provider` is here because the CEL provider spend bucket is
 * keyed off the HEAD PROVIDER actually being served (guardrail-stage.ts `buildRequestActivation`),
 * so a candidate on another provider reads a different bucket.
 */
const MODEL_DEPENDENT_REFS: readonly string[] = [
  'request.model_resolved',
  'request.provider',
  'spend.provider',
];

/** True if this policy's verdict can change when routing serves a model other than the requested one. */
export function isModelDependent(p: CompiledPolicy): boolean {
  if (p.match.models !== undefined || p.match.providers !== undefined) return true;
  const refs = p.condition?.refs ?? [];
  return refs.some((ref) =>
    MODEL_DEPENDENT_REFS.some((root) => ref === root || ref.startsWith(`${root}.`)),
  );
}

export function selectModelDependentPolicies(
  policies: readonly CompiledPolicy[],
): CompiledPolicy[] {
  return policies.filter(isModelDependent);
}

/** A terminal PASS-2 verdict for one candidate. `outcome`/`activation` are carried so the caller can
 *  write the same decision-log record PASS-1 would have written. */
export interface CandidateDenial {
  effect: 'deny' | 'require_approval';
  policyId: string;
  reason: string | null;
  outcome: GuardrailOutcome;
  activation: AttributeActivation;
}

/** The per-candidate gate, built once per request at ROUTE and reused by DISPATCH. */
export interface CandidateGuardrail {
  /** null = this candidate may be dispatched. Memoized per `provider:model`. */
  check(candidate: Candidate): CandidateDenial | null;
  /** Policy ids actually re-evaluated (the model-dependent subset) — for the decision log. */
  readonly evaluatedPolicyIds: string[];
  /** True once any re-checked policy's CEL raised at runtime. */
  celError(): boolean;
}

/** The no-policy gate. Also the pipeline-context default so a ctx that never reached ROUTE is
 *  structurally valid; every dispatch path runs ROUTE first, which replaces it. */
export const PERMISSIVE_CANDIDATE_GUARDRAIL: CandidateGuardrail = {
  check: () => null,
  evaluatedPolicyIds: [],
  celError: () => false,
};

/**
 * Re-evaluate the model-dependent subset against ONE candidate's activation. Returns the terminal
 * effect or null. Order-independence + deny > require_approval come from `evaluateGuardrails`.
 */
export function evaluateCandidateGuardrails(
  modelDependent: readonly CompiledPolicy[],
  activation: AttributeActivation,
  runner: ConditionRunner,
): CandidateDenial | null {
  if (modelDependent.length === 0) return null;
  const outcome = evaluateGuardrails(modelDependent, activation, runner);
  if (outcome.action === 'allow') return null; // flags intentionally dropped — PASS-1 owns annotations
  return {
    effect: outcome.action,
    policyId: outcome.policyId ?? '',
    reason: outcome.reason,
    outcome,
    activation,
  };
}
