import { sql } from 'drizzle-orm';
import { v5 as uuidv5 } from 'uuid';
import { SpillwayError } from '@spillway/shared';
import { withOrg } from '../../db/tenancy.js';
import { normalizeModel, inferProvider } from '../routing/compile.js';
import { evaluateGuardrails, type ConditionRunner } from '../policy/guardrails.js';
import {
  evaluateCandidateGuardrails,
  selectModelDependentPolicies,
  PERMISSIVE_CANDIDATE_GUARDRAIL,
  type CandidateDenial,
  type CandidateGuardrail,
} from '../policy/model-guardrails.js';
import {
  buildActivation,
  buildSnapshot,
  type SpendInput,
  type SpendScope,
} from '../policy/attributes.js';
import type { AttributeActivation } from '../policy/condition-evaluator.js';
import type { GuardrailOutcome } from '../policy/guardrail-types.js';
import {
  writeDecisionLog,
  maskDecisionInput,
  type DecisionRecord,
} from '../policy/decision-log.js';
import {
  counterPeriodKeys,
  providerScopeId,
  SCOPE_RANK,
  type BudgetScopeType,
  type ResolvedBudget,
} from '../budget/resolver.js';
import { recordBlock, recordRequestCompletion } from '../../observability/metrics.js';
import type { ProviderName } from '../routing/compile.js';
import type { PipelineContext } from './context.js';

/**
 * The GUARDRAIL layer (16 §3) — PASS 1, run at the top of ROUTE before the routing transform. Builds
 * the per-request attribute activation (§4), evaluates the compiled policies deny-overrides (§3.2),
 * and applies terminal effects: deny → 403 rule_deny; require_approval → 403 approval_required
 * (approval creation is the B7 seam); flag → annotate. Every non-clean outcome writes a decision log
 * (§6, fire-and-forget). Returns the outcome for resolveRoute (flag annotations + the deny backstop).
 */

/** Map a budget scope type → the CEL spend-attribute scope name (16 §4.1: key|team|org|provider). */
function spendScopeOf(scopeType: string): SpendScope | null {
  if (scopeType === 'virtual_key') return 'key';
  if (scopeType === 'team' || scopeType === 'org' || scopeType === 'provider') return scopeType;
  return null;
}

/** Build the §4.1 activation from ctx + the resolved budgets (spend.* from the hoisted snapshot).
 *  `served` overrides the model/provider pair for the PASS-2 re-check (model-guardrails.ts): PASS-1
 *  has to guess the served model from the ALIAS head because the routing layer has not run yet, so
 *  once it HAS run the same activation must be rebuilt against the candidate actually being sent. */
function buildRequestActivation(
  ctx: PipelineContext,
  resolved: ResolvedBudget[],
  now: Date,
  served?: { model: string; provider: string },
): AttributeActivation {
  const policy = ctx.policy;
  const model = normalizeModel(ctx.requestedModel);
  const aliasEntry = policy.aliases.find((a) => a.alias === model);
  const head = aliasEntry?.targets.default[0];
  const modelResolved = served?.model ?? head?.model ?? model;
  const provider = served?.provider ?? head?.provider ?? inferProvider(model) ?? '';

  // spend.* — day/month metrics per applicable scope (rolling_30d isn't in the CEL catalog).
  // The CEL spend.provider bucket is single — it must key off ONLY the head provider actually being
  // served, or two provider budgets (openai + anthropic) collapse into one last-write-wins bucket and
  // a `spend.provider…` guardrail silently gates on the wrong provider's spend (expanded-audit M6).
  const headProviderScopeId =
    provider === '' ? null : providerScopeId(policy.orgId, provider as ProviderName);
  const spend: SpendInput = {};
  for (const rb of resolved) {
    if (rb.budget.period === 'rolling_30d') continue;
    const scope = spendScopeOf(rb.budget.scopeType);
    if (scope === null) continue;
    if (scope === 'provider' && rb.budget.scopeId !== headProviderScopeId) continue; // wrong provider
    const used = ctx.spendSnapshot.get(rb.counterKey) ?? 0n;
    (spend[scope] ??= {})[rb.budget.period] = { used, limit: rb.budget.limitMicroUsd };
  }

  const rf = ctx.requestFeatures;
  const reqMeta = (ctx.validatedBody.metadata as Record<string, unknown> | undefined) ?? {};
  const actor = typeof reqMeta.actor === 'string' ? reqMeta.actor : null;
  return buildActivation({
    identity: {
      orgId: policy.orgId,
      teamId: policy.teamId,
      virtualKeyId: policy.virtualKeyId,
      keyTags: policy.keyTags, // vk metadata keys → CEL identity.key_tags (16 §4.1)
      actor, // request metadata.actor → CEL identity.actor
    },
    request: {
      modelRequested: ctx.requestedModel,
      modelResolved,
      provider,
      // ctx.endpoint, NOT a constant: a hardcoded 'chat_completions' here made every
      // endpoint-scoped guardrail (match.endpoints / CEL request.endpoint) blind to
      // /v1/messages and /v1/embeddings traffic — fail-open (red-team task #9).
      endpoint: ctx.endpoint,
      stream: ctx.stream,
      hasTools: rf.has_tools ?? false,
      toolCount: rf.tool_count ?? 0,
      responseFormat: rf.has_response_format ? 'json' : null,
      temperature: rf.temperature ?? null,
      maxOutputTokens: rf.max_tokens ?? null,
      inputEst: ctx.estimatedInputTokens,
      metadata: (ctx.validatedBody.metadata as Record<string, string> | undefined) ?? {},
    },
    spend,
    time: now,
  });
}

