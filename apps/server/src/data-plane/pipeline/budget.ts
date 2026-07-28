import { sql } from 'drizzle-orm';
import { v5 as uuidv5 } from 'uuid';
import { SpillwayError } from '@spillway/shared';
import { formatUsd } from '@spillway/pricing';
import { withOrg } from '../../db/tenancy.js';
import { writeDecisionLog } from '../policy/decision-log.js';
import { resolveFallbackAlias, reorderByHealth, candidateKeyOf } from '../routing/resolve.js';
import type { CandidateKey } from '../health/store.js';
import {
  providerScopeId,
  resolveBudgetBundle,
  counterPeriodKeys,
  SCOPE_RANK,
  type BudgetScopeType,
  type ResolvedBudget,
} from '../budget/resolver.js';
import type { ProviderName } from '../routing/compile.js';
import { toRoutingPolicy, toResolverBudget } from './route.js';
import {
  estimateRequestCostMicro,
  reserveBudget,
  releaseBudgetReservation,
  type ReservationRow,
} from '../budget/reservation.js';
import type { PipelineContext } from './context.js';

/**
 * BUDGET stage (17 §2). Runs after ROUTE (head provider known), before DISPATCH. PURE compare over
 * ctx.spendSnapshot — no DB read (§2.1). Outcomes: (a) return → proceed; (b) serve-under-fallback:
 * substitute the candidate chain (§1.6); (c) hard 402: fire-and-forget the blocked row, then throw.
 * block-overrides-fallback (§1.6): one at/over hard-block budget in E must not be softened by
 * another's fallback. Exactly one substitution per request (loop guard §1.6 steps 3–4).
 */

/** §2.2 — the scope reported to the caller (their own key is the most actionable). */
function mostSpecific(E: ResolvedBudget[]): ResolvedBudget {
  return E.reduce((best, r) =>
    SCOPE_RANK[r.budget.scopeType] < SCOPE_RANK[best.budget.scopeType] ? r : best,
  );
}

function block402(ctx: PipelineContext, r: ResolvedBudget): SpillwayError {
  const detail = {
    scope_type: r.budget.scopeType,
    scope_id: r.budget.scopeId,
    period: r.budget.period,
    period_key: r.periodKey,
    spent_usd: formatUsd(ctx.spendSnapshot.get(r.counterKey) ?? 0n),
    limit_usd: formatUsd(r.budget.limitMicroUsd),
  };
  return new SpillwayError('budget_exceeded', `Budget exceeded for ${detail.scope_type}`, {
    httpStatus: 402,
    details: detail,
  });
}

export async function runBudget(ctx: PipelineContext, now: Date = new Date()): Promise<void> {
  const policy = ctx.policy;
  const resolved = resolveBudgetBundle(
    {
      orgId: policy.orgId,
      teamId: policy.teamId,
      virtualKeyId: policy.virtualKeyId,
      budgets: policy.budgets.map(toResolverBudget),
    },
    now,
  );
  const headProvider = (ctx.candidateChain[0]?.provider ?? null) as ProviderName | null;

  // ENFORCE budgets applicable to THIS request (provider budgets only for the head provider, §2.2).
  const enforce = resolved.filter((r) => {
    if (r.budget.mode !== 'enforce') return false;
    if (r.budget.scopeType === 'provider') {
      if (headProvider === null) return false;
      if (r.budget.scopeId !== providerScopeId(policy.orgId, headProvider)) return false;
    }
    return true;
  });
  if (enforce.length === 0) return; // no enforce caps → nothing to reserve or check

  // ATOMIC RESERVATION (expanded-audit H2). The old pure snapshot compare let concurrent requests all
  // read spent < limit and all pass a HARD block, then all reconcile past the cap. Now we hold a
  // conservative estimate on the counter rows and compare spent + reserved (which includes concurrent
  // in-flight holds) — so a hard block is exact under concurrency.
  const estimate = await estimateRequestCostMicro(ctx);
  if (estimate === null) {
    // Head candidate is unpriceable → PRICING (next stage) 503s it before it can dispatch/bill, so
    // nothing can overspend. Fall back to the snapshot compare so an ALREADY-over cap still blocks.
    return snapshotEnforce(ctx, enforce, resolved, now);
  }

  const rows: ReservationRow[] = [];
  for (const s of buildBlockScopes(ctx))
    for (const pk of buildBlockPeriodKeys(ctx, now))
      rows.push({ scopeType: s.type, scopeId: s.id, periodKey: pk });
  const held = await reserveBudget(ctx, rows, estimate);
  ctx.budgetReservation = { microUsd: estimate, rows };

  // block/fallback iff, WITH this request's hold, a cap is reached (>= blocks exactly at the limit).
  const E = enforce.filter((r) => {
    const h = held.get(r.counterKey);
    return (h ? h.spent + h.reserved : 0n) >= r.budget.limitMicroUsd;
  });
  if (E.length === 0) return; // hold stands; reconcile / the route finally releases it

  // Over a cap → this request must NOT proceed → free the hold we just placed, then block or fall back.
  await releaseBudgetReservation(ctx);
  if (E.some((r) => r.budget.onExceed === 'block')) {
    await logBlockedRequest(ctx, mostSpecific(E), now); // block-overrides-fallback
    throw block402(ctx, mostSpecific(E));
  }
  await serveUnderFallback(ctx, E, resolved, now); // every b ∈ E opts into fallback
}

