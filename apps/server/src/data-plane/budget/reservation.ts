import { sql } from 'drizzle-orm';
import { formatUsd, parseUsd, type ModelPriceRow } from '@spillway/pricing';
import { withOrg } from '../../db/tenancy.js';
import { getModelPrice } from '../pricing.js';
import { candidateKeyOf } from '../routing/resolve.js';
import type { Candidate } from '../routing/compile.js';
import { completionCount } from '../pipeline/validate.js';
import type { PipelineContext } from '../pipeline/context.js';

/**
 * Atomic budget reservation (expanded-audit HIGH H2). A conservative cost estimate is held on the
 * counter rows BEFORE the candidate that would spend it is dispatched, so concurrent requests see
 * each other's in-flight holds and cannot all pass a hard cap. `reserved_usd` is separate from
 * `spent_usd` (the money truth), so the ledger invariant is untouched; a crashed request that never
 * releases only inflates the hold → the budget blocks slightly early (fail-safe).
 *
 * The hold is PER CANDIDATE: BUDGET places the first candidate's, and DISPATCH re-reserves for each
 * candidate the chain advances onto (pipeline/budget.ts runCandidateBudget) — always reserving the
 * next candidate's hold BEFORE releasing the previous one, so the request is never in flight holding
 * nothing. Each hold is released exactly once: the FINAL attempt's reconcile, the BUDGET
 * block/fallback path, the route's finally, or the advance that superseded it — never on a non-final
 * attempt, which is still going to dispatch a fallback candidate.
 */

/** A scope×period counter row the hold is placed on (matches the reconcile bump set). */
export interface ReservationRow {
  scopeType: string;
  scopeId: string;
  periodKey: string;
}

/** One placed hold: `microUsd` reserved on every row in `rows`. Shape-compatible with
 *  ctx.budgetReservation (the CURRENT hold); an advance keeps the superseded one locally until it
 *  can be released behind the new one. */
export interface BudgetHold {
  microUsd: bigint;
  rows: ReservationRow[];
}

/** Last-resort output-token ceiling PER COMPLETION when the request sets no max_tokens AND the head
 *  candidate's model_prices row has no max_output_tokens populated (many rows don't). Scaled by `n`
 *  below — it bounds one completion, not the request. Prefer price.maxOutputTokens (the model's real
 *  ceiling) over this guess whenever it's known — see estimateRequestCostMicro. */
const RESERVE_DEFAULT_MAX_OUTPUT_TOKENS = 4096;

/** A priced row narrowed to the two rate columns this estimator requires — the caller has already
 *  rejected any row where either is null (an unpriceable candidate, handled by skipping it). */
type PricedRow = ModelPriceRow & { inputUsdPerM: string; outputUsdPerM: string };

/**
 * Conservative µUSD upper bound for ONE candidate at `price`'s rate: full estimated input + the
 * (clamped) max output. µUSD = tokens × usdPerM (the per-million and the ×1e6 cancel).
 */
function candidateCostMicro(
  ctx: PipelineContext,
  price: PricedRow,
  inTok: number,
  completions: number,
): bigint {
  // Embeddings produce no output tokens — without this the absent max_tokens fell through to the
  // 4096 default and a phantom output term inflated every embeddings hold (task #9).
  // When the caller sets no max_tokens, the model's real output ceiling (model_prices.max_output_tokens)
  // is a tighter, honest upper bound than the 4096 guess — some models cap far higher, and a hold built
  // on the guess can be a fraction of what reconcile actually bills, letting a request walk through an
  // enforce cap. Fall back to the guess only when the column isn't populated for this row.
  const perCompletionOut =
    ctx.endpoint === 'embeddings'
      ? 0
      : typeof ctx.validatedBody.max_tokens === 'number'
        ? ctx.validatedBody.max_tokens
        : (price.maxOutputTokens ?? RESERVE_DEFAULT_MAX_OUTPUT_TOKENS);
  // `n` is a SPEND MULTIPLIER: the upstream bills n × output tokens for one prompt, and `n` is in the
  // OpenAI/Gemini passthrough sets so it reaches the provider verbatim. VALIDATE's n-aware clamp only
  // bounds the total when the key sets max_output_tokens, and that column defaults to NULL — so on a
  // default-provisioned key the hold was 1/n of what reconcile bills. Measured: one n=32 request on a
  // default key held $0.032770, walked through a $0.10 enforce+block cap, and settled at $1.048596
  // (red-team B5). Math.min keeps the product finite — max_tokens and n are both client-supplied and
  // 1e308 × 1e308 is Infinity, which BigInt() throws on.
  const maxOut = Math.min(perCompletionOut * completions, Number.MAX_SAFE_INTEGER);
  // Bigint µUSD throughout (ADR-019e — no float coercion on money). parseUsd(usdPerM) is
  // usdPerM scaled by 1e6; tokens × that equals desired-µUSD × 1e6 (the ×1e6 USD→µUSD
  // conversion and the implicit ÷1e6-per-million cancel, same identity the float version
  // relied on), so divide back down by 1e6. Ceiling division preserves the "conservative
  // upper bound" guarantee the previous Math.ceil gave.
  const numerator =
    BigInt(Math.max(0, Math.trunc(inTok))) * parseUsd(price.inputUsdPerM) +
    BigInt(Math.max(0, Math.trunc(maxOut))) * parseUsd(price.outputUsdPerM);
  return numerator > 0n ? (numerator + 999_999n) / 1_000_000n : 0n;
}