/** Blocked requests row (block_reason = rule_deny | approval_required) + blocked_count bump across
 *  the same scopes×periods reconcile writes (§3.3). Fire-and-forget — never rethrows. */
async function writeGuardrailBlock(
  ctx: PipelineContext,
  blockReason: string,
  now: Date,
): Promise<void> {
  const policy = ctx.policy;
  const scopes: Array<{ type: BudgetScopeType; id: string }> = [
    { type: 'virtual_key', id: policy.virtualKeyId },
  ];
  if (policy.teamId) scopes.push({ type: 'team', id: policy.teamId });
  scopes.push({ type: 'org', id: policy.orgId });
  // Canonical spend_counters lock order (resolver SCOPE_RANK): the push order above happens to match
  // today, but only the sort makes that an invariant a future insertion can't break.
  scopes.sort((a, b) => SCOPE_RANK[a.type] - SCOPE_RANK[b.type]);
  const keys = counterPeriodKeys(policy.budgets, now);

  try {
    await withOrg(ctx.deps.db, policy.orgId, async (tx) => {
      await tx.execute(sql`
        INSERT INTO requests (
          id, org_id, virtual_key_id, team_id, requested_model, endpoint, status,
          block_reason, cost_usd, metadata
        ) VALUES (
          ${ctx.requestId}::uuid, ${policy.orgId}::uuid, ${policy.virtualKeyId}::uuid,
          ${policy.teamId}::uuid, ${ctx.requestedModel}::text, ${ctx.endpoint}::text, 'blocked',
          ${blockReason}::text, ${null}, '{}'::jsonb
        )`);
      // ONE multi-row upsert in the canonical order — the same total order every other
      // spend_counters writer takes (reserve/release/blocked/reconcile). The old per-row loop held
      // locks across sequential round-trips and could ABBA-deadlock against a concurrent reserve,
      // exactly like the budget blocked-writer did (stress budget-race, 2026-07-19).
      const counterValues = scopes.flatMap((s) =>
        keys.map((pk) => sql`(${policy.orgId}::uuid, ${s.type}, ${s.id}::uuid, ${pk}, 1)`),
      );
      await tx.execute(sql`
        INSERT INTO spend_counters (org_id, scope_type, scope_id, period_key, blocked_count)
        VALUES ${sql.join(counterValues, sql`, `)}
        ON CONFLICT (scope_type, scope_id, period_key) DO UPDATE
        SET blocked_count = spend_counters.blocked_count + 1, updated_at = now()`);
    });
  } catch (err) {
    // swallowed — a governance-write failure never turns a clean 403 into a 500 (§3.6). But EMIT so a
    // silent loss of the blocked row + blocked_count bump is observable rather than under-reporting
    // guardrail blocks to compliance dashboards undetected (expanded-audit L4).
    ctx.req.log.error(
      {
        err,
        requestId: ctx.requestId,
        orgId: policy.orgId,
        blockReason,
        event: 'guardrail_block_write_failed',
      },
      'guardrail blocked-row/counter write failed (governance under-report)',
    );
  }
}

function decisionRecord(
  ctx: PipelineContext,
  outcome: GuardrailOutcome,
  effect: DecisionRecord['effect'],
  activation: AttributeActivation,
  wouldHave: boolean,
  celError: boolean,
): DecisionRecord {
  const matchedPolicies = ctx.policy.compiledPolicies.filter((p) =>
    outcome.matched.some((m) => m.policyId === p.id),
  );
  const snapshot = buildSnapshot(
    matchedPolicies.map((p) => ({ match: p.match, refs: p.condition?.refs ?? [] })),
    activation,
  );
  return {
    decisionId: ctx.requestId,
    requestId: ctx.requestId,
    effect,
    enforcement: effect === 'allow_shadow' ? 'shadow' : 'enforce',
    wouldHave,
    evaluatedPolicyIds: ctx.policy.compiledPolicies.map((p) => p.id),
    matchedPolicyIds: outcome.matched.map((m) => m.policyId),
    decidingPolicyId: outcome.policyId,
    routingRuleId: null,
    reason: outcome.reason,
    configSnapshotHash: ctx.policy.configSnapshotHash,
    inputSnapshot: maskDecisionInput(snapshot),
    celError,
  };
}

