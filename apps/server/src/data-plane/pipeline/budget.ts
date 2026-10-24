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
import type { Candidate, ProviderName } from '../routing/compile.js';
import { toRoutingPolicy, toResolverBudget } from './route.js';
import {
  estimateCandidateCostMicro,
  estimateCandidateCostMicroSync,
  reserveBudget,
  releaseBudgetReservation,
  releaseHold,
  type BudgetHold,
  type ReservationRow,
} from '../budget/reservation.js';
import { recordBlock, recordRequestCompletion } from '../../observability/metrics.js';
import type { PipelineContext } from './context.js';

/**
 * BUDGET stage (17 §2). Runs after ROUTE, before DISPATCH. Outcomes for the FIRST candidate:
 * (a) return → proceed; (b) serve-under-fallback: substitute the candidate chain (§1.6); (c) hard 402:
 * fire-and-forget the blocked row, then throw. block-overrides-fallback (§1.6): one at/over hard-block
 * budget in E must not be softened by another's fallback. Exactly one substitution per request (loop
 * guard §1.6 steps 3–4).
 *
 * PER CANDIDATE, NOT PER REQUEST (§2.2). The stage evaluates and reserves against the candidate that
 * is about to be dispatched, not "the request". The old rule — provider budgets apply only to the
 * chain HEAD's provider — silently assumed head == served, and routing/resolve.ts builds chains with
 * no same-provider constraint while DISPATCH advances across providers on any retryable failure. Two
 * consequences, both real: a cap scoped to a TAIL provider was filtered out of every request whose
 * head was a different provider (never evaluated, yet reconcile still bumps that provider's counter
 * with the spend), and the request's single hold landed on the HEAD provider's counter row even when
 * it was sized for a different provider's model (false 402s on a cap that spend cannot reach).
 *
 * So: runBudget gates the first candidate (the surface above is unchanged), and DISPATCH calls
 * runCandidateBudget before each candidate it advances onto.
 *
 * WHICH SCOPES ARE PER-CANDIDATE. Only provider-scoped budgets are candidate-specific — their scope id
 * IS the provider (providerScopeId(org, provider)) and the counter row they read is the one reconcile
 * bumps for the served provider. org / team / virtual_key budgets are REQUEST-level: they describe the
 * caller, not the upstream, and every candidate in the chain resolves them to the same counter rows.
 * They are therefore never RE-CHARGED per attempt — at most one hold for this request is outstanding
 * on those rows at any moment. What moves on an advance is the SIZE of that one hold (it is re-sized
 * to the candidate now being dispatched) and the provider row it sits beside; the request-level rows
 * are re-compared, not re-accumulated, and the compare explicitly discounts the hold that is about to
 * be released (see runCandidateBudget) so a request can never block itself by advancing.
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

/** The resolved budget cascade for this request (§1.3) — the one shared ordering every consumer sees. */
function resolveBudgets(ctx: PipelineContext, now: Date): ResolvedBudget[] {
  const policy = ctx.policy;
  return resolveBudgetBundle(
    {
      orgId: policy.orgId,
      teamId: policy.teamId,
      virtualKeyId: policy.virtualKeyId,
      budgets: policy.budgets.map(toResolverBudget),
    },
    now,
  );
}

/** §2.2 — the ENFORCE budgets that bind a dispatch served by `provider`: every request-level scope,
 *  plus the provider-scoped budgets for THAT provider (never another candidate's). */
function enforceFor(
  ctx: PipelineContext,
  resolved: ResolvedBudget[],
  provider: ProviderName | null,
): ResolvedBudget[] {
  return resolved.filter((r) => {
    if (r.budget.mode !== 'enforce') return false;
    if (r.budget.scopeType === 'provider') {
      if (provider === null) return false;
      if (r.budget.scopeId !== providerScopeId(ctx.policy.orgId, provider)) return false;
    }
    return true;
  });
}

/** The counter rows a hold for `provider` sits on, in the canonical SCOPE_RANK lock order. */
function holdRowsFor(ctx: PipelineContext, provider: ProviderName, now: Date): ReservationRow[] {
  const rows: ReservationRow[] = [];
  for (const s of buildBlockScopes(ctx, provider))
    for (const pk of buildBlockPeriodKeys(ctx, now))
      rows.push({ scopeType: s.type, scopeId: s.id, periodKey: pk });
  return rows;
}

function counterKeyOf(r: ReservationRow): string {
  return `${r.scopeType}:${r.scopeId}:${r.periodKey}`;
}

/** Same money on the same rows → the outstanding hold already authorizes this candidate. */
function sameHold(a: BudgetHold, b: BudgetHold): boolean {
  if (a.microUsd !== b.microUsd || a.rows.length !== b.rows.length) return false;
  return a.rows.every((r, i) => counterKeyOf(r) === counterKeyOf(b.rows[i]!));
}

