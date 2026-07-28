/**
 * `resolveRoute` — the pure ROUTE stage (15 §4, ADR-009/037/042). Ported from the red-teamed lab,
 * refactored for V2's port order: the GUARDRAIL layer's OUTCOME is precomputed by the caller and
 * passed in `env.guardrailOutcome` (B2.3 passes the ALLOW stub; B4 passes evaluateGuardrails(...)),
 * so this module has no dependency on the CEL engine. A matching enabled `deny` short-circuits with
 * a terminal 403 that NO routing rule can shadow (ADR-034); then the ROUTING layer (routing_rules,
 * priority-ordered, first-match, transform-only) runs. Pure: same inputs ⇒ same RouteResult. Health
 * MUTATION never happens here (only in dispatch, §6.5).
 */

import {
  inferProvider,
  normalizeModel,
  type Candidate,
  type CompiledAlias,
  type CompiledRule,
  type ErrorClass,
  type ProviderName,
  type RuleAction,
  type RuleMatch,
  type TargetSpec,
  type TypedChain,
} from './compile.js';
import type { GuardrailAnnotation, GuardrailOutcome } from '../policy/guardrail-types.js';
import type { CandidateKey, HealthSnapshot } from '../health/store.js';
import type { SessionPin } from './session-pin.js';

interface ProviderKeyRow {
  id: string;
  provider: ProviderName;
  status: 'active' | 'paused' | 'revoked';
  baseUrl?: string;
}

/** The effective routing policy (15 §3 merge output). 17 owns budgets; this is the routing surface. */
export interface RoutingPolicy {
  virtualKeyId: string;
  orgId: string;
  teamId: string | null;
  allowedProviders: string[] | null;
  allowedModels: string[] | null;
  aliases: CompiledAlias[];
  routingRules: CompiledRule[]; // pre-sorted ascending priority, enabled only
  providerKeys: ProviderKeyRow[];
  /** model-catalog capability sets (20 §pricing), keyed `provider:model`; drives §5.1. */
  capabilities?: ReadonlyMap<string, readonly string[]>;
}

/** 17 owns SpendSnapshot; the routing surface carries the structural read (µUSD by scope key). */
export type SpendSnapshot = ReadonlyMap<string, bigint>;

export interface SafeKnobs {
  sessionId: string | null;
  requireCapabilities: string[] | null;
  traceEnabled: boolean;
  provider: ProviderName | null;
}

export interface RouteResult {
  chain: Candidate[]; // length ≥ 1; the working (default) chain, health-reordered
  typedFallbacks: { context_window: Candidate[]; content_policy: Candidate[] };
  requestedModel: string;
  routingRuleId: string | null;
  resolvedViaAlias: string | null;
  servedUnderBudgetFallback: boolean;
  sessionPinned: boolean;
  guardrailAnnotations: GuardrailAnnotation[];
}

export interface RouteEnv {
  /** Precomputed guardrail outcome (B2.3 = ALLOW_OUTCOME stub; B4 = evaluateGuardrails result). */
  guardrailOutcome: GuardrailOutcome;
  /** Request metadata for structured rule matching (§4.7). */
  metadata: Record<string, string>;
  sessionPin?: SessionPin;
}

export type RouteErrorCode =
  | 'rule_deny'
  | 'ambiguous_provider'
  | 'model_not_allowed'
  | 'no_route_available'
  | 'invalid_request'
  | 'budget_exceeded';

/** Terminal routing error (§4.8/§7.4). Thrown; never re-entered by the fallback loop. */
export class RouteError extends Error {
  readonly code: RouteErrorCode;
  readonly status: number;
  readonly reason: string | null;
  constructor(code: RouteErrorCode, status: number, message: string, reason: string | null = null) {
    super(message);
    this.name = 'RouteError';
    this.code = code;
    this.status = status;
    this.reason = reason;
  }
}

function candidateKey(c: TargetSpec): CandidateKey {
  return `${c.provider}:${c.model}`;
}

function makeCandidate(t: TargetSpec, key: ProviderKeyRow): Candidate {
  return key.baseUrl !== undefined
    ? { provider: t.provider, model: t.model, providerKeyId: key.id, baseUrl: key.baseUrl }
    : { provider: t.provider, model: t.model, providerKeyId: key.id };
}

function activeKeyFor(provider: ProviderName, policy: RoutingPolicy): ProviderKeyRow | undefined {
  return policy.providerKeys.find((k) => k.provider === provider && k.status === 'active');
}

/** §4.9/§4.10 assemble the default variant. Head provider must be allowed (else 403); disallowed /
 *  no-active-key entries dropped; empty result → 403 model_not_allowed. */