/** Conservative µUSD bound for `candidate` priced from PRICING's snapshot (ctx.priceByCandidate) ONLY
 *  — no DB round-trip, so a pure/synchronous caller can use it. null when that map has no usable row
 *  for the candidate (it is empty until PRICING has run). */
export function estimateCandidateCostMicroSync(
  ctx: PipelineContext,
  candidate: Candidate,
): bigint | null {
  const price = ctx.priceByCandidate.get(candidateKeyOf(candidate));
  if (!price || price.inputUsdPerM == null || price.outputUsdPerM == null) return null;
  // Runtime-verified by the guard above (`as` narrows the *: string | null* columns TS can't narrow
  // through the whole-object return — the values themselves are already checked).
  return candidateCostMicro(
    ctx,
    price as PricedRow,
    ctx.estimatedInputTokens ?? 0,
    completionCount(ctx.validatedBody),
  );
}

/**
 * Conservative µUSD upper bound for the ONE candidate about to be dispatched. Returns null when that
 * candidate can't be priced — PRICING 503s an unpriceable model before it can dispatch/bill, so there
 * is nothing to hold.
 *
 * WHY per-candidate, and what it replaces (this supersedes the max-over-chain sizing, red-team P0).
 * The hold used to be sized for the chain's MOST EXPENSIVE priceable candidate. That existed because
 * BUDGET ran exactly once, pre-dispatch, from the route, while DISPATCH walks the ENTIRE chain on a
 * retryable failure and bills whichever candidate answers — so one reservation had to cover a later,
 * pricier candidate too, or concurrent requests could all pass a compare sized for the cheap head and
 * collectively blow past the cap. The reasoning was sound for a single request-level hold; the hold
 * itself was not. It was posted on the HEAD provider's counter row, so a chain whose pricey member
 * belongs to a DIFFERENT provider inflated the head provider's cap with spend that structurally could
 * not land on it (false 402s on the head's cap), while the provider that would actually be billed was
 * never evaluated at all — provider-scoped budgets were filtered to the head provider, so a cap on a
 * TAIL provider was silently absent from the whole request even though reconcile bumps that
 * provider's counter with the real spend.
 *
 * BUDGET is now evaluated and reserved PER CANDIDATE immediately before that candidate is dispatched
 * (pipeline/budget.ts runCandidateBudget), against that candidate's own provider. So the honest size
 * for a hold is the cost of the one candidate it authorizes, and the retry-window coverage
 * max-over-chain bought is provided instead by re-reserving on every advance — the next candidate's
 * hold goes on BEFORE the previous one comes off, so no window exists in which the request is
 * dispatching without a hold (the invariant the max-over-chain sizing was protecting).
 */
export async function estimateCandidateCostMicro(
  ctx: PipelineContext,
  candidate: Candidate,
): Promise<bigint | null> {
  // PRICING already loaded (and fail-closed validated) every reachable candidate's row; reuse it so a
  // chain advance costs no extra DB round-trips. BUDGET's first-candidate call runs BEFORE PRICING,
  // so it still falls through to the (uncached) lookup.
  const cached = estimateCandidateCostMicroSync(ctx, candidate);
  if (cached !== null) return cached;
  const price = await getModelPrice(ctx.deps.db, candidate.provider, candidate.model);
  if (!price || price.inputUsdPerM == null || price.outputUsdPerM == null) return null;
  return candidateCostMicro(
    ctx,
    price as PricedRow,
    ctx.estimatedInputTokens ?? 0,
    completionCount(ctx.validatedBody),
  );
}

