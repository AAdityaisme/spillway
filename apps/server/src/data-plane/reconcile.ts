import { sql, eq } from 'drizzle-orm';
import {
  computeCost,
  formatUsd,
  parseUsd,
  type CanonicalUsage,
  type CostResult,
} from '@spillway/pricing';
import { withOrg } from '../db/tenancy.js';
import { evaluateAndFireBudgetThresholds, type PostCounter } from '../services/alerts/threshold.js';
import { sessionPinKey } from './routing/session-pin.js';
import { fireBurstEvent } from '../services/alerts/burst.js';
import { getActiveCatalogVersionId } from './pricing-catalog.js';
import { requests, requestAttempts, spendCounters } from '../db/schema.js';
// counterPeriodKeys from the resolver (NOT a local copy) so reconcile + BUDGET + GUARDRAIL share ONE
// period-key impl — a drift would make reconcile write counters BUDGET can't read (red-team B3-3)
// AND fork the canonical spend_counters lock order (the ABBA deadlock class).
import {
  providerScopeId,
  counterPeriodKeys,
  SCOPE_RANK,
  type BudgetScopeType,
} from './budget/resolver.js';
import { releaseBudgetReservation } from './budget/reservation.js';
import { recordReconcileLatency } from './reconcile.slo.js';
import {
  spendWriteLostTotal,
  recordRequestCompletion,
  observeRequestDuration,
  recordSpendUsd,
  recordTokens,
} from '../observability/metrics.js';
import type { ProviderName } from './routing/compile.js';
import type { PipelineContext } from './pipeline/context.js';
import type { ParsedUsage } from './providers/types.js';
import { candidateKeyOf } from './routing/resolve.js';

/**
 * RECONCILE (05-gateway-core §8; ADR-007/008/010) — the audit + spend write.
 *
 * Invariants that MUST hold (this is the money path — get it wrong and either we
 * over-bill tenants or under-count spend and blow budgets):
 *  - ALL writes happen inside ONE `withOrg` tx so they share the `app.current_org_id`
 *    GUC that RLS enforces on `requests`/`spend_counters` (no GUC → 0 rows written, silently).
 *  - request_count ALWAYS increments (+1), even on upstream errors and unpriced models.
 *  - Money is bigint micro-USD end to end, formatted to a numeric(14,6) string at the DB
 *    boundary — NEVER parseFloat (ADR-019e). `unitPrices` snapshots the rates actually
 *    applied so a later price change can't retroactively rewrite a historical cost.
 *  - This function NEVER throws to its caller post-response: a spend-write failure is
 *    logged, not propagated (the client already has its answer).
 */

/** ParsedUsage (snake, provider-shaped) → pricing.CanonicalUsage (camel). Distinct types on
 *  purpose: the adapter speaks the wire format, the pricing engine speaks the canonical one. */
function toCanonical(u: ParsedUsage | null): CanonicalUsage & { usageEstimated: boolean } {
  if (!u)
    return {
      inputTokens: 0,
      outputTokens: 0,
      cachedReadTokens: 0,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
      reasoningTokens: 0,
      usageEstimated: true, // null usage → we recorded zeros we didn't measure; flag it (ADR-008)
    };
  return {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    cachedReadTokens: u.cached_read_tokens,
    cacheWrite5mTokens: u.cache_write_5m_tokens,
    cacheWrite1hTokens: u.cache_write_1h_tokens,
    reasoningTokens: u.reasoning_tokens,
    // Part III multi-modal (part-3/04): carry the dimensions the adapter parsed (undefined → 0 at
    // computeCost). image_input_units → imageInputCount is the frozen ADR-P3-1 snake↔camel/units↔count
    // seam. The remaining dimensions (tool/web-search/region) are added as adapters learn to parse them.
    audioInputTokens: u.audio_input_tokens,
    audioOutputTokens: u.audio_output_tokens,
    imageInputCount: u.image_input_units,
    // Propagate the flag — do NOT hardcode false. The streaming parser returns non-null usage
    // with usage_estimated:true on the estimate path; hardcoding false would record an estimate
    // as measured, corrupting the governance signal (red-team / Phase C graft).
    usageEstimated: u.usage_estimated,
  };
}