/** Snapshot-only enforce (no reservation) — the fallback path when the head candidate is unpriceable. */
async function snapshotEnforce(
  ctx: PipelineContext,
  enforce: ResolvedBudget[],
  resolved: ResolvedBudget[],
  now: Date,
): Promise<void> {
  const E = enforce.filter(
    (r) => (ctx.spendSnapshot.get(r.counterKey) ?? 0n) >= r.budget.limitMicroUsd,
  );
  if (E.length === 0) return;
  if (E.some((r) => r.budget.onExceed === 'block')) {
    await logBlockedRequest(ctx, mostSpecific(E), now);
    throw block402(ctx, mostSpecific(E));
  }
  await serveUnderFallback(ctx, E, resolved, now);
}

/** §1.6 — is `provider`'s own enforce provider cap already at/over limit? (fallback loop-guard). */
function providerCapExhausted(
  ctx: PipelineContext,
  resolved: ResolvedBudget[],
  provider: ProviderName,
): boolean {
  const sid = providerScopeId(ctx.policy.orgId, provider);
  return resolved.some(
    (r) =>
      r.budget.scopeType === 'provider' &&
      r.budget.mode === 'enforce' &&
      r.budget.scopeId === sid &&
      (ctx.spendSnapshot.get(r.counterKey) ?? 0n) >= r.budget.limitMicroUsd,
  );
}

/** §1.6 steps 1–5 — single substitution; hard-402 if the alias is unresolvable or lands on an
 *  exhausted enforce provider cap. Never re-enters runBudget. Alert emission is wired in B8. */