function assembleDefault(targets: TargetSpec[], policy: RoutingPolicy): Candidate[] {
  const head = targets[0];
  if (
    head !== undefined &&
    policy.allowedProviders !== null &&
    !policy.allowedProviders.includes(head.provider)
  ) {
    throw new RouteError('model_not_allowed', 403, `provider ${head.provider} not allowed`);
  }
  const out = assembleVariant(targets, policy);
  if (out.length === 0)
    throw new RouteError('model_not_allowed', 403, 'no candidate can serve this model');
  return out;
}

/** §4.10 a typed variant filters through provider allow-list + key resolution; may be empty. */
function assembleVariant(targets: TargetSpec[] | undefined, policy: RoutingPolicy): Candidate[] {
  if (targets === undefined) return [];
  const out: Candidate[] = [];
  for (const t of targets) {
    if (policy.allowedProviders !== null && !policy.allowedProviders.includes(t.provider)) continue;
    const key = activeKeyFor(t.provider, policy);
    if (key === undefined) continue;
    out.push(makeCandidate(t, key));
  }
  return out;
}

/** Keep only candidates whose MODEL is in the vk allow-list (null = unrestricted). Used by the budget
 *  on_exceed fallback path, which substitutes an alias chain that never passed the primary allowed_models
 *  gate (expanded-audit M21). */
function filterAllowedModels(cands: Candidate[], policy: RoutingPolicy): Candidate[] {
  if (policy.allowedModels === null) return cands;
  const allow = policy.allowedModels;
  return cands.filter((c) => allow.includes(c.model));
}

const KNOWN_CAPABILITY_COUNT = 7;

/** §5.1 capability hard-filter: keep only candidates advertising ALL required capabilities. */
function filterCapabilities(
  cands: Candidate[],
  required: string[] | null,
  policy: RoutingPolicy,
): Candidate[] {
  if (required === null || required.length === 0) return cands;
  if (required.length > KNOWN_CAPABILITY_COUNT) {
    throw new RouteError('invalid_request', 422, 'too many required capabilities');
  }
  // No model-capability catalog is loaded (the §5.1 catalog — 20 §pricing model-metadata — is not yet
  // populated: nothing sets policy.capabilities). With zero data every candidate resolves to [] caps and
  // the hard filter would drop the ENTIRE pool, 503-ing every require-capabilities request. Fail OPEN to
  // the documented best-effort default (§5.1: "default off = parameters forwarded best-effort") until
  // the catalog ships — a strictly better failure mode than a guaranteed no_route_available. Once
  // policy.capabilities carries entries, the real hard filter below applies unchanged.
  if (!policy.capabilities || policy.capabilities.size === 0) return cands;
  const req = [...new Set(required)];
  return cands.filter((c) => {
    const caps = policy.capabilities?.get(candidateKey(c)) ?? [];
    return req.every((r) => caps.includes(r));
  });
}

/** `provider:model` key for the health store + typed-fallback lookup (exported for the route/executor). */
export function candidateKeyOf(c: Candidate): CandidateKey {
  return `${c.provider}:${c.model}`;
}

/** Exported §4.11 reorder — the route applies it after snapshotting the resolved candidates' health. */
export function reorderByHealth(chain: Candidate[], health: HealthSnapshot): Candidate[] {
  return healthReorder(chain, health);
}

/** §4.11 health reorder: dispatchable-first (closed/half-open), open appended, never dropped. */
function healthReorder(cands: Candidate[], health: HealthSnapshot): Candidate[] {
  const dispatchable: Candidate[] = [];
  const cooling: Candidate[] = [];
  for (const c of cands) {
    const state = health.get(candidateKey(c))?.state ?? 'closed';
    if (state === 'open') cooling.push(c);
    else dispatchable.push(c);
  }
  return [...dispatchable, ...cooling];
}

/** §4.7 structured match: AND of present fields; absent = wildcard. Model pre-normalized. */
function ruleMatches(
  match: RuleMatch,
  policy: RoutingPolicy,
  model: string,
  metadata: Record<string, string>,
): boolean {
  if (match.virtual_key_ids && !match.virtual_key_ids.includes(policy.virtualKeyId)) return false;
  if (match.team_ids) {
    if (policy.teamId === null || !match.team_ids.includes(policy.teamId)) return false;
  }
  if (match.models && !match.models.includes(model)) return false;
  if (match.metadata && match.metadata.length > 0) {
    const ok = match.metadata.some((entry) =>
      Object.entries(entry).every(([k, v]) => metadata[k] === v),
    );
    if (!ok) return false;
  }
  return true;
}

function withVariants(defaultTargets: TargetSpec[], src: TypedChain): TypedChain {
  const out: TypedChain = { default: defaultTargets };
  if (src.context_window !== undefined) out.context_window = src.context_window;
  if (src.content_policy !== undefined) out.content_policy = src.content_policy;
  return out;
}

