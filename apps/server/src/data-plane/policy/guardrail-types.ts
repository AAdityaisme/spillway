/**
 * Guardrail types (16 §3) — the shared type seam between ROUTE (resolve.ts consumes a precomputed
 * GuardrailOutcome), the scope merge (merge.ts), and the guardrail evaluator (B4 provides the pure
 * `evaluateGuardrails` logic + CEL). Split out so B2.3 wires the routing layer with a STUB outcome
 * (ALLOW_OUTCOME) before the CEL engine lands, with no forward dependency on the evaluator.
 */

import type { CompiledCondition } from './condition-evaluator.js';

export type GuardrailEffect = 'deny' | 'require_approval' | 'flag';
export type Enforcement = 'shadow' | 'enforce';

/** Structured guardrail match (16 §1.1/§2). AND of present fields; absent = wildcard. */
export interface MatchSpec {
  virtual_key_ids?: string[];
  team_ids?: string[];
  models?: string[];
  metadata?: Array<Record<string, string>>;
  providers?: string[];
  endpoints?: string[];
}

/** A compiled governance policy: structured match + optional deserialized CEL program (16 §3.1). */
export interface CompiledPolicy {
  id: string;
  name: string;
  effect: GuardrailEffect;
  reason: string;
  enforcement: Enforcement;
  match: MatchSpec;
  condition?: CompiledCondition | null; // type-only import — no runtime CEL dep on the routing layer
  effectConfig: Record<string, unknown>;
}

export interface GuardrailFlag {
  policyId: string;
  name: string | null;
  reason: string;
}

export interface MatchedPolicy {
  policyId: string;
  effect: GuardrailEffect;
  enforcement: Enforcement;
}

/** The terminal outcome of the guardrail layer (deny-overrides). Present even on allow (flags). */
export interface GuardrailOutcome {
  action: 'allow' | 'deny' | 'require_approval';
  flags: GuardrailFlag[];
  matched: MatchedPolicy[];
  reason: string | null; // deciding policy's caller-facing reason (deny/require_approval)
  policyId: string | null;
}

/** Route-result annotation (→ ctx.guardrailAnnotations) for require_approval / flag effects. */
export interface GuardrailAnnotation {
  kind: 'require_approval' | 'flag';
  policyId: string;
  name: string | null;
  reason: string | null;
}

/** The B2.3 stub outcome — allow everything, no flags. Replaced by evaluateGuardrails in B4. */
export const ALLOW_OUTCOME: GuardrailOutcome = {
  action: 'allow',
  flags: [],
  matched: [],
  reason: null,
  policyId: null,
};
