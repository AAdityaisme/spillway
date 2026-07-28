import {
  resolveRoute,
  reorderByHealth,
  candidateKeyOf,
  type RoutingPolicy,
} from '../routing/resolve.js';
import { sessionPinKey } from '../routing/session-pin.js';
import { loadCapabilityCatalog } from '../routing/capability-catalog.js';
import { getResidencyMap, residencyAllows } from '../routing/residency.js';
import { requiredFeatures, assertSupported, candidateSupports } from '../providers/registry.js';
import { runGuardrails } from './guardrail-stage.js';
import type { ProviderName, Candidate } from '../routing/compile.js';
import type { CandidateKey } from '../health/store.js';
import { readSpendSnapshot } from '../budget/snapshot.js';
import {
  resolveBudgetBundle,
  budgetCounterTuples,
  type BudgetRow as ResolverBudgetRow,
  type BudgetScopeType,
  type BudgetPeriod,
  type BudgetMode,
  type OnExceed,
} from '../budget/resolver.js';
import { parseUsd } from '@spillway/pricing';
import { SpillwayError } from '@spillway/shared';
import { v5 as uuidv5 } from 'uuid';
import { writeDecisionLog } from '../policy/decision-log.js';
import type { PipelineContext } from './context.js';
import type { BudgetRow as BundleBudgetRow } from './auth.js';

/**
 * ROUTE stage (15 §4). Hoists the fresh spend snapshot ONCE (17 §3.1) → runs PASS-1 guardrails (16 §3)
 * → resolves the routing layer (PASS-2), snapshots the resolved candidates' circuit-breaker health
 * (15 §6) once, and reorders the working chain dispatchable-first. The executor (B5.3) reads
 * ctx.healthSnapshot for typed-fallback advancement + records failures back into the store.
 */

/** Adapt a bundle budget row (limit as numeric string) → the resolver row (µUSD bigint + anchor). */
export function toResolverBudget(b: BundleBudgetRow): ResolverBudgetRow {
  return {
    id: b.id,
    scopeType: b.scopeType as BudgetScopeType,
    scopeId: b.scopeId,
    period: b.period as BudgetPeriod,
    limitMicroUsd: parseUsd(b.limitUsd),
    mode: b.mode as BudgetMode,
    onExceed: b.onExceed as OnExceed,
    fallbackAlias: b.fallbackAlias,
    createdAt: new Date(b.createdAt),
  };
}

/** Build the effective RoutingPolicy from the bundle (v1: single org+vk scope; merge reserved).
 *  `capabilities` (§5.1 catalog) is threaded in only when a request sets require_capabilities. */
export function toRoutingPolicy(
  policy: PipelineContext['policy'],
  capabilities?: ReadonlyMap<string, readonly string[]> | null,
): RoutingPolicy {
  return {
    virtualKeyId: policy.virtualKeyId,
    orgId: policy.orgId,
    teamId: policy.teamId,
    allowedProviders: policy.allowedProviders,
    allowedModels: policy.allowedModels,
    aliases: policy.aliases,
    routingRules: policy.routingRules,
    providerKeys: policy.providerKeys.map((k) => ({
      id: k.id,
      provider: k.provider as ProviderName,
      status: k.status as 'active' | 'paused' | 'revoked',
      ...(k.baseUrl !== null ? { baseUrl: k.baseUrl } : {}),
    })),
    ...(capabilities ? { capabilities } : {}),
  };
}