/** §4.7 action application. First-match-wins across rules; no cross-rule composition. */
function applyAction(base: TypedChain, action: RuleAction): TypedChain {
  if (action.type === 'rewrite_model') {
    if (action.fallbacks !== undefined) {
      return withVariants([action.to, ...action.fallbacks.default], action.fallbacks);
    }
    return withVariants([action.to, ...base.default.slice(1)], base);
  }
  const head = base.default[0];
  const tail = action.chain.default;
  return withVariants(head !== undefined ? [head, ...tail] : [...tail], action.chain);
}

function applyRoutingRules(
  base: TypedChain,
  model: string,
  policy: RoutingPolicy,
  metadata: Record<string, string>,
): { chain: TypedChain; routingRuleId: string | null } {
  for (const rule of policy.routingRules) {
    if (!ruleMatches(rule.match, policy, model, metadata)) continue;
    return { chain: applyAction(base, rule.action), routingRuleId: rule.id };
  }
  return { chain: base, routingRuleId: null };
}

/** §4.6 literal path: infer the provider (prefix → single-key → knob), else 422. */
function literalChain(model: string, policy: RoutingPolicy, knobs: SafeKnobs): TypedChain {
  let provider: ProviderName | null = knobs.provider ?? inferProvider(model);
  if (provider === null) {
    const active = [
      ...new Set(policy.providerKeys.filter((k) => k.status === 'active').map((k) => k.provider)),
    ];
    if (active.length === 1) provider = active[0]!;
    else throw new RouteError('ambiguous_provider', 422, `cannot infer provider for ${model}`);
  }
  return { default: [{ provider, model }] };
}

function buildAnnotations(outcome: GuardrailOutcome): GuardrailAnnotation[] {
  const anns: GuardrailAnnotation[] = [];
  if (outcome.action === 'require_approval') {
    anns.push({
      kind: 'require_approval',
      policyId: outcome.policyId ?? '',
      name: null,
      reason: outcome.reason,
    });
  }
  for (const f of outcome.flags) {
    anns.push({ kind: 'flag', policyId: f.policyId, name: f.name, reason: f.reason });
  }
  return anns;
}

/** The ROUTE stage (§4.1 sequence). Pure — see module doc for the guardrail-outcome seam. */
export function resolveRoute(
  requestedModel: string,
  effectivePolicy: RoutingPolicy,
  spendSnapshot: SpendSnapshot,
  health: HealthSnapshot,
  knobs: SafeKnobs,
  env: RouteEnv,
): RouteResult {
  void spendSnapshot; // carried for the guardrail activation (built by the caller) + port signature

  // 1. GUARDRAIL LAYER — precomputed outcome (deny-overrides, un-shadowable).
  const outcome = env.guardrailOutcome;
  if (outcome.action === 'deny') {
    throw new RouteError(
      'rule_deny',
      403,
      outcome.reason ? `denied by policy: ${outcome.reason}` : 'denied by policy',
      outcome.reason,
    );
  }
  const annotations = buildAnnotations(outcome);

  // 2. normalize (empty is rejected pre-ROUTE at VALIDATE; guarded here fail-closed).
  const model = normalizeModel(requestedModel);
  if (model.length === 0) throw new RouteError('invalid_request', 422, 'empty model');

  // §4.9 allowed_models checked BEFORE routing transforms (access control ≠ deny rule).
  if (effectivePolicy.allowedModels !== null && !effectivePolicy.allowedModels.includes(model)) {
    throw new RouteError('model_not_allowed', 403, `model ${model} not allowed`);
  }

  // 4. alias vs literal → base TypedChain.
  const aliasEntry = effectivePolicy.aliases.find((a) => a.alias === model);
  const base: TypedChain = aliasEntry
    ? aliasEntry.targets
    : literalChain(model, effectivePolicy, knobs);
  const resolvedViaAlias = aliasEntry ? aliasEntry.alias : null;

  // 5. routing layer: first-match transform.
  const { chain: transformed, routingRuleId } = applyRoutingRules(
    base,
    model,
    effectivePolicy,
    env.metadata,
  );

  // 6. hard-filter guards on the default variant.
  let defaultCands = assembleDefault(transformed.default, effectivePolicy);
  defaultCands = filterCapabilities(defaultCands, knobs.requireCapabilities, effectivePolicy);
  if (defaultCands.length === 0) {
    throw new RouteError('no_route_available', 503, 'no candidate satisfies the capability filter');
  }

  // 3'. session sticky pin — head only; base supplies the tail (§4.5).
  let sessionPinned = false;
  if (knobs.sessionId !== null && env.sessionPin !== undefined) {
    const pc = env.sessionPin.candidate;
    const allowedModel =
      effectivePolicy.allowedModels === null || effectivePolicy.allowedModels.includes(pc.model);
    const allowedProv =
      effectivePolicy.allowedProviders === null ||
      effectivePolicy.allowedProviders.includes(pc.provider);
    const notOpen = (health.get(candidateKey(pc))?.state ?? 'closed') !== 'open';
    const pinHasCaps =
      filterCapabilities([pc], knobs.requireCapabilities, effectivePolicy).length > 0;
    if (allowedModel && allowedProv && notOpen && pinHasCaps) {
      defaultCands = [pc, ...defaultCands.filter((c) => candidateKey(c) !== candidateKey(pc))];
      sessionPinned = true;
    }
  }

  // 7/8. typed-chain assembly + health reorder.
  const chain = healthReorder(defaultCands, health);
  const cw = filterCapabilities(
    assembleVariant(transformed.context_window, effectivePolicy),
    knobs.requireCapabilities,
    effectivePolicy,
  );
  const cp = filterCapabilities(
    assembleVariant(transformed.content_policy, effectivePolicy),
    knobs.requireCapabilities,
    effectivePolicy,
  );

  return {
    chain,
    typedFallbacks: { context_window: cw, content_policy: cp },
    requestedModel,
    routingRuleId,
    resolvedViaAlias,
    servedUnderBudgetFallback: false,
    sessionPinned,
    guardrailAnnotations: annotations,
  };
}