export async function runBudget(ctx: PipelineContext, now: Date = new Date()): Promise<void> {
  const resolved = resolveBudgets(ctx, now);
  const head = ctx.candidateChain[0];
  const headProvider = (head?.provider ?? null) as ProviderName | null;

  // The FIRST candidate's gate. Provider budgets are evaluated against the candidate about to be
  // dispatched (§2.2) — for the first candidate that is the chain head, so this surface is unchanged.
  const enforce = enforceFor(ctx, resolved, headProvider);
  if (enforce.length === 0) return; // no enforce caps bind this candidate → nothing to reserve or check

  // ATOMIC RESERVATION (expanded-audit H2). The old pure snapshot compare let concurrent requests all
  // read spent < limit and all pass a HARD block, then all reconcile past the cap. Now we hold a
  // conservative estimate on the counter rows and compare spent + reserved (which includes concurrent
  // in-flight holds) — so a hard block is exact under concurrency.
  // Head candidate absent or unpriceable → PRICING (next stage) 503s it before it can dispatch/bill,
  // so nothing can overspend. Fall back to the snapshot compare so an ALREADY-over cap still blocks.
  if (head === undefined) return snapshotEnforce(ctx, enforce, resolved, now);
  const estimate = await estimateCandidateCostMicro(ctx, head);
  if (estimate === null) return snapshotEnforce(ctx, enforce, resolved, now);

  const rows = holdRowsFor(ctx, head.provider, now);
  const held = await reserveBudget(ctx, rows, estimate);
  ctx.budgetReservation = { microUsd: estimate, rows };
  ctx.budgetReservationSettled = false;

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

/**
 * Per-candidate gate, called by DISPATCH immediately before it dispatches `candidate` — the first one
 * and every candidate the chain advances onto. Returns false when the candidate must be SKIPPED.
 *
 * WHY skip and not 402 (mirrors denyChainAdvance). By the time the chain advances, a previous
 * candidate has already been dispatched, billed and reconciled; the blocked-row writer would file a
 * status='blocked' `requests` row for this request id, discarding that spend from everything that
 * reads `requests`. A skipped candidate just isn't a viable target — if skipping exhausts the chain,
 * DISPATCH's existing all_providers_failed surfaces, with the billed attempts intact. The FIRST
 * candidate keeps the 402/serve-under-fallback surface, which is runBudget's job above.
 *
 * ORDER OF OPERATIONS (this is the part that must not be got wrong). The new candidate's hold is
 * placed BEFORE the superseded one is released. Release-then-reserve would reopen the exact hole
 * closed by keeping the hold across a non-final reconcile: a window in which the request is between
 * candidates holding nothing, during which a concurrent request reads reserved=0 and passes the same
 * cap. Both holds are therefore outstanding for the length of one UPDATE — a brief OVER-hold, which
 * is the fail-safe direction this whole stage takes.
 *
 * That over-hold must not block the request that owns it, so the compare discounts the superseded
 * hold on any row the two share (the request-level rows: org/team/virtual_key are re-compared, never
 * re-charged). Discounting is honest, not a fudge: the previous attempt's spend has already been
 * reconciled onto `spent_usd` by the time DISPATCH advances (reconcile runs before the advance and
 * deliberately does NOT release on a non-final attempt), so its hold is at that point double-counting
 * money that is already in `spent`. Other requests still see the full over-hold on the row.
 */
export async function runCandidateBudget(
  ctx: PipelineContext,
  candidate: Candidate,
  now: Date = new Date(),
): Promise<boolean> {
  const resolved = resolveBudgets(ctx, now);
  const enforce = enforceFor(ctx, resolved, candidate.provider);
  // The hold currently authorizing this request, if one is still outstanding.
  const prev: BudgetHold | null = ctx.budgetReservationSettled ? null : ctx.budgetReservation;

  if (enforce.length === 0) {
    // Nothing binds this candidate → it needs no authorization. Drop any hold left from the candidate
    // we advanced off (its spend is already reconciled); the request dispatches unheld, exactly as an
    // org with no enforce budgets always has.
    await releaseBudgetReservation(ctx);
    return true;
  }

  const estimate = await estimateCandidateCostMicro(ctx, candidate);
  if (estimate === null) {
    // Unpriceable → PRICING already fail-closed 503'd the whole request if ANY reachable candidate
    // lacked a price, so this is unreachable in a served request. Keep any existing hold (fail-safe)
    // and fall back to the snapshot compare so an ALREADY-over cap still stops the dispatch.
    return !enforce.some(
      (r) => (ctx.spendSnapshot.get(r.counterKey) ?? 0n) >= r.budget.limitMicroUsd,
    );
  }

  const next: BudgetHold = { microUsd: estimate, rows: holdRowsFor(ctx, candidate.provider, now) };
  // runBudget already placed exactly this hold for this candidate (the common case: the first
  // candidate, gated pre-dispatch and dispatched unchanged). Re-reserving would be two extra counter
  // writes and would let a concurrent request flip an already-made 402 decision into a skip.
  if (prev && sameHold(prev, next)) return true;

  const held = await reserveBudget(ctx, next.rows, estimate);
  const prevRows = new Set((prev?.rows ?? []).map(counterKeyOf));
  const over = enforce.filter((r) => {
    const h = held.get(r.counterKey);
    const discount = prevRows.has(r.counterKey) ? (prev?.microUsd ?? 0n) : 0n;
    return (h ? h.spent + h.reserved : 0n) - discount >= r.budget.limitMicroUsd;
  });

  // §1.6: a chain SUBSTITUTED by serve-under-fallback is dispatched as-is. Its budgets are at/over
  // limit by construction (that is why the substitution happened), so blocking here would turn every
  // fallback-served request into an exhausted chain. Take the hold, never the verdict.
  if (over.length > 0 && !ctx.servedUnderBudgetFallback) {
    await releaseHold(ctx, next); // not dispatching → the hold it would have authorized comes straight off
    return false;
  }
  ctx.budgetReservation = next;
  ctx.budgetReservationSettled = false;
  if (prev) await releaseHold(ctx, prev); // reserve-BEFORE-release: never a moment with neither
  return true;
}

/**
 * Pure look-ahead twin of runCandidateBudget: "would this candidate survive its own budget gate?"
 * DISPATCH needs the answer BEFORE it dispatches the current candidate (it decides isFinalAttempt,
 * and the streaming tee needs that set pre-dispatch), so this cannot place a hold — it compares the
 * ROUTE-hoisted spend snapshot plus the candidate's own estimate against each binding cap.
 *
 * It can only ever be OPTIMISTIC relative to the real gate (snapshot spend ≤ fresh spend, and it
 * cannot see other requests' concurrent holds), never pessimistic — so it never talks DISPATCH out of
 * a fallback that would have been allowed. The residual: a candidate this calls viable can still be
 * skipped at reserve time by a concurrent hold, which leaves the failed attempt reconciled non-final
 * (no `requests` row) behind a 502 — the narrow race remainder of the orphaned-row class, kept narrow
 * by pricing the candidate here exactly as the real gate does.
 */
export function candidateBudgetViable(
  ctx: PipelineContext,
  candidate: Candidate,
  now: Date = new Date(),
): boolean {
  if (ctx.servedUnderBudgetFallback) return true; // substituted chains dispatch as-is (§1.6)
  const enforce = enforceFor(ctx, resolveBudgets(ctx, now), candidate.provider);
  if (enforce.length === 0) return true;
  const estimate = estimateCandidateCostMicroSync(ctx, candidate) ?? 0n;
  return !enforce.some(
    (r) => (ctx.spendSnapshot.get(r.counterKey) ?? 0n) + estimate >= r.budget.limitMicroUsd,
  );
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
 *  ([vk, team, org, provider]) so reserve/block and reconcile never deadlock on the shared tuples.
 *  `provider` is the one this write is ABOUT: the candidate being reserved for, or the chain head for
 *  a blocked row (nothing was served, so the head is what the caller asked to spend on). */
function buildBlockScopes(
  ctx: PipelineContext,
  provider: ProviderName | undefined = ctx.candidateChain[0]?.provider,
): Array<{ type: BudgetScopeType; id: string }> {
  const scopes: Array<{ type: BudgetScopeType; id: string }> = [
    { type: 'virtual_key', id: ctx.policy.virtualKeyId },
  ];
  if (ctx.policy.teamId !== null) scopes.push({ type: 'team', id: ctx.policy.teamId });
  scopes.push({ type: 'org', id: ctx.policy.orgId });
  if (provider !== undefined) {
    scopes.push({ type: 'provider', id: providerScopeId(ctx.policy.orgId, provider) });
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
  // blocks_total + requests_total{status=blocked} (§6.3). Emit on the DECISION (before the governance
  // write) so the count is exact even if the fire-and-forget row write below fails. This is the single
  // funnel for every budget block (hard 402 + unresolvable/exhausted fallback). scope_type is the
  // budget's own scope enum; provider/model are 'unknown' (no candidate was served).
  recordBlock('budget_exceeded', r.budget.scopeType);
  recordRequestCompletion('blocked', null, null, ctx.endpoint);
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
  // guardrail or rewrite decision for the same request. Fire-and-forget, but tracked (ADR-033 D6)
  // so app.close() drains it before the DB pool is torn down — an untracked write here raced test
  // teardown under contention (postgres.js wrote to an already-nulled socket, CI-only, 2026-08-08).
  ctx.deps.streamTasks?.track(
    writeDecisionLog(ctx.deps.db, ctx.policy.orgId, {
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
    }),
  );
}
