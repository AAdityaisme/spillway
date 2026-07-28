/**
 * Guardrail evaluation — the deny-overrides engine (16 §3, ADR-034). Ported from the red-teamed lab;
 * types live in guardrail-types.ts (shared with the routing layer, no CEL dep). evaluateGuardrails is
 * PURE (16 §3.1): the same function powers the hot path, shadow accounting (§8), and replay (§9.2). It
 * takes the enabled compiled policies + the per-request activation (§4) + a ConditionRunner (the CEL
 * evaluator's evalCondition, injected so this stays pure of the engine's metric side effects).
 *
 * Core invariant (the F1 fix): NO first-match short-circuit, NO priority. EVERY enabled policy is
 * evaluated; any matching enforcing `deny` blocks — so a routing-layer `rewrite` (PASS 2, ch15) can
 * never shadow a `deny` (PASS 1, here). deny > require_approval > flag; ties break on the smallest id
 * (deterministic + replayable); the deny-vs-allow OUTCOME is order-independent regardless.
 */

import type { AttributeActivation, CompiledCondition, Enforcement } from './condition-evaluator.js';
import type {
  CompiledPolicy,
  GuardrailFlag,
  GuardrailOutcome,
  MatchSpec,
  MatchedPolicy,
} from './guardrail-types.js';

/** The CEL hot-path seam (16 §5.4): fail-closed for enforce, fail-open for shadow. */
export interface ConditionRunner {
  evalCondition(
    condition: CompiledCondition,
    attrs: AttributeActivation,
    enforcement: Enforcement,
  ): boolean;
}

function includes(list: readonly string[], value: unknown): boolean {
  return typeof value === 'string' && list.includes(value);
}

/**
 * Structured match (16 §2). AND of present fields; absent = wildcard. `models` matches BOTH the raw
 * requested model and the alias-expanded head (16 §1.1). A `team_ids` filter never matches a team-less
 * request. `metadata` is OR-across-entries, AND-within-an-entry.
 */
export function structuredMatch(match: MatchSpec, attrs: AttributeActivation): boolean {
  const id = attrs.identity;
  const req = attrs.request;

  if (match.virtual_key_ids && !includes(match.virtual_key_ids, id.virtual_key_id)) return false;
  if (match.team_ids) {
    if (id.team_id == null || !includes(match.team_ids, id.team_id)) return false;
  }
  if (
    match.models &&
    !includes(match.models, req.model_requested) &&
    !includes(match.models, req.model_resolved)
  ) {
    return false;
  }
  if (match.providers && !includes(match.providers, req.provider)) return false;
  if (match.endpoints && !includes(match.endpoints, req.endpoint)) return false;
  if (match.metadata && match.metadata.length > 0) {
    const meta = (req.metadata ?? {}) as Record<string, unknown>;
    const anyEntry = match.metadata.some((entry) =>
      Object.entries(entry).every(([k, v]) => meta[k] === v),
    );
    if (!anyEntry) return false;
  }
  return true;
}

/**
 * Structural containment (16 §9.1, lint L1/L2): true if the request set `a` matches ⊇ what `b`
 * matches (a is weaker). Conservative on metadata (returns false rather than over-claim).
 */
export function matchIsSuperset(a: MatchSpec, b: MatchSpec): boolean {
  const listFields: Array<keyof MatchSpec> = [
    'virtual_key_ids',
    'team_ids',
    'models',
    'providers',
    'endpoints',
  ];
  for (const f of listFields) {
    const av = a[f] as string[] | undefined;
    if (av === undefined) continue;
    const bv = b[f] as string[] | undefined;
    if (bv === undefined) return false;
    if (!bv.every((x) => av.includes(x))) return false; // require b ⊆ a
  }
  if (a.metadata && a.metadata.length > 0) return false;
  return true;
}

/** Deny-overrides evaluation (16 §3.2). Pure; order-independent in outcome. */
export function evaluateGuardrails(
  policies: readonly CompiledPolicy[],
  attrs: AttributeActivation,
  runner: ConditionRunner,
): GuardrailOutcome {
  const matchedFull: CompiledPolicy[] = [];
  const flags: GuardrailFlag[] = [];

  for (const p of policies) {
    if (!structuredMatch(p.match, attrs)) continue;
    if (p.condition) {
      if (!runner.evalCondition(p.condition, attrs, p.enforcement)) continue;
    }
    matchedFull.push(p);
    if (p.enforcement === 'shadow') continue; // recorded, never acts (§8)
    if (p.effect === 'flag') flags.push({ policyId: p.id, name: p.name, reason: p.reason });
  }

  const matched: MatchedPolicy[] = matchedFull.map((p) => ({
    policyId: p.id,
    effect: p.effect,
    enforcement: p.enforcement,
  }));

  const enforcingDeny = matchedFull.filter(
    (p) => p.enforcement === 'enforce' && p.effect === 'deny',
  );
  if (enforcingDeny.length > 0) {
    const d = smallestId(enforcingDeny);
    return { action: 'deny', flags, matched, reason: d.reason, policyId: d.id };
  }
  const enforcingApproval = matchedFull.filter(
    (p) => p.enforcement === 'enforce' && p.effect === 'require_approval',
  );
  if (enforcingApproval.length > 0) {
    const a = smallestId(enforcingApproval);
    return { action: 'require_approval', flags, matched, reason: a.reason, policyId: a.id };
  }
  return { action: 'allow', flags, matched, reason: null, policyId: null };
}

function smallestId(ps: readonly CompiledPolicy[]): CompiledPolicy {
  return ps.reduce((best, p) => (p.id < best.id ? p : best));
}