/**
 * §7.1 pure typed-fallback selector: on an error of class context_window/content_policy, advance
 * into that typed variant; an EMPTY variant falls through to the default tail. Other classes walk
 * the default tail.
 */
export function selectTypedFallback(result: RouteResult, errorClass: ErrorClass): Candidate[] {
  if (errorClass === 'context_window' && result.typedFallbacks.context_window.length > 0) {
    return result.typedFallbacks.context_window;
  }
  if (errorClass === 'content_policy' && result.typedFallbacks.content_policy.length > 0) {
    return result.typedFallbacks.content_policy;
  }
  return result.chain.slice(1);
}

/**
 * §8 on_exceed re-resolution. BUDGET (ch17) calls this to substitute the named fallback alias
 * chain instead of returning 402. A missing/unresolvable/empty alias FAILS CLOSED to 402. Does NOT
 * re-run guardrails or re-check budget.
 */
export function resolveFallbackAlias(
  alias: string,
  effectivePolicy: RoutingPolicy,
  health: HealthSnapshot,
  requireCapabilities: string[] | null = null,
): RouteResult {
  const entry = effectivePolicy.aliases.find((a) => a.alias === normalizeModel(alias));
  if (entry === undefined)
    throw new RouteError('budget_exceeded', 402, `fallback alias ${alias} not found`);

  let cands: Candidate[];
  try {
    cands = assembleDefault(entry.targets.default, effectivePolicy);
  } catch {
    throw new RouteError('budget_exceeded', 402, `fallback alias ${alias} unresolvable`);
  }

  // §4.9 allowed_models is enforced on the PRIMARY route against the requested model, but the budget
  // on_exceed path substitutes a whole different alias chain that never passed that gate — assembleDefault
  // only filters allowed_PROVIDERS. Without this a vk with allowed_models=['gpt-4o-mini'] and a budget
  // fallbackAlias resolving to claude-3-opus would be served a model it is explicitly forbidden from,
  // bypassing access control via the budget path (expanded-audit M21). Fail CLOSED to 402 if the
  // filter empties the chain (a disallowed fallback is a hard block, not a silent downgrade).
  const allowed = filterAllowedModels(cands, effectivePolicy);
  if (allowed.length === 0)
    throw new RouteError(
      'budget_exceeded',
      402,
      `fallback alias ${alias} resolves to a disallowed model`,
    );

  // §5.1 is likewise enforced on the PRIMARY route only. A budget fallback substituting a cheaper alias
  // must not silently downgrade a require_capabilities request INTO a model that drops the parameter
  // (same bypass class as allowed_models above). Fail CLOSED to 402 if no fallback candidate is capable.
  const capable = filterCapabilities(allowed, requireCapabilities, effectivePolicy);
  if (capable.length === 0)
    throw new RouteError(
      'budget_exceeded',
      402,
      `fallback alias ${alias} resolves to a model lacking a required capability`,
    );

  return {
    chain: healthReorder(capable, health),
    typedFallbacks: {
      context_window: filterCapabilities(
        filterAllowedModels(
          assembleVariant(entry.targets.context_window, effectivePolicy),
          effectivePolicy,
        ),
        requireCapabilities,
        effectivePolicy,
      ),
      content_policy: filterCapabilities(
        filterAllowedModels(
          assembleVariant(entry.targets.content_policy, effectivePolicy),
          effectivePolicy,
        ),
        requireCapabilities,
        effectivePolicy,
      ),
    },
    requestedModel: alias,
    routingRuleId: null,
    resolvedViaAlias: entry.alias,
    servedUnderBudgetFallback: true,
    sessionPinned: false,
    guardrailAnnotations: [],
  };
}
