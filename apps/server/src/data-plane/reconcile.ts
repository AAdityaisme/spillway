import { sql, eq } from 'drizzle-orm';
import { computeCost, formatUsd, parseUsd, type CanonicalUsage } from '@spillway/pricing';
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
  currentPeriodKeys,
  counterPeriodKeys,
  SCOPE_RANK,
  type BudgetScopeType,
} from './budget/resolver.js';
import { releaseBudgetReservation } from './budget/reservation.js';
import { recordReconcileLatency } from './reconcile.slo.js';
import { spendWriteLostTotal } from '../observability/metrics.js';
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
  const { policy, usage, requestId, startedAt, upstreamStatus } = ctx;
  // Release the pre-dispatch budget hold now that this request settles to real spend (idempotent —
  // self-guards on ctx.budgetReservationSettled, so the first attempt's reconcile frees it once).
  await releaseBudgetReservation(ctx);
  try {
    const canonical = toCanonical(usage);
    canonical.serviceTier = ctx.serviceTier; // request-time tier → computeCost multiplier (20 §3)
    const provider = ctx.activeCandidate?.provider ?? ctx.candidate?.provider ?? null;
    const model = ctx.activeCandidate?.model ?? ctx.candidate?.model ?? null;

    let cost: { costMicroUsd: bigint | null; unitPrices: Record<string, string> | null } = {
      costMicroUsd: null,
      unitPrices: null,
    };
    if (provider && model) {
      try {
        const candidate = ctx.activeCandidate ?? ctx.candidate;
        const price = ctx.priceByCandidate.get(candidateKeyOf(candidate)) ?? null;
        cost = computeCost(canonical, price);
      } catch (e) {
        ctx.req.log.error({ e }, 'computeCost failed; recording null cost');
      }
      // Pricing was preflighted before dispatch. Retain this guard as a circuit
      // breaker against a future executor path bypassing that fail-closed stage.
      if (cost.costMicroUsd === null) {
        ctx.req.log.warn(
          { provider, model, requestId },
          'no price for model — spend metered at $0 (budget-invisible)',
        );
      }
    }
    const costStr = cost.costMicroUsd === null ? null : formatUsd(cost.costMicroUsd);
    // A streaming request commits http 200 BEFORE a mid-stream failure is known; an errorCode means
    // error even if upstreamStatus stayed 200 (ADR-034 M8). client_closed is its own attempt outcome.
    const ok = upstreamStatus >= 200 && upstreamStatus < 300 && !ctx.errorCode;
    const isClientClose = ctx.errorCode != null && ctx.errorCode.includes('client_closed');
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
            attemptNumber: ctx.attemptNumber,
            orgId: policy.orgId,
            provider,
            model,
            outcome,
            errorCode: ctx.errorCode,
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
            ttftMs: ctx.timings.firstByte ?? null,
          })
          .onConflictDoNothing({
            target: [requestAttempts.requestId, requestAttempts.attemptNumber],
          })
          .returning({ requestId: requestAttempts.requestId });
        if (gate.length === 0) return; // already settled — whole tx no-ops, no double charge

        // step 2: per-attempt counter bump (scopes incl. this attempt's provider; §1.8). request_count
        // increments once per logical request, only when the final attempt succeeded (§4.4).
        const rc = ctx.isFinalAttempt && outcome === 'ok' ? 1 : 0;
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

        if (ctx.isFinalAttempt) {
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
            errorCode: ctx.errorCode,
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
            ttftMs: ctx.timings.firstByte ?? null,
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
    if (ctx.isFinalAttempt && outcome === 'ok' && ctx.knobs.sessionId !== null) {
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
    if (ctx.isFinalAttempt && postCounters && requestTotalMicro && requestTotalMicro > 0n) {
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
    if (ctx.isFinalAttempt) {
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
  } catch (err) {
    // Post-response: the client already has its answer. Losing a spend row is bad, but throwing here
    // would crash the request handler for a response that's already gone. The `lost` payload is the
    // recovery record — enough to hand-replay this settle; alert on the `spend_write_lost` key.
    ctx.req.log.error(
      {
        err,
        requestId,
        lost: {
          attemptNumber: ctx.attemptNumber,
          orgId: policy.orgId,
          virtualKeyId: policy.virtualKeyId,
          teamId: policy.teamId, // scope needed to replay the team-scope counter bump
          provider: ctx.activeCandidate?.provider ?? null, // served provider/model → recompute cost
          model: ctx.activeCandidate?.model ?? null,
          errorCode: ctx.errorCode,
          upstreamStatus,
          isFinalAttempt: ctx.isFinalAttempt,
          usage: ctx.usage, // token counts → cost; with provider/model the settle is hand-replayable
        },
      },
      'spend_write_lost — reconcile failed after retries; spend not recorded',
    );
    spendWriteLostTotal.inc();
  }
}