/**
 * Wrap the CEL evaluator so we can record whether ANY evaluated policy's condition raised at runtime
 * (→ a fail-closed deny must log cel_error=true, not as a genuine match; red-team B4). evalCondition
 * is synchronous, so the per-call metrics delta is exact (no cross-request interleaving).
 */
function celTrackingRunner(ctx: PipelineContext): {
  runner: ConditionRunner;
  celError: () => boolean;
} {
  const ev = ctx.deps.conditionEvaluator;
  let celError = false;
  return {
    runner: {
      evalCondition: (
        c: Parameters<typeof ev.evalCondition>[0],
        a: AttributeActivation,
        e: Parameters<typeof ev.evalCondition>[2],
      ) => {
        const before = ev.metrics.errors;
        const r = ev.evalCondition(c, a, e);
        if (ev.metrics.errors > before) celError = true;
        return r;
      },
    },
    celError: () => celError,
  };
}

/** Run PASS-1 guardrails. Throws a terminal 403 on deny/require_approval (after writing the blocked
 *  row + decision log); annotates + logs on flag/shadow; returns the outcome for resolveRoute. */
export async function runGuardrails(
  ctx: PipelineContext,
  resolved: ResolvedBudget[],
  now: Date,
): Promise<GuardrailOutcome> {
  const activation = buildRequestActivation(ctx, resolved, now);
  const { runner, celError: celErrorOf } = celTrackingRunner(ctx);
  const outcome = evaluateGuardrails(ctx.policy.compiledPolicies, activation, runner);
  const celError = celErrorOf();

  if (outcome.action === 'deny') {
    // blocks_total{rule_deny} + requests_total{blocked} (§6.3). A guardrail deny isn't budget-scoped,
    // so scope_type is the fixed 'policy'; no candidate served → provider/model 'unknown'.
    recordBlock('rule_deny', 'policy');
    recordRequestCompletion('blocked', null, null, ctx.endpoint);
    await writeGuardrailBlock(ctx, 'rule_deny', now);
    await writeDecisionLog(
      ctx.deps.db,
      ctx.policy.orgId,
      decisionRecord(ctx, outcome, 'deny', activation, false, celError),
    );
    throw new SpillwayError('rule_deny', outcome.reason ?? 'denied by policy', {
      httpStatus: 403,
      details: {
        block_reason: 'rule_deny',
        policy_id: outcome.policyId,
        decision_id: ctx.requestId,
      },
    });
  }

  if (outcome.action === 'require_approval') {
    // LANDMINE (expanded-audit M8): B7 (approval-request creation) is UNIMPLEMENTED. approval_request_id
    // is always null, so there is no artifact to approve and no path to unblock — require_approval is
    // effectively a PERMANENT HARD DENY mislabeled 'approval required', NOT a retryable gate. Control-
    // plane authoring should reject require_approval policies until B7 lands; here (the hot path) we
    // can only fail closed + emit loudly so an org that authored one sees why every matching request
    // 403s forever. Do NOT market this as retryable until B7 wires approval_request creation.
    ctx.req.log.warn(
      {
        requestId: ctx.requestId,
        orgId: ctx.policy.orgId,
        policyId: outcome.policyId,
        event: 'require_approval_dead_end',
      },
      'require_approval policy matched but B7 approval workflow is unimplemented — permanent 403 (no approval artifact)',
    );
    // requests_total{blocked} only (§6.3): approval_required is a blocked request but is NOT one of
    // the blocks_total `reason` enum values, so it does not increment blocks_total.
    recordRequestCompletion('blocked', null, null, ctx.endpoint);
    await writeGuardrailBlock(ctx, 'approval_required', now);
    await writeDecisionLog(
      ctx.deps.db,
      ctx.policy.orgId,
      decisionRecord(ctx, outcome, 'require_approval', activation, false, celError),
    );
    throw new SpillwayError('approval_required', outcome.reason ?? 'approval required', {
      httpStatus: 403,
      details: {
        block_reason: 'approval_required',
        policy_id: outcome.policyId,
        decision_id: ctx.requestId,
        approval_request_id: null,
      },
    });
  }

  // allow (maybe with flags / shadow matches) — annotate + log non-clean outcomes fire-and-forget.
  ctx.guardrailAnnotations = [];
  if (outcome.flags.length > 0) {
    ctx.guardrailAnnotations = outcome.flags.map((f) => ({
      kind: 'flag' as const,
      policyId: f.policyId,
      name: f.name,
      reason: f.reason,
    }));
    // Fire-and-forget, but tracked (ADR-033 D6) so app.close() drains it before the DB pool closes.
    ctx.deps.streamTasks?.track(
      writeDecisionLog(
        ctx.deps.db,
        ctx.policy.orgId,
        decisionRecord(ctx, outcome, 'flag', activation, false, celError),
      ),
    );
  } else if (outcome.matched.length > 0) {
    // only shadow policies matched → record would_have without acting (§8). Fire-and-forget, tracked.
    ctx.deps.streamTasks?.track(
      writeDecisionLog(
        ctx.deps.db,
        ctx.policy.orgId,
        decisionRecord(ctx, outcome, 'allow_shadow', activation, true, celError),
      ),
    );
  }
  return outcome;
}