export async function runRoute(ctx: PipelineContext, now: Date = new Date()): Promise<void> {
  const policy = ctx.policy;

  // 1. Hoist the spend snapshot over the applicable budget counter tuples (once per request).
  const resolved = resolveBudgetBundle(
    {
      orgId: policy.orgId,
      teamId: policy.teamId,
      virtualKeyId: policy.virtualKeyId,
      budgets: policy.budgets.map(toResolverBudget),
    },
    now,
  );
  const tuples = budgetCounterTuples(resolved);
  ctx.spendSnapshot = await readSpendSnapshot(ctx.deps.db, policy.orgId, tuples);

  // 2. GUARDRAIL layer (PASS 1, 16 §3) — deny-overrides. Throws a terminal 403 on deny/require_
  //    approval (block row + decision log written first); annotates ctx.guardrailAnnotations on flag.
  const outcome = await runGuardrails(ctx, resolved, now);

  // 3. ROUTING layer (PASS 2, 15 §4) — transform-only; guardrail outcome carried for annotations.
  // §5.1: load the model-capability catalog ONLY when the request asked for a capability filter — the
  // common no-filter path never touches model_prices here. Cached on ctx for BUDGET's fallback reuse.
  if (ctx.knobs.requireCapabilities) {
    ctx.capabilityCatalog = await loadCapabilityCatalog(ctx.deps.db);
  }
  const effectivePolicy = toRoutingPolicy(policy, ctx.capabilityCatalog);
  const metadata = (ctx.validatedBody.metadata as Record<string, string> | undefined) ?? {};
  // Sticky session affinity (15 §4.5): an explicit session id pins the served candidate for the
  // conversation. ROUTE only READS the pin (a pure lookup); it's written in reconcile's success path so
  // the TTL resets on observed dispatch, never here. A pin whose model is no longer routable is ignored
  // by resolveRoute (it falls back to normal resolution) — never a hard failure.
  const sessionPin =
    ctx.knobs.sessionId !== null
      ? ctx.deps.sessionPinStore.get(sessionPinKey(policy.orgId, ctx.knobs.sessionId))
      : undefined;
  const resolvedRoute = resolveRoute(
    ctx.requestedModel,
    effectivePolicy,
    ctx.spendSnapshot,
    new Map(), // resolve first with empty health to discover the candidate universe
    ctx.knobs,
    { guardrailOutcome: outcome, metadata, sessionPin },
  );

  // 4. Snapshot the circuit-breaker health of the resolved candidates ONCE (15 §6) + reorder the
  //    working chain dispatchable-first. The executor (B5.3) reuses this snapshot for typed fallbacks.
  const keys = [
    ...resolvedRoute.chain,
    ...resolvedRoute.typedFallbacks.context_window,
    ...resolvedRoute.typedFallbacks.content_policy,
  ].map(candidateKeyOf);
  ctx.healthSnapshot = ctx.deps.healthStore.snapshot([...new Set<CandidateKey>(keys)]);
  const chain = reorderByHealth(resolvedRoute.chain, ctx.healthSnapshot);

  ctx.routeResult = { ...resolvedRoute, chain };
  ctx.candidateChain = chain;
  ctx.candidate = chain[0]!; // chain length ≥ 1 (resolveRoute 403s on empty)

  // Part III adapter-contract §3 capability hard-gate + part-3/02 residency gate. Both are per-candidate
  // predicates — build them ONCE so the primary chain (below, with distinct 400/503 codes), the typed-
  // fallback variants (below), AND the budget-fallback path (budget.ts, via ctx.candidateAdmissible) enforce
  // the SAME admissibility. A candidate reached by ANY of those paths must satisfy both or it must not
  // dispatch — before this was applied to the primary chain only, so a typed/budget fallback bypassed both
  // gates and could serve an incapable OR out-of-region model (fail-OPEN; red-team part-3 #1).
  const requiredF = requiredFeatures(ctx.validatedBody);
  // /v1/embeddings IS the semantic feature — the body carries no marker registry's body-only
  // inference could see, so ROUTE injects it from the endpoint. Gates out every candidate whose
  // catalog doesn't declare 'embeddings' (all anthropic + gemini models today) — task #9.
  if (ctx.endpoint === 'embeddings') requiredF.push('embeddings');
  const residencyMap = await getResidencyMap(ctx.deps.db, now.getTime());
  const capOk = (c: Candidate): boolean =>
    requiredF.length === 0 || candidateSupports(c, requiredF);
  const residencyOk = (c: Candidate): boolean =>
    residencyAllows(policy.complianceClass, residencyMap.get(candidateKeyOf(c)) ?? 'global');
  const admissible = (c: Candidate): boolean => capOk(c) && residencyOk(c);
  ctx.candidateAdmissible = admissible;

  // Capability hard-gate — keep only candidates whose DECLARED caps cover the request's semantic features
  // (tools/vision/…); skip-not-fail across the chain, and if that empties it fail fast with
  // unsupported_feature (400, never dispatched — DECLARE, don't discover). Uncatalogued models fail OPEN
  // (assumed capable), so this never breaks existing traffic.
  if (requiredF.length > 0) {
    const capable = ctx.candidateChain.filter(capOk);
    if (capable.length === 0) assertSupported(ctx.candidateChain[0]!, requiredF); // throws the 400
    ctx.candidateChain = capable;
    ctx.candidate = capable[0]!;
    ctx.routeResult = { ...ctx.routeResult, chain: capable };
  }

  // Residency gate — fail-CLOSED: drop candidates whose model residency the key's compliance class may not
  // reach (a model absent from the registry = 'global'). Empty registry + a 'none' key (the default for all
  // existing traffic) → every candidate is global → non-breaking; a compliance-opted key with no reachable
  // model is refused (503) rather than served out of region.
  const permitted = ctx.candidateChain.filter(residencyOk);
  if (permitted.length === 0) {
    throw new SpillwayError(
      'no_route_available',
      `no candidate satisfies the '${policy.complianceClass}' data-residency requirement`,
      { httpStatus: 503, details: { compliance_class: policy.complianceClass } },
    );
  }
  ctx.candidateChain = permitted;
  ctx.candidate = permitted[0]!;

  // Apply BOTH gates to the typed-fallback variants too — the executor (dispatch.ts §7.1) advances into
  // these on a context_window/content_policy error, so an inadmissible variant would otherwise dispatch
  // ungated (red-team part-3 #1). Skip-not-fail: an emptied variant just means "no typed fallback of that
  // class" (the executor keeps walking the current working list).
  ctx.routeResult = {
    ...ctx.routeResult,
    chain: permitted,
    typedFallbacks: {
      context_window: ctx.routeResult.typedFallbacks.context_window.filter(admissible),
      content_policy: ctx.routeResult.typedFallbacks.content_policy.filter(admissible),
    },
  };

  // Decision log for a routing rewrite (16 §6.2). Distinct decision id (uuidv5 'rewrite') so it never
  // collides with a guardrail decision (decisionId = requestId) for the same request. Fire-and-forget.
  if (ctx.routeResult.routingRuleId) {
    void writeDecisionLog(ctx.deps.db, ctx.policy.orgId, {
      decisionId: uuidv5('rewrite', ctx.requestId),
      requestId: ctx.requestId,
      effect: 'rewrite',
      enforcement: 'enforce',
      wouldHave: false,
      evaluatedPolicyIds: [],
      matchedPolicyIds: [],
      decidingPolicyId: null,
      routingRuleId: ctx.routeResult.routingRuleId,
      reason: null,
      configSnapshotHash: ctx.policy.configSnapshotHash,
      inputSnapshot: {},
      celError: false,
    });
  }
}
