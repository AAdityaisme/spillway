import { sql } from 'drizzle-orm';
import { formatUsd, parseUsd } from '@spillway/pricing';
import { withOrg } from '../../db/tenancy.js';
import { getModelPrice } from '../pricing.js';
import type { PipelineContext } from '../pipeline/context.js';

/**
 * Atomic budget reservation (expanded-audit HIGH H2). The BUDGET stage reserves a conservative cost
 * estimate on the counter rows BEFORE dispatch, so concurrent requests see each other's in-flight
 * holds and cannot all pass a hard cap. `reserved_usd` is separate from `spent_usd` (the money truth),
 * so the ledger invariant is untouched; a crashed request that never releases only inflates the hold
 * → the budget blocks slightly early (fail-safe). Released at reconcile or on any pre-dispatch failure.
 */

/** A scope×period counter row the hold is placed on (matches the reconcile bump set). */
export interface ReservationRow {
  scopeType: string;
  scopeId: string;
  periodKey: string;
}

/** Fallback output-token ceiling when the request set no max_tokens (model default is unbounded). */
const RESERVE_DEFAULT_MAX_OUTPUT_TOKENS = 4096;

/**
 * Conservative µUSD upper bound for THIS request: full estimated input + the (clamped) max output at
 * the head candidate's base rate. Returns null when the head candidate can't be priced — pricing (the
 * next stage) will 503 an unpriceable model before it can dispatch/bill, so there is nothing to hold.
 * µUSD = tokens × usdPerM (the per-million and the ×1e6 cancel).
 */
export async function estimateRequestCostMicro(ctx: PipelineContext): Promise<bigint | null> {
  const head = ctx.candidateChain[0];
  if (!head) return null;
  const price = await getModelPrice(ctx.deps.db, head.provider, head.model);
  if (!price || price.inputUsdPerM == null || price.outputUsdPerM == null) return null;
  const inTok = ctx.estimatedInputTokens ?? 0;
  // Embeddings produce no output tokens — without this the absent max_tokens fell through to the
  // 4096 default and a phantom output term inflated every embeddings hold (task #9).
  const maxOut =
    ctx.endpoint === 'embeddings'
      ? 0
      : typeof ctx.validatedBody.max_tokens === 'number'
        ? ctx.validatedBody.max_tokens
        : RESERVE_DEFAULT_MAX_OUTPUT_TOKENS;
  const micro = Math.ceil(
    inTok * Number(price.inputUsdPerM) + maxOut * Number(price.outputUsdPerM),
  );
  return BigInt(Math.max(0, micro));
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
 * Release the request's hold (idempotent via ctx.budgetReservationSettled). Called from exactly one of:
 * the BUDGET block/fallback path, reconcile's first settle, or the route's finally (pre-dispatch
 * failure). GREATEST(...,0) clamps so a concurrent release can't drive the hold negative. Swallows
 * errors — a failed release only leaves an over-hold (fail-safe), never corrupts spend.
 */
export async function releaseBudgetReservation(ctx: PipelineContext): Promise<void> {
  const res = ctx.budgetReservation;
  if (!res || ctx.budgetReservationSettled) return;
  ctx.budgetReservationSettled = true;
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