async function serveUnderFallback(
  ctx: PipelineContext,
  E: ResolvedBudget[],
  resolved: ResolvedBudget[],
  now: Date,
): Promise<void> {
  const bstar = mostSpecific(E);
  const alias = bstar.budget.fallbackAlias;
  // Capture the ORIGINAL (primary) alias BEFORE we overwrite ctx.routeResult below. The fallbackFrom
  // marker must record where we fell FROM, not the destination; reading resolvedViaAlias after the
  // overwrite persisted the destination alias into requests.fallback_from[0].from_alias, corrupting
  // chargeback/audit provenance (expanded-audit M5).
  const fromAlias = ctx.routeResult?.resolvedViaAlias ?? null;
  const hard = async (): Promise<never> => {
    await logBlockedRequest(ctx, bstar, now);
    throw block402(ctx, bstar);
  };
  if (alias === null) return hard(); // defensive: enforce+fallback always has an alias (DB CHECK)

  let result;
  try {
    // Resolve health-neutral first (the fallback alias's candidates aren't in ctx.healthSnapshot,
    // which was taken for the PRIMARY route), then snapshot THIS chain's health and reorder it
    // dispatchable-first — same treatment the primary chain gets in route.ts. Passing new Map() here
    // left an open/cooling candidate at the head of the substituted chain (expanded-audit LOW).
    // §5.1: carry the same capability catalog ROUTE loaded, so a cheaper budget-fallback alias is
    // held to the same require_capabilities filter (never downgrade INTO an incapable model).
    result = resolveFallbackAlias(
      alias,
      toRoutingPolicy(ctx.policy, ctx.capabilityCatalog),
      new Map(),
      ctx.knobs.requireCapabilities,
    );
  } catch {
    return hard(); // alias missing / every candidate filtered → hard 402
  }
  const fbKeys = [
    ...result.chain,
    ...result.typedFallbacks.context_window,
    ...result.typedFallbacks.content_policy,
  ].map(candidateKeyOf);
  const fbHealth = ctx.deps.healthStore.snapshot([...new Set<CandidateKey>(fbKeys)]);
  // Drop EVERY candidate whose provider cap is already exhausted — not just the head. Checking only
  // chain[0] let the executor advance onto a later candidate (e.g. anthropic-mini) whose provider cap
  // was already over-limit, dispatching against an exhausted cap (expanded-audit L6). Filter first,
  // then reorder dispatchable-first over what survives.
  // §5.1's require_capabilities filter already ran inside resolveFallbackAlias, but the Part III capability
  // HARD-gate (request features) and the residency gate did NOT — ROUTE applied those to the primary chain
  // only. Re-apply that same admissibility here (ctx.candidateAdmissible, set by ROUTE) so a budget
  // substitution can't serve an incapable OR out-of-region model (red-team part-3 #1). THEN drop candidates
  // whose provider cap is already exhausted.
  const survivors = result.chain
    .filter(ctx.candidateAdmissible)
    .filter((c) => !providerCapExhausted(ctx, resolved, c.provider));
  const chain = reorderByHealth(survivors, fbHealth);
  // Merge into the request snapshot so the executor's typed-fallback reorder sees these candidates too.
  ctx.healthSnapshot = new Map([...ctx.healthSnapshot, ...fbHealth]);
  const head = chain[0];
  if (head === undefined) return hard(); // no candidate survives an exhausted provider cap → hard 402

  // step 5: substitute + tag. Counter goes FURTHER over b* at reconcile — truth over the cap must
  // never diverge from what the provider billed.
  // Filter the substituted typed-fallback variants by the same admissibility — the executor can advance
  // into these too (red-team part-3 #1); an emptied variant just means "no typed fallback of that class".
  ctx.routeResult = {
    ...result,
    chain,
    typedFallbacks: {
      context_window: result.typedFallbacks.context_window.filter(ctx.candidateAdmissible),
      content_policy: result.typedFallbacks.content_policy.filter(ctx.candidateAdmissible),
    },
  };
  ctx.candidateChain = chain;
  ctx.candidate = head;
  ctx.servedUnderBudgetFallback = true;
  ctx.fallbackFrom = [
    {
      attempt_number: -1,
      reason: 'budget_fallback',
      budget_id: bstar.budget.id,
      from_alias: fromAlias,
    },
  ];
}

/** §2.5/§4.2 — the same scopes reconcile bumps, sorted into the shared SCOPE_RANK lock order
 *  ([vk, team, org, provider]) so reserve/block and reconcile never deadlock on the shared tuples. */
function buildBlockScopes(ctx: PipelineContext): Array<{ type: BudgetScopeType; id: string }> {
  const scopes: Array<{ type: BudgetScopeType; id: string }> = [
    { type: 'virtual_key', id: ctx.policy.virtualKeyId },
  ];
  if (ctx.policy.teamId !== null) scopes.push({ type: 'team', id: ctx.policy.teamId });
  scopes.push({ type: 'org', id: ctx.policy.orgId });
  const headProvider = ctx.candidateChain[0]?.provider as ProviderName | undefined;
  if (headProvider !== undefined) {
    scopes.push({ type: 'provider', id: providerScopeId(ctx.policy.orgId, headProvider) });
  }
  return scopes.sort((a, b) => SCOPE_RANK[a.type] - SCOPE_RANK[b.type]);
}