/**
 * Build the request's `metadata` jsonb: `x-spillway-tags` header (≤10 keys) merged with
 * the request body's `metadata` (body wins on key collision), plus `original_max_tokens`
 * when VALIDATE clamped it. Hard-bounded — ≤16 keys, key≤64 chars, value≤256 — so a
 * caller can't bloat the row or smuggle a megabyte into the audit log (04 §1.6).
 */
export function extractMetadata(ctx: PipelineContext): Record<string, string> {
  // null-prototype map: (1) inherited names ('toString','constructor',…) don't resolve, so the
  // `>=16` cap can't be bypassed by sending prototype property names (red-team ADR-032 M2);
  // (2) '__proto__' becomes a plain data key, not the accessor → no prototype pollution.
  const out = Object.create(null) as Record<string, string>;
  const put = (k: unknown, v: unknown): void => {
    if (typeof k !== 'string') return;
    const key = k.slice(0, 64);
    if (!Object.hasOwn(out, key) && Object.keys(out).length >= 16) return; // cap; allow overwrites (body wins)
    const val = typeof v === 'string' ? v : JSON.stringify(v);
    if (val === undefined) return; // JSON.stringify(undefined) === undefined → skip
    out[key] = val.slice(0, 256);
  };

  const tagsHeader = ctx.req.headers['x-spillway-tags'];
  if (typeof tagsHeader === 'string') {
    try {
      const parsed: unknown = JSON.parse(tagsHeader);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        let n = 0;
        for (const [k, v] of Object.entries(parsed)) {
          if (n++ >= 10) break;
          put(k, v);
        }
      }
    } catch {
      // malformed tags header → ignore; never fail a request over a metadata header
    }
  }

  const meta = ctx.validatedBody.metadata;
  if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
    let bn = 0;
    for (const [k, v] of Object.entries(meta)) {
      if (bn++ >= 64) break; // bound the scan; put() still enforces the ≤16 own-key cap
      put(k, v);
    }
  }

  const omt = ctx.validatedBody.original_max_tokens;
  if (omt !== undefined) put('original_max_tokens', omt);

  // Return a NORMAL-prototype object: drizzle's entity check reads `value.constructor`, which
  // throws on a null-proto object. Spread copies own keys (incl. any '__proto__' data key) via
  // CreateDataProperty — no prototype set, no pollution — so the null-proto safety is preserved.
  return { ...out };
}

/** Transient-failure backoff for the settle tx; past the last entry the row is declared lost. */
const RECONCILE_RETRY_DELAYS_MS = [250, 1000];

/**
 * RECONCILE (17 §4.2) — the attempts-ledger write. ONE withOrg tx: a per-request advisory lock
 * (nothing-lost, §4.2 step 0), the request_attempts idempotency gate (ON CONFLICT DO NOTHING — a
 * retried reconcile no-ops the whole tx, no double charge), the per-attempt counter bump (incl. the
 * provider scope; request_count success-only), and — on the final attempt — the aggregated requests
 * row (cost_usd = SUM(attempts), §4.3). Never throws to the caller post-response.
 */