// ── PASS 2: the post-routing re-check (red-team P0 "decide once, then drift") ────────────────────

/**
 * Build the per-candidate guardrail gate. ROUTE calls this AFTER `resolveRoute` and stores it on
 * ctx so DISPATCH can reuse it on every chain advance — the served model is only knowable per
 * candidate, and dispatch picks a new one on any retryable failure.
 *
 * Only the model-DEPENDENT policies are re-evaluated (see model-guardrails.ts): the rest cannot
 * change verdict, and re-running them would emit a second set of flag/shadow matches for policies
 * PASS-1 already logged. Verdicts are memoized per `provider:model`, so the dispatch backstop below
 * costs nothing for a candidate ROUTE already screened.
 */
export function buildCandidateGuardrail(
  ctx: PipelineContext,
  resolved: ResolvedBudget[],
  now: Date,
): CandidateGuardrail {
  const modelDependent = selectModelDependentPolicies(ctx.policy.compiledPolicies);
  if (modelDependent.length === 0) return PERMISSIVE_CANDIDATE_GUARDRAIL;

  const { runner, celError } = celTrackingRunner(ctx);
  const cache = new Map<string, CandidateDenial | null>();
  return {
    evaluatedPolicyIds: modelDependent.map((p) => p.id),
    celError,
    check(candidate) {
      const key = `${candidate.provider}:${candidate.model}`;
      const hit = cache.get(key);
      if (hit !== undefined) return hit;
      const activation = buildRequestActivation(ctx, resolved, now, {
        model: candidate.model,
        provider: candidate.provider,
      });
      const denial = evaluateCandidateGuardrails(modelDependent, activation, runner);
      cache.set(key, denial);
      return denial;
    },
  };
}

/**
 * Terminal PASS-2 block: no candidate in the resolved chain survives the model-scoped guardrails.
 * Mirrors PASS-1's governance writes (blocked row + blocked_count, decision log, metrics) so a drift
 * block is indistinguishable from a direct block to compliance dashboards — except for the decision
 * id. That MUST differ: decision_logs dedupes ON CONFLICT (decision_id) DO NOTHING, so reusing
 * ctx.requestId would let PASS-1's fire-and-forget flag/allow_shadow row silently swallow this deny.
 * uuidv5('post-route', requestId) mirrors ROUTE's uuidv5('rewrite', requestId).
 *
 * Safe to call here and nowhere later: it INSERTs the `requests` row, which reconcile only writes on
 * a final attempt — and ROUTE runs before any attempt exists.
 */
export async function denyPostRoute(
  ctx: PipelineContext,
  denial: CandidateDenial,
  guard: CandidateGuardrail,
  now: Date,
): Promise<never> {
  const blockReason = denial.effect === 'deny' ? 'rule_deny' : 'approval_required';
  const decisionId = uuidv5('post-route', ctx.requestId);

  // Same counters PASS-1 bumps: approval_required is a blocked request but is NOT a blocks_total
  // `reason` enum value, so only a deny increments blocks_total (§6.3).
  if (denial.effect === 'deny') recordBlock('rule_deny', 'policy');
  recordRequestCompletion('blocked', null, null, ctx.endpoint);
  await writeGuardrailBlock(ctx, blockReason, now);
  await writeDecisionLog(ctx.deps.db, ctx.policy.orgId, {
    ...decisionRecord(
      ctx,
      denial.outcome,
      denial.effect,
      denial.activation,
      false,
      guard.celError(),
    ),
    decisionId,
    // PASS-2 re-evaluated only the model-dependent subset — record what was actually run, not the
    // whole policy set, or the log claims an evaluation that did not happen.
    evaluatedPolicyIds: guard.evaluatedPolicyIds,
  });

  throw new SpillwayError(blockReason, denial.reason ?? 'denied by policy', {
    httpStatus: 403,
    details: {
      block_reason: blockReason,
      policy_id: denial.policyId,
      decision_id: decisionId,
      ...(denial.effect === 'require_approval' ? { approval_request_id: null } : {}),
    },
  });
}