/** §2.5 — the shared counter period-key set (resolver.counterPeriodKeys): month + day + any active
 *  rolling_30d block. Thin ctx adapter so every call site in this file reads the same. */
function buildBlockPeriodKeys(ctx: PipelineContext, now: Date): string[] {
  return counterPeriodKeys(ctx.policy.budgets, now);
}

/**
 * §2.5 — the blocked-row writer. Fire-and-forget: runs in its own withOrg tx and SWALLOWS any error
 * (a governance-write failure must never turn a clean 402 into a 500). Writes one status='blocked'
 * requests row + bumps blocked_count across the same scopes×periods reconcile writes (spent/
 * request_count untouched — a block never bills).
 */
export async function logBlockedRequest(
  ctx: PipelineContext,
  r: ResolvedBudget,
  now: Date,
): Promise<void> {
  try {
    await withOrg(ctx.deps.db, ctx.policy.orgId, async (tx) => {
      await tx.execute(sql`
        INSERT INTO requests (
          id, org_id, virtual_key_id, team_id, requested_model, endpoint, status,
          block_reason, block_scope_type, block_scope_id, block_period, cost_usd, metadata
        ) VALUES (
          ${ctx.requestId}::uuid, ${ctx.policy.orgId}::uuid, ${ctx.policy.virtualKeyId}::uuid,
          ${ctx.policy.teamId}::uuid, ${ctx.requestedModel}::text, ${ctx.endpoint}::text, 'blocked',
          'budget_exceeded', ${r.budget.scopeType}::text, ${r.budget.scopeId}::uuid, ${r.periodKey}::text,
          ${null}, '{}'::jsonb
        )`);
      // ONE multi-row upsert in the canonical order (SCOPE_RANK scope-major, [month, day]) — the
      // same total order reserveBudget/release/reconcile take on these tuples. The old per-row loop
      // acquired locks progressively and deadlocked (40P01) against a concurrent reserve during a
      // blocked burst; the victim's error escaped reserveBudget as a client-facing 502 and this
      // writer's bump was lost (stress budget-race, 2026-07-19). Rows are distinct per
      // (scope, period), so the single statement never touches a row twice.
      const counterValues = buildBlockScopes(ctx).flatMap((s) =>
        buildBlockPeriodKeys(ctx, now).map(
          (pk) => sql`(${ctx.policy.orgId}::uuid, ${s.type}, ${s.id}::uuid, ${pk}, 1)`,
        ),
      );
      await tx.execute(sql`
        INSERT INTO spend_counters (org_id, scope_type, scope_id, period_key, blocked_count)
        VALUES ${sql.join(counterValues, sql`, `)}
        ON CONFLICT (scope_type, scope_id, period_key) DO UPDATE
        SET blocked_count = spend_counters.blocked_count + 1, updated_at = now()`);
    });
  } catch (err) {
    // swallowed — never throw into the request path (17 §2.5). But EMIT so a silent governance-write
    // loss (RLS misconfig / transient PG error) is observable: without this the 402 returns clean yet
    // blocked_count never increments and no blocked row exists, under-reporting blocks to compliance
    // dashboards undetected (expanded-audit L4).
    ctx.req.log.error(
      { err, requestId: ctx.requestId, orgId: ctx.policy.orgId, event: 'blocked_write_failed' },
      'budget blocked-row/counter write failed (governance under-report)',
    );
  }
  // Decision log for the budget block (16 §6.2). Distinct decision id so it never collides with a
  // guardrail or rewrite decision for the same request. Fire-and-forget.
  void writeDecisionLog(ctx.deps.db, ctx.policy.orgId, {
    decisionId: uuidv5('budget_block', ctx.requestId),
    requestId: ctx.requestId,
    effect: 'budget_block',
    enforcement: 'enforce',
    wouldHave: false,
    evaluatedPolicyIds: [],
    matchedPolicyIds: [],
    decidingPolicyId: null,
    routingRuleId: null,
    reason: `budget_exceeded:${r.budget.scopeType}`,
    configSnapshotHash: ctx.policy.configSnapshotHash,
    inputSnapshot: {},
    celError: false,
  });
}