export async function runReconcile(ctx: PipelineContext): Promise<void> {
  const { policy, usage, requestId, startedAt, upstreamStatus, attemptNumber, errorCode } = ctx;
  /**
   * THE RULE FOR EVERY `ctx` READ IN THIS FUNCTION — read it before you add one.
   *
   *   ATTEMPT-SCOPED state MUST be read from the entry snapshot below, never off `ctx`.
   *   REQUEST-SCOPED state MAY be read live off `ctx`.
   *
   * WHY. `ctx` is ONE mutable object for the whole request, and DISPATCH rewrites the attempt-scoped
   * fields on it every time the candidate chain advances. That is only safe while this invocation is
   * the one the chain is waiting on — and it is not always. guardedReconcile (streaming/sse-tee.ts)
   * races every reconcile against RECONCILE_TIMEOUT_MS and ABANDONS the loser: nothing cancels the
   * promise, it keeps running, and runStreamChain advances to the next candidate the moment the race
   * resolves. So a reconcile CAN OUTLIVE ITS OWN ATTEMPT. An invocation entered for candidate A can
   * reach any line below at a moment when `ctx` already describes candidate B, and every live read of
   * an attempt-scoped field then silently settles A's money against B's identity.
   *
   * ATTEMPT-SCOPED (snapshot; each is rewritten per candidate by dispatch.ts / sse-tee.ts):
   *   attemptNumber   — the ledger PK. Reading it live writes A's data under B's key; B's own insert
   *                     then hits the ON CONFLICT DO NOTHING gate, its whole settle tx no-ops, and B's
   *                     real spend is gone with no error raised anywhere. Silent loss, the worst
   *                     failure this path has.
   *   isFinalAttempt  — decides the aggregated `requests` row. Read live, A writes or skips that row on
   *                     B's flag: a skip loses it outright; a write collides with B's step-3 insert,
   *                     rolling B's settle back through both retries into spend_write_lost.
   *   errorCode       — dispatch.ts nulls it before the next attempt. Read live it records
   *                     error_code NULL on an outcome='error' row — and `outcome` is derived HERE, at
   *                     entry, so the two would be sampled at different instants and disagree.
   *   budgetReservation — the in-flight hold. See the identity check in the finally.
   *   timings.firstByte — this attempt's TTFT. Only set on commit, so the damage is a wrong ttft_ms
   *                     rather than wrong money; snapshotted anyway, because leaving one field of the
   *                     set live is what makes the next reader assume the set was audited and safe.
   *
   * REQUEST-SCOPED (safe live — set once, pre-dispatch, and never per candidate): policy, requestId,
   * startedAt, upstreamStatus, usage, serviceTier, priceByCandidate, servedUnderBudgetFallback,
   * requestFeatures, requestedModel, endpoint, stream, knobs, validatedBody, req, routeResult, deps,
   * and fallbackFrom (it only accumulates, and only the final attempt — the last one — reads it).
   *
   * The two `activeCandidate ?? candidate` reads that survive below are attempt-scoped but provably
   * safe: provider/model are already derived at entry, and the session pin is gated on `isFinal`,
   * which a chain never advances off. The `lost` diagnostics deliberately keep reading `ctx.usage`
   * live — that payload is a hand-replay aid, and the freshest view is the useful one there.
   */
  const isFinal = ctx.isFinalAttempt;
  const heldAtEntry = ctx.budgetReservation;
  const ttftMs = ctx.timings.firstByte ?? null;
  try {
    const canonical = toCanonical(usage);
    canonical.serviceTier = ctx.serviceTier; // request-time tier → computeCost multiplier (20 §3)
    const provider = ctx.activeCandidate?.provider ?? ctx.candidate?.provider ?? null;
    const model = ctx.activeCandidate?.model ?? ctx.candidate?.model ?? null;

    let cost: CostResult = {
      costMicroUsd: null,
      unitPrices: null,
      unpricedDimensions: null,
    };
    if (provider && model) {
      try {
        const candidate = ctx.activeCandidate ?? ctx.candidate;
        const price = ctx.priceByCandidate.get(candidateKeyOf(candidate)) ?? null;
        cost = computeCost(canonical, price);
      } catch (e) {
        ctx.req.log.error({ e }, 'computeCost failed; recording null cost');
      }
      // A null cost here is NOT routine. runPricing() rejects an unpriced model pre-dispatch (503),
      // and computeCost now ceiling-bills unpriced CACHE lines rather than voiding the whole request,
      // so the only way to land here is a request that populated a modal dimension (audio / image /
      // tool session / web search) the model has no rate for and no derivable bound. The usage is
      // still recorded on the attempt row with cost_usd NULL so it can be re-priced once the rate is
      // added — but the counter bump below adds $0, which means THIS request's real spend is invisible
      // to budgets. That residual is deliberate (inventing a modal price is worse than knowing we do
      // not have one) and is why this logs at error: it wants a catalog fix, not a silent shrug.
      if (cost.costMicroUsd === null) {
        ctx.req.log.error(
          { provider, model, requestId, unpricedDimensions: cost.unpricedDimensions },
          'unpriced dimension with no derivable bound — spend metered at $0 (budget-invisible)',
        );
      } else if (cost.unpricedDimensions !== null) {
        // Priced, but at least one cache line was billed at the input-rate CEILING instead of its own
        // (missing) rate. Spend IS metered and budgets DO see it — it is an upper bound, so a
        // statement may over-state this line until the catalog gains the rate. Snapshotted on the row
        // as unit_prices.unpriced_dimensions.
        ctx.req.log.warn(
          { provider, model, requestId, unpricedDimensions: cost.unpricedDimensions },
          'cache dimension unpriced — billed at the input-rate ceiling',
        );
      }
    }
    const costStr = cost.costMicroUsd === null ? null : formatUsd(cost.costMicroUsd);
    // A streaming request commits http 200 BEFORE a mid-stream failure is known; an errorCode means
    // error even if upstreamStatus stayed 200 (ADR-034 M8). client_closed is its own attempt outcome.
    const ok = upstreamStatus >= 200 && upstreamStatus < 300 && !errorCode;
    const isClientClose = errorCode != null && errorCode.includes('client_closed');
    const outcome: 'ok' | 'error' | 'client_closed' = ok
      ? 'ok'
      : isClientClose
        ? 'client_closed'
        : 'error';
    const finalStatus = ok ? 'ok' : 'error';
    const now = new Date();
    const elapsedMs = now.getTime() - startedAt;
    const cacheWriteTokens = canonical.cacheWrite5mTokens + canonical.cacheWrite1hTokens;
    // Part III (part-3/04): stamp the active price-catalog version so this request's cost re-derives from
    // the immutable snapshot. Cached read (global); NULL until the first sync writes a version (legacy-safe).
    const catalogVersionId = await getActiveCatalogVersionId(ctx.deps.db, now.getTime());

    // §5.1 threshold-alert inputs: the counter values AFTER this reconcile's upsert (captured from
    // RETURNING) so the fire-and-forget hook can detect an 80%/100% crossing without a re-read.
    let postCounters: PostCounter[] | null = null;
    // The delta this ENTIRE request added to the counters = SUM of every attempt's cost (captured from
    // the final-attempt aggregate, below), NOT just the final attempt's. The threshold hook derives
    // pre = post - delta; using the final attempt alone overstated pre, so a band crossed by an earlier
    // billed fallback attempt (bill-on-failure) was never detected (red-team audit F8).
    let requestTotalMicro: bigint | null = null;

    const reconcileStart = Date.now();
    // Did THIS call actually write the attempt row (gate passed), vs. no-op on an already-settled
    // replay? Only a real write should emit request/token/spend metrics — so a crash-recovery replay
    // (idempotency-gate conflict) never double-counts. Set INSIDE the tx, read AFTER the retry loop
    // (so a transient-retry that rolls back + re-runs still counts exactly once).
    let attemptSettled = false;
    const settle = (): Promise<void> =>
      withOrg(ctx.deps.db, policy.orgId, async (tx) => {
        // step 0: serialize concurrent settles OF THE SAME REQUEST (auto-releases at commit).
        // Two-int form → a lock space SEPARATE from the scheduler's single-key advisory locks (no
        // cross-subsystem collision), keyed (hashtext(org), hashtext(request)). The old single 32-bit
        // hashtext(request) key shared one space with every request AND the scheduler, so UNRELATED
        // requests collided and serialized their entire settle tx — the reconcile SLO-miss suspect
        // (expanded-audit MED). Now different orgs never collide, and blast radius is bounded to one
        // org's 32-bit request-hash space. NOTE: re-measure the p50 against real infra to confirm.
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${policy.orgId}), hashtext(${requestId}))`,
        );

        // step 1: idempotency gate — settle THIS attempt exactly once.
        const gate = await tx
          .insert(requestAttempts)
          .values({
            requestId,
            attemptNumber,
            orgId: policy.orgId,
            provider,
            model,
            outcome,
            errorCode,
            inputTokens: canonical.inputTokens,
            outputTokens: canonical.outputTokens,
            cachedReadTokens: canonical.cachedReadTokens,
            cacheWriteTokens,
            reasoningTokens: canonical.reasoningTokens,
            costUsd: costStr,
            unitPrices: cost.unitPrices,
            usageEstimated: canonical.usageEstimated,
            servedUnderBudgetFallback: ctx.servedUnderBudgetFallback,
            elapsedMs,
            ttftMs,
          })
          .onConflictDoNothing({
            target: [requestAttempts.requestId, requestAttempts.attemptNumber],
          })
          .returning({ requestId: requestAttempts.requestId });
        if (gate.length === 0) return; // already settled — whole tx no-ops, no double charge
        attemptSettled = true; // this call inserted the attempt row → its metrics may emit (below)

        // step 2: per-attempt counter bump (scopes incl. this attempt's provider; §1.8). request_count
        // increments once per logical request, only when the final attempt succeeded (§4.4).
        const rc = isFinal && outcome === 'ok' ? 1 : 0;
        const costToAdd = costStr ?? '0';
        const scopes: Array<{ scopeType: BudgetScopeType; scopeId: string }> = [
          { scopeType: 'virtual_key', scopeId: policy.virtualKeyId },
          { scopeType: 'org', scopeId: policy.orgId },
        ];
        if (policy.teamId) scopes.push({ scopeType: 'team', scopeId: policy.teamId });
        if (provider) {
          scopes.push({
            scopeType: 'provider',
            scopeId: providerScopeId(policy.orgId, provider as ProviderName),
          });
        }
        // Lock the shared spend_counters tuples in the canonical SCOPE_RANK order ([vk, team, org,
        // provider]) — the SAME order reserveBudget / logBlockedRequest use. This upsert previously ran
        // [vk, org, team], so a concurrent reconcile and reserve/block on the same org+team locked those
        // two tuples in opposite order → deadlock (ABBA, 40P01) → the reconcile victim lost the spend row
        // after retry exhaustion (red-team money-core #1). Sort makes the order assembly-independent.
        scopes.sort((a, b) => SCOPE_RANK[a.scopeType] - SCOPE_RANK[b.scopeType]);
        // billed:false (cost 0 AND no request-count delta) ⇒ no counter row. A zero-delta upsert only
        // churns updated_at (masking true last-spend time) and materializes provider/team counter rows
        // for spend that never happened — contradicting the bill-on-failure classifier's documented
        // 'billed:false ⇒ no counter bump' invariant (audit L15). A priced-at-$0 OK final attempt still
        // bumps (rc=1), so this only skips genuinely non-billed settles (pre-dispatch aborts, errors).
        // Compare the BIGINT cost, not the formatted string: `costStr !== '0'` was true for a
        // computed zero ("0.000000"), so $0-priced error attempts wrote the zero-delta rows anyway
        // (task #15, decided 2026-07-19: counters are money-only; activity lives in the ledger).
        // µUSD bigint end-to-end per ADR-019e — never a float round-trip on money.
        const billed = (cost.costMicroUsd ?? 0n) !== 0n || rc !== 0;
        if (billed) {
          // ONE multi-row upsert for the whole scope×period matrix (up to 4×3 rows). The old
          // per-row loop was 8–14 sequential round-trips inside the settle tx — the dominant
          // term in reconcile latency (17 §4.6 SLO). Rows are distinct per (scope, period), so
          // the single ON CONFLICT statement never touches a row twice; the excluded.* arithmetic
          // is identical to the per-row version.
          const counterRows = scopes.flatMap((s) =>
            counterPeriodKeys(policy.budgets, now).map((pk) => ({
              orgId: policy.orgId,
              scopeType: s.scopeType,
              scopeId: s.scopeId,
              periodKey: pk,
              spentUsd: costToAdd,
              requestCount: rc,
              blockedCount: 0,
              updatedAt: now,
            })),
          );
          const bumped = await tx
            .insert(spendCounters)
            .values(counterRows)
            .onConflictDoUpdate({
              target: [spendCounters.scopeType, spendCounters.scopeId, spendCounters.periodKey],
              set: {
                spentUsd: sql`${spendCounters.spentUsd} + excluded.spent_usd`,
                requestCount: sql`${spendCounters.requestCount} + excluded.request_count`,
                updatedAt: now,
              },
            })
            .returning({
              scopeType: spendCounters.scopeType,
              scopeId: spendCounters.scopeId,
              periodKey: spendCounters.periodKey,
              spentUsd: spendCounters.spentUsd,
            });
          // Capture the post-increment values for the threshold hook (§5). RETURNING on the upsert is
          // free — no extra round-trip — and gives the committed `spent_usd` per scope×period.
          postCounters = bumped.map((r) => ({
            scopeType: r.scopeType,
            scopeId: r.scopeId,
            periodKey: r.periodKey,
            spentMicro: parseUsd(r.spentUsd),
          }));
        }

        if (isFinal) {
          // step 3: aggregate the ledger into the ONE requests row (PK-collision idempotent, §4.3).
          const agg = (
            await tx
              .select({
                cost: sql<string | null>`sum(${requestAttempts.costUsd})`,
                inTok: sql<number>`coalesce(sum(${requestAttempts.inputTokens}),0)`,
                outTok: sql<number>`coalesce(sum(${requestAttempts.outputTokens}),0)`,
                cachedTok: sql<number>`coalesce(sum(${requestAttempts.cachedReadTokens}),0)`,
                cacheWriteTok: sql<number>`coalesce(sum(${requestAttempts.cacheWriteTokens}),0)`,
                reasoningTok: sql<number>`coalesce(sum(${requestAttempts.reasoningTokens}),0)`,
                // usage_estimated must summarize the LEDGER it aggregates: if ANY attempt was an
                // estimate, part of the summed cost is estimated. Using the final attempt's flag alone
                // understates estimation exposure when a torn earlier attempt was billed (audit L14).
                usageEstimated: sql<boolean>`coalesce(bool_or(${requestAttempts.usageEstimated}), false)`,
              })
              .from(requestAttempts)
              .where(eq(requestAttempts.requestId, requestId))
          )[0]!;
          // The whole request's counter contribution (all attempts) — feeds the threshold hook's
          // pre = post - delta so a band crossed by an earlier billed attempt is still detected (F8).
          requestTotalMicro = agg.cost !== null ? parseUsd(agg.cost) : null;

          const features = {
            ...ctx.requestFeatures,
            finish_reason: null,
            q_fallback: ctx.fallbackFrom.length > 0,
            q_provider_error: outcome !== 'ok',
            q_truncated: false,
          };

          await tx.insert(requests).values({
            id: requestId,
            orgId: policy.orgId,
            virtualKeyId: policy.virtualKeyId,
            teamId: policy.teamId,
            provider,
            model,
            requestedModel: ctx.requestedModel,
            endpoint: ctx.endpoint ?? 'chat_completions', // NOT NULL; default preserves the pre-/v1/messages behavior

            status: finalStatus,
            errorCode,
            httpStatus: upstreamStatus || null,
            stream: ctx.stream,
            inputTokens: agg.inTok,
            outputTokens: agg.outTok,
            cachedReadTokens: agg.cachedTok,
            cacheWriteTokens: agg.cacheWriteTok,
            reasoningTokens: agg.reasoningTok,
            usageEstimated: agg.usageEstimated, // bool_or over the ledger, not just this attempt (L14)
            catalogVersionId,
            costUsd: agg.cost,
            unitPrices: cost.unitPrices,
            latencyMs: elapsedMs,
            ttftMs,
            fallbackFrom: ctx.fallbackFrom.length > 0 ? ctx.fallbackFrom : null,
            routingRuleId: ctx.routeResult?.routingRuleId ?? null,
            configSnapshotHash: policy.configSnapshotHash,
            requestFeatures: features,
            metadata: extractMetadata(ctx),
            createdAt: now,
          });
        } else {
          // step 4: a non-final attempt settling AFTER the final one re-derives the FULL requests row
          // from SUM(attempts) — cost AND every token column, mirroring step 3 — so attribution is
          // order-independent no matter which attempt's usage lands last (no-op until the requests row
          // exists). Previously only costUsd was repaired, leaving the token columns latently stale if
          // the sequential-settle assumption were ever broken (expanded-audit LOW).
          const lateAgg = (
            await tx
              .select({
                cost: sql<string | null>`sum(${requestAttempts.costUsd})`,
                inTok: sql<number>`coalesce(sum(${requestAttempts.inputTokens}),0)`,
                outTok: sql<number>`coalesce(sum(${requestAttempts.outputTokens}),0)`,
                cachedTok: sql<number>`coalesce(sum(${requestAttempts.cachedReadTokens}),0)`,
                cacheWriteTok: sql<number>`coalesce(sum(${requestAttempts.cacheWriteTokens}),0)`,
                reasoningTok: sql<number>`coalesce(sum(${requestAttempts.reasoningTokens}),0)`,
                usageEstimated: sql<boolean>`coalesce(bool_or(${requestAttempts.usageEstimated}), false)`,
              })
              .from(requestAttempts)
              .where(eq(requestAttempts.requestId, requestId))
          )[0]!;
          await tx
            .update(requests)
            .set({
              costUsd: lateAgg.cost,
              inputTokens: lateAgg.inTok,
              outputTokens: lateAgg.outTok,
              cachedReadTokens: lateAgg.cachedTok,
              cacheWriteTokens: lateAgg.cacheWriteTok,
              reasoningTokens: lateAgg.reasoningTok,
              usageEstimated: lateAgg.usageEstimated, // keep the flag in sync with the re-derived ledger (L14)
            })
            .where(eq(requests.id, requestId));
        }
      });
    // "Nothing lost, ever": the settle is idempotent by construction (advisory lock + attempt
    // ON CONFLICT), so a transient DB blip gets two bounded retries before the row is declared lost.
    for (let retry = 0; ; retry++) {
      try {
        await settle();
        break;
      } catch (err) {
        const delayMs = RECONCILE_RETRY_DELAYS_MS[retry];
        if (delayMs === undefined) throw err;
        ctx.req.log.warn({ err, requestId, delayMs }, 'reconcile write failed — retrying');
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
    recordReconcileLatency(Date.now() - reconcileStart); // SLO instrument (17 §4.6)

    // Sticky session affinity (15 §4.5): a successful dispatch pins the session to the served candidate
    // (resets the 5-min TTL). Final OK attempt only — a failed fallback attempt must never pin. ROUTE
    // reads this pin on the next request in the conversation.
    if (isFinal && outcome === 'ok' && ctx.knobs.sessionId !== null) {
      const served = ctx.activeCandidate ?? ctx.candidate;
      if (served)
        ctx.deps.sessionPinStore.set(sessionPinKey(policy.orgId, ctx.knobs.sessionId), served);
    }

    // §5.1 threshold alerting: a fire-and-forget hook AFTER the settle commits, on the final attempt
    // only. NOT awaited — reconcile is commit-before-ack (on the latency path), so evaluation + the
    // alert_events writes run in the background and never add to the response time. The pre value is the
    // committed post minus the spend this WHOLE request added (requestTotalMicro = SUM of all attempts),
    // so a band crossed by an earlier billed fallback attempt is still detected — using only the final
    // attempt's cost overstated pre and silently swallowed that crossing (red-team audit F8).
    if (isFinal && postCounters && requestTotalMicro && requestTotalMicro > 0n) {
      const captured = postCounters;
      const deltaMicro = requestTotalMicro;
      void withOrg(ctx.deps.db, policy.orgId, (tx) =>
        evaluateAndFireBudgetThresholds(tx, {
          orgId: policy.orgId,
          budgets: policy.budgets,
          postCounters: captured,
          deltaMicro,
          now,
        }),
      ).catch((err: unknown) => {
        ctx.req.log.warn({ err, requestId }, 'budget threshold-alert evaluation failed');
      });
    }

    // §3.1 burst heuristic: track this request in the in-process per-key RPM window (all final requests
    // count, not just billed ones). On a spike fire a deduped burst event — fire-and-forget, off the
    // latency path. The tracker is in-process (resets on restart); the DB write is the only I/O.
    if (isFinal) {
      const burst = ctx.deps.burstTracker.record(policy.virtualKeyId, now);
      if (burst.fire) {
        void withOrg(ctx.deps.db, policy.orgId, (tx) =>
          fireBurstEvent(tx, {
            orgId: policy.orgId,
            virtualKeyId: policy.virtualKeyId,
            ev: burst,
            now,
          }),
        ).catch((err: unknown) => ctx.req.log.warn({ err, requestId }, 'burst event fire failed'));
      }
    }

    // Request-path catalog (§6.3). Only on a real write (not a replay no-op). requests_total +
    // request_duration_ms are per LOGICAL request → the final attempt only. tokens_total +
    // spend_usd_total mirror the per-attempt counter bump (`billed`), so multi-attempt spend sums
    // across attempts exactly as spend_counters does. provider/model are the served candidate
    // (post-route catalog) — the cardinality guard in metrics.ts maps a null to 'unknown'.
    if (attemptSettled) {
      if (isFinal) {
        recordRequestCompletion(finalStatus, provider, model, ctx.endpoint);
        observeRequestDuration(provider, model, ctx.stream, elapsedMs);
      }
      // Mirror the counter-bump predicate EXACTLY (see `billed` in step 2): compare the µUSD bigint,
      // not the formatted string — `costStr !== '0'` is true for a computed zero ("0.000000"), which
      // would emit spend_usd_total for $0 error attempts that spend_counters deliberately skips.
      const rcForMetrics = isFinal && outcome === 'ok' ? 1 : 0;
      const billedForMetrics = (cost.costMicroUsd ?? 0n) !== 0n || rcForMetrics !== 0;
      if (billedForMetrics) {
        recordSpendUsd(policy.orgId, provider, model, cost.costMicroUsd);
        recordTokens(provider, model, canonical);
      }
    }
  } catch (err) {
    // Post-response: the client already has its answer. Losing a spend row is bad, but throwing here
    // would crash the request handler for a response that's already gone. The `lost` payload is the
    // recovery record — enough to hand-replay this settle; alert on the `spend_write_lost` key.
    ctx.req.log.error(
      {
        err,
        requestId,
        lost: {
          attemptNumber,
          orgId: policy.orgId,
          virtualKeyId: policy.virtualKeyId,
          teamId: policy.teamId, // scope needed to replay the team-scope counter bump
          provider: ctx.activeCandidate?.provider ?? null, // served provider/model → recompute cost
          model: ctx.activeCandidate?.model ?? null,
          errorCode,
          upstreamStatus,
          isFinalAttempt: isFinal,
          usage: ctx.usage, // token counts → cost; with provider/model the settle is hand-replayable
        },
      },
      'spend_write_lost — reconcile failed after retries; spend not recorded',
    );
    spendWriteLostTotal.inc();
  } finally {
    // WHY the isFinalAttempt gate (red-team P0). DISPATCH also calls runReconcile for NON-FINAL
    // attempts — dispatch.ts's retryable-failure branch and runStreamChain's pre-commit failure branch
    // — purely to land that attempt's ledger row before advancing to the next candidate. Releasing
    // there freed the WHOLE pre-dispatch hold while the request was still in flight and about to
    // dispatch a possibly PRICIER fallback, and nothing re-reserves (BUDGET runs exactly once,
    // pre-dispatch, from the route). A concurrent request on the same scope then read reserved=0,
    // passed the same enforce cap, took its own hold, and both settled — ~2× a hard cap off one retry.
    // That nullified H2's atomic reservation during precisely the retry window it exists for, and made
    // the max-over-chain hold sizing (estimateRequestCostMicro) inert. So the hold is kept until the
    // request has genuinely stopped dispatching: isFinalAttempt is set true by every terminating path
    // (success, terminal/exhausted upstream error, client disconnect, stream commit) and only there.
    // Released AFTER the settle above, not before it, so `reserved` drops only once `spent` has
    // risen — a concurrent compare never sees a window with neither.
    // NOT a hold leak on the non-final path: every exit that ends WITHOUT a final reconcile (a
    // pre-dispatch throw, an exhausted chain that throws before reconciling, a hijacked stream whose
    // reconcile hit RECONCILE_TIMEOUT_MS and was abandoned) is covered by the route's finally in
    // chat-completions/messages/embeddings, which calls this same release. Idempotent via
    // ctx.budgetReservationSettled, set SYNCHRONOUSLY before the DB write, so the route's release and
    // this one can never both credit the counter.
    //
    // AND the identity check — belt to the `isFinal` braces, deliberately. releaseBudgetReservation
    // releases ctx's CURRENT hold, whatever that is by the time an ABANDONED reconcile
    // (guardedReconcile's RECONCILE_TIMEOUT_MS arm) gets here; if the chain advanced meanwhile, that is
    // the SUCCESSOR's hold and crediting it back frees money authorizing a candidate still dispatching.
    // The `isFinal` snapshot already covers every shape reachable TODAY, because a chain only ever
    // advances off a NON-final attempt (runStreamChain: isFinalAttempt = !hasNext, and it rethrows
    // rather than advancing when hasNext is false) — so an invocation entered final never has a
    // successor to steal from. This check costs one reference compare and keeps that from being a
    // silent load-bearing assumption about dispatch's control flow. Reference identity is the right
    // test: runCandidateBudget assigns a FRESH BudgetHold object per candidate, never mutates one in
    // place. When it does not match, the hold this invocation was entered under was already released by
    // the advance itself (releaseHold at the end of runCandidateBudget), and the successor's hold
    // belongs to the successor's own final reconcile — or, failing that, to the route's finally, which
    // still fires because declining here also leaves budgetReservationSettled false.
    // Residual: runCandidateBudget's sameHold() early-return keeps the SAME object across an advance,
    // which this compare cannot distinguish. Harmless — it is the same money on the same rows,
    // authorizing both candidates identically — and closing it properly needs a hold generation counter
    // on PipelineContext.
    if (isFinal && heldAtEntry === ctx.budgetReservation) await releaseBudgetReservation(ctx);
  }
}