/**
 * Atomically add the hold to every row and return the POST-hold {spent, reserved} per counter key, so
 * the caller compares spent + reserved against each enforce limit. The multi-row upsert takes a row
 * lock per counter, so concurrent reservations on the same scope serialize and each sees the others'.
 */
export async function reserveBudget(
  ctx: PipelineContext,
  rows: ReservationRow[],
  estimateMicro: bigint,
): Promise<Map<string, { spent: bigint; reserved: bigint }>> {
  const estStr = formatUsd(estimateMicro);
  const orgId = ctx.policy.orgId;
  const values = rows.map(
    (r) => sql`(${orgId}::uuid, ${r.scopeType}, ${r.scopeId}::uuid, ${r.periodKey}, ${estStr})`,
  );
  const result = (await withOrg(ctx.deps.db, orgId, (tx) =>
    tx.execute(sql`
      INSERT INTO spend_counters (org_id, scope_type, scope_id, period_key, reserved_usd)
      VALUES ${sql.join(values, sql`, `)}
      ON CONFLICT (scope_type, scope_id, period_key)
      DO UPDATE SET reserved_usd = spend_counters.reserved_usd + EXCLUDED.reserved_usd,
                    updated_at = now()
      RETURNING scope_type, scope_id, period_key, spent_usd, reserved_usd`),
  )) as unknown as {
    scope_type: string;
    scope_id: string;
    period_key: string;
    spent_usd: string;
    reserved_usd: string;
  }[];
  const map = new Map<string, { spent: bigint; reserved: bigint }>();
  for (const row of result) {
    map.set(`${row.scope_type}:${row.scope_id}:${row.period_key}`, {
      spent: parseUsd(row.spent_usd),
      reserved: parseUsd(row.reserved_usd),
    });
  }
  return map;
}

/**
 * Release the request's CURRENT hold (idempotent via ctx.budgetReservationSettled — set
 * synchronously, before any await, so two racing releases can never both credit the counter). Called
 * from exactly one of: the BUDGET block/fallback path, the FINAL attempt's reconcile (never a
 * non-final one — see the gate in runReconcile), or the route's finally (pre-dispatch failure, or any
 * exit that reconcile never reached).
 */
export async function releaseBudgetReservation(ctx: PipelineContext): Promise<void> {
  const res = ctx.budgetReservation;
  if (!res || ctx.budgetReservationSettled) return;
  ctx.budgetReservationSettled = true;
  await releaseHold(ctx, res);
}

/**
 * Release ONE named hold. Used directly for a hold that is no longer ctx's current one — the
 * superseded hold on a chain advance, or a hold placed for a candidate that turned out to be over its
 * cap and was skipped. Takes the hold explicitly (not ctx.budgetReservation) precisely because the
 * advance path has TWO holds outstanding at once by design, and only the older one is being dropped.
 * GREATEST(...,0) clamps so a concurrent release can't drive the hold negative. Swallows errors — a
 * failed release only leaves an over-hold (fail-safe), never corrupts spend.
 */
export async function releaseHold(ctx: PipelineContext, res: BudgetHold): Promise<void> {
  const relStr = formatUsd(res.microUsd);
  const orgId = ctx.policy.orgId;
  // Upsert (not UPDATE): an OR'd UPDATE locks rows in PLAN order (a seq scan's heap order), which
  // deadlocked (40P01) against reserve/blocked-bump writers taking VALUES order under a concurrent
  // blocked burst (stress budget-race, 2026-07-19). INSERT..ON CONFLICT processes VALUES in array
  // order — res.rows is already the canonical SCOPE_RANK scope-major, [month, day] order every
  // counter writer uses. The rows exist (reserveBudget created them); an insert of reserved_usd=0
  // on a vanished row is a harmless no-op hold.
  const values = res.rows.map(
    (r) => sql`(${orgId}::uuid, ${r.scopeType}, ${r.scopeId}::uuid, ${r.periodKey}, 0)`,
  );
  try {
    await withOrg(ctx.deps.db, orgId, (tx) =>
      tx.execute(sql`
        INSERT INTO spend_counters (org_id, scope_type, scope_id, period_key, reserved_usd)
        VALUES ${sql.join(values, sql`, `)}
        ON CONFLICT (scope_type, scope_id, period_key)
        DO UPDATE SET reserved_usd = GREATEST(spend_counters.reserved_usd - ${relStr}, 0),
                      updated_at = now()`),
    );
  } catch {
    /* release is advisory; a failure only over-holds (fail-safe) */
  }
}
