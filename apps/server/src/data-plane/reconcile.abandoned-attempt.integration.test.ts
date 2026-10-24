import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTestDb } from '../../test/helpers/db.js';
import { runReconcile } from './reconcile.js';
import { BurstTracker } from '../services/alerts/burst.js';
import type { PipelineContext } from './pipeline/context.js';
import type { ParsedUsage } from './providers/types.js';
import type { ModelPriceRow } from '@spillway/pricing';

/**
 * An ABANDONED reconcile that finishes after DISPATCH advanced the chain (red-team follow-up to the
 * hold-until-final gate).
 *
 * `ctx` is ONE object for the whole request and DISPATCH mutates the attempt-scoped fields on it as
 * the chain advances. That is safe only while the chain is awaiting the reconcile — and streaming does
 * not always await it: `guardedReconcile` (streaming/sse-tee.ts) races every reconcile against
 * RECONCILE_TIMEOUT_MS and ABANDONS the loser. The promise is not cancelled; it keeps running while
 * `runStreamChain` moves on to the next candidate. So a reconcile entered for candidate A can reach
 * its `requests`-row branch and its hold-release `finally` at a moment when ctx already describes
 * candidate B, and any field it reads LIVE there is B's, not A's.
 *
 * These drive that window directly. `runReconcile` runs against real RLS Postgres and is parked
 * mid-settle by holding a lock it must wait on — blockSettleEntry parks it at step 0 (before the
 * ledger insert is built), blockCounterUpsert parks it at the counter upsert (after the insert, before
 * the step-3/step-4 branch). The chain advance is then applied to ctx and the lock released, so the
 * remainder of the settle runs against the successor's state exactly as an abandoned reconcile's would.
 * Two straddle points because they corrupt different fields; neither alone covers the class.
 */

const OPENAI = 'openai';
const MODEL_A = 'gpt-4o-mini'; // the candidate that failed and was advanced off
const MODEL_B = 'gpt-4.1'; // the candidate that actually served the request

const price: ModelPriceRow = {
  provider: OPENAI,
  inputUsdPerM: '2.500000',
  outputUsdPerM: '10.000000',
  cacheReadUsdPerM: '0.250000',
  cacheWrite5mUsdPerM: null,
  cacheWrite1hUsdPerM: null,
  inputUsdPerMLong: null,
  longContextThreshold: null,
};

/** Nonzero cost on both attempts — `billed` must be true or the settle never reaches (and so never
 *  blocks at) the spend_counters upsert this test parks on. */
const usageA: ParsedUsage = {
  input_tokens: 1000,
  output_tokens: 0,
  cached_read_tokens: 0,
  cache_write_5m_tokens: 0,
  cache_write_1h_tokens: 0,
  cache_type: null,
  reasoning_tokens: 0,
  usage_estimated: true,
};
const usageB: ParsedUsage = { ...usageA, output_tokens: 500, usage_estimated: false };

/**
 * The two holds, as distinct BudgetHold objects on period keys reconcile's own counter bump never
 * touches — so a change in `reserved_usd` on either row can only have come from a release.
 * runCandidateBudget assigns a FRESH object per candidate, which is what makes reference identity a
 * valid "is this still the hold I was entered under?" test.
 */
const HOLD_A_PERIOD = 'r30:2098-01-01';
const HOLD_B_PERIOD = 'r30:2099-01-01';
const HOLD_A_USD = '0.250000';
const HOLD_B_USD = '0.500000';

let h: Awaited<ReturnType<typeof createTestDb>>;
const orgId = randomUUID();
const vkId = randomUUID();

function holdFor(periodKey: string, microUsd: bigint): PipelineContext['budgetReservation'] {
  return { microUsd, rows: [{ scopeType: 'org', scopeId: orgId, periodKey }] };
}

function makeCtx(requestId: string, over: Partial<PipelineContext> = {}): PipelineContext {
  return {
    requestId,
    startedAt: Date.now() - 10,
    endpoint: 'chat_completions',
    deps: { db: h.db, burstTracker: new BurstTracker() },
    policy: {
      orgId,
      virtualKeyId: vkId,
      teamId: null,
      configSnapshotHash: 'testhash',
      budgets: [],
    },
    req: { headers: {}, log: { info() {}, warn() {}, error() {} } },
    validatedBody: {},
    knobs: { sessionId: null, requireCapabilities: null, traceEnabled: false, provider: null },
    requestedModel: 'chain',
    requestFeatures: { message_count: 1 },
    routeResult: { routingRuleId: null },
    fallbackFrom: [],
    servedUnderBudgetFallback: false,
    priceByCandidate: new Map([
      [`${OPENAI}:${MODEL_A}`, price],
      [`${OPENAI}:${MODEL_B}`, price],
    ]),
    candidate: { provider: OPENAI, model: MODEL_A, providerKeyId: 'pk' },
    activeCandidate: { provider: OPENAI, model: MODEL_A, providerKeyId: 'pk' },
    usage: usageA,
    upstreamStatus: 429,
    errorCode: 'upstream_rate_limited',
    serviceTier: null,
    stream: true,
    attemptNumber: 0,
    isFinalAttempt: false,
    budgetReservation: holdFor(HOLD_A_PERIOD, 250_000n),
    budgetReservationSettled: false,
    reconcileStarted: true,
    droppedParams: [],
    timings: {},
    ...over,
  } as unknown as PipelineContext;
}

/**
 * Park any in-flight settle at its first write to `table` by holding an EXCLUSIVE table lock (which
 * conflicts with the ROW EXCLUSIVE an INSERT takes). Returns the releaser; the admin transaction is
 * awaited on release so the lock is provably gone before the assertions read the table.
 *
 * This parks the settle at its `spend_counters` upsert — AFTER the ledger insert and BEFORE the
 * step-3/step-4 branch. Use blockSettleEntry to park it EARLIER instead; the two straddle points
 * corrupt different fields, which is exactly why both are exercised.
 */
async function blockCounterUpsert(): Promise<Gate> {
  return blockWith(
    (sql) => sql`LOCK TABLE spend_counters IN EXCLUSIVE MODE`,
    () => h.adminSql`
      SELECT 1 FROM pg_locks l
        JOIN pg_class c ON c.oid = l.relation
       WHERE c.relname = 'spend_counters'
         AND NOT l.granted
         AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
  );
}

/**
 * Park the settle at step 0 — its `pg_advisory_xact_lock(hashtext(org), hashtext(request))`, the very
 * first statement inside the tx — by taking the SAME advisory lock first.
 *
 * This is the straddle point that matters for the ledger key, and it has to be this early: drizzle
 * evaluates the `.values({...})` object literal SYNCHRONOUSLY when the insert is built, so any gate
 * placed at the insert's execution is already too late to observe attemptNumber/errorCode being read.
 * The awaits that genuinely precede that literal are the catalog read, the pool checkout/BEGIN, the
 * set_config, and this advisory lock — and step 0 is the one that can hold for a long time by design,
 * which is also what makes a reconcile slow enough to be abandoned in the first place.
 */
async function blockSettleEntry(orgId_: string, requestId: string): Promise<Gate> {
  return blockWith(
    (sql) => sql`SELECT pg_advisory_xact_lock(hashtext(${orgId_}), hashtext(${requestId}))`,
    () => h.adminSql`
      SELECT 1 FROM pg_locks
       WHERE locktype = 'advisory'
         AND NOT granted
         AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
  );
}

interface Gate {
  /** Resolves once a backend is provably BLOCKED on the held lock. Deterministic; never a bare sleep. */
  blocked: () => Promise<void>;
  /** Drop the lock and wait for the admin tx to commit, so it is provably gone before any read. */
  release: () => Promise<void>;
}

/** Hold `take` in an admin transaction until `release()`. */
async function blockWith(
  take: (sql: typeof h.adminSql) => Promise<unknown>,
  waiting: () => Promise<readonly unknown[]>,
): Promise<Gate> {
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  let taken!: () => void;
  const locked = new Promise<void>((r) => (taken = r));
  const tx = h.adminSql.begin(async (sql) => {
    await take(sql as unknown as typeof h.adminSql);
    taken();
    await gate;
  });
  await locked;
  return {
    blocked: async () => {
      for (let i = 0; i < 400; i++) {
        if ((await waiting()).length > 0) return;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error('reconcile never blocked on the expected lock');
    },
    release: async () => {
      open();
      await tx;
    },
  };
}

async function reservedOn(periodKey: string): Promise<string> {
  const [row] = await h.adminSql<{ reserved_usd: string }[]>`
    SELECT reserved_usd FROM spend_counters
     WHERE org_id = ${orgId} AND scope_type = 'org' AND period_key = ${periodKey}`;
  return row?.reserved_usd ?? 'MISSING';
}

/** Seed both holds onto their counter rows so a wrongful release is observable as a drop to zero
 *  (releaseHold upserts, so an unseeded row would land at 0 either way and prove nothing). */
async function seedHolds(): Promise<void> {
  await h.adminSql`
    INSERT INTO spend_counters (org_id, scope_type, scope_id, period_key, reserved_usd)
    VALUES (${orgId}, 'org', ${orgId}, ${HOLD_A_PERIOD}, ${HOLD_A_USD}),
           (${orgId}, 'org', ${orgId}, ${HOLD_B_PERIOD}, ${HOLD_B_USD})`;
}

beforeAll(async () => {
  h = await createTestDb();
  await h.adminSql`INSERT INTO orgs (id, name, slug) VALUES (${orgId}, 'Abandoned', ${'ab-' + orgId.slice(0, 8)})`;
  await h.adminSql`INSERT INTO virtual_keys (id, org_id, name, key_hash, key_prefix, status)
                   VALUES (${vkId}, ${orgId}, 'k', ${Buffer.from(vkId)}, 'mk-ab', 'active')`;
});

afterAll(async () => {
  await h.cleanup();
});

beforeEach(async () => {
  await h.adminSql`TRUNCATE requests, request_bodies, request_attempts, spend_counters`;
});

describe('runReconcile: an abandoned attempt that completes after the chain advanced', () => {
  it('settles the attempt it was ENTERED for — never the successor it woke up next to', async () => {
    await seedHolds();
    const requestId = randomUUID();
    const ctx = makeCtx(requestId); // attempt 0, NON-final, holding A's reservation

    const gate = await blockCounterUpsert();
    const abandoned = runReconcile(ctx); // guardedReconcile's timeout arm already resolved for this
    await gate.blocked(); // ...and it is now parked mid-settle

    // THE ADVANCE, exactly as runStreamChain + runCandidateBudget apply it: next attempt number, this
    // one is now the final candidate, and B's hold is placed (the superseded A hold having been
    // released by runCandidateBudget's trailing releaseHold — which is why A must not release again).
    ctx.attemptNumber = 1;
    ctx.isFinalAttempt = true;
    ctx.candidate = { provider: OPENAI, model: MODEL_B, providerKeyId: 'pk' };
    ctx.activeCandidate = { provider: OPENAI, model: MODEL_B, providerKeyId: 'pk' };
    ctx.budgetReservation = holdFor(HOLD_B_PERIOD, 500_000n);
    ctx.budgetReservationSettled = false;

    await gate.release();
    await abandoned;

    // (b) A is NOT the final attempt, so it must not write the aggregated `requests` row. Pre-fix it
    // read ctx.isFinalAttempt live, saw B's `true`, and wrote the row from A's data — which then
    // collided with B's own step-3 insert below, rolling back B's whole settle through both retries
    // and declaring B's spend lost.
    const afterAbandoned = await h.adminSql`SELECT id FROM requests WHERE org_id = ${orgId}`;
    expect(afterAbandoned).toHaveLength(0);
    const attemptA = await h.adminSql<{ attempt_number: number; model: string }[]>`
      SELECT attempt_number, model FROM request_attempts WHERE org_id = ${orgId}`;
    expect(attemptA).toHaveLength(1);
    expect(attemptA[0]!.attempt_number).toBe(0); // A's own ledger row, unaffected by the advance
    expect(attemptA[0]!.model).toBe(MODEL_A);

    // (a) B's hold is still on the row and still un-settled: a candidate that is still dispatching
    // must keep its authorization. Pre-fix the `finally` released ctx's CURRENT hold — B's.
    expect(await reservedOn(HOLD_B_PERIOD)).toBe(HOLD_B_USD);
    expect(ctx.budgetReservationSettled).toBe(false);

    // Now B finishes for real and reconciles as the final attempt.
    ctx.usage = usageB;
    ctx.upstreamStatus = 200;
    ctx.errorCode = null;
    await runReconcile(ctx);

    const attempts = await h.adminSql<{ attempt_number: number; model: string }[]>`
      SELECT attempt_number, model FROM request_attempts WHERE org_id = ${orgId}
       ORDER BY attempt_number`;
    expect(attempts.map((r) => r.attempt_number)).toEqual([0, 1]); // no attempt's spend was lost
    const rows = await h.adminSql<{ model: string; status: string }[]>`
      SELECT model, status FROM requests WHERE org_id = ${orgId}`;
    expect(rows).toHaveLength(1); // written exactly once...
    expect(rows[0]!.model).toBe(MODEL_B); // ...by the attempt that actually served it
    expect(rows[0]!.status).toBe('ok');

    // ...and B's own final reconcile is what releases B's hold.
    expect(ctx.budgetReservationSettled).toBe(true);
    expect(await reservedOn(HOLD_B_PERIOD)).toBe('0.000000');
  }, 25_000);

  it('releases only the hold it was entered under, never a hold that superseded it', async () => {
    // Contract test for the identity check in the release `finally`. Today the entry snapshot of
    // isFinalAttempt already covers the reachable shape (a chain only advances off a NON-final
    // attempt), so this pins the second half independently: entered final, hold swapped mid-flight.
    // releaseBudgetReservation always credits ctx's CURRENT hold, so without the check a late
    // invocation refunds money that is authorizing someone else.
    await seedHolds();
    const ctx = makeCtx(randomUUID(), {
      isFinalAttempt: true,
      usage: usageB,
      upstreamStatus: 200,
      errorCode: null,
    });

    const gate = await blockCounterUpsert();
    const inFlight = runReconcile(ctx);
    await gate.blocked();

    const superseding = holdFor(HOLD_B_PERIOD, 500_000n);
    ctx.budgetReservation = superseding;
    ctx.budgetReservationSettled = false;

    await gate.release();
    await inFlight;

    expect(await reservedOn(HOLD_B_PERIOD)).toBe(HOLD_B_USD); // untouched — not this call's hold
    expect(ctx.budgetReservationSettled).toBe(false); // ...and left for its real owner to settle
    // The hold this call WAS entered under is likewise not credited here: whatever superseded it
    // already released it (runCandidateBudget's trailing releaseHold), and double-crediting a counter
    // is the one thing releaseHold's GREATEST clamp exists to survive rather than to invite.
    expect(await reservedOn(HOLD_A_PERIOD)).toBe(HOLD_A_USD);
    // It WAS the final attempt, so the aggregate row is still written — the guard gates the release,
    // not the settle.
    const rows = await h.adminSql`SELECT id FROM requests WHERE org_id = ${orgId}`;
    expect(rows).toHaveLength(1);
  }, 25_000);

  it("does not consume the successor's ledger key — the fallback attempt's spend still lands", async () => {
    // The straddle one step EARLIER: parked at the settle's step-0 advisory lock, so the advance lands
    // before the ledger insert is even BUILT and attemptNumber/errorCode are still unread. This is the
    // silent-loss shape. Read live, A writes its own provider/model/cost under B's
    // (request_id, attempt_number); B's insert then hits ON CONFLICT DO NOTHING, `gate.length === 0`
    // returns, B's ENTIRE settle tx no-ops, and B's real spend is gone — with no throw, no
    // spend_write_lost, nothing downstream able to notice.
    await seedHolds();
    const requestId = randomUUID();
    const ctx = makeCtx(requestId);

    const gate = await blockSettleEntry(orgId, requestId);
    const abandoned = runReconcile(ctx);
    await gate.blocked();

    ctx.attemptNumber = 1;
    ctx.isFinalAttempt = true;
    ctx.candidate = { provider: OPENAI, model: MODEL_B, providerKeyId: 'pk' };
    ctx.activeCandidate = { provider: OPENAI, model: MODEL_B, providerKeyId: 'pk' };
    ctx.errorCode = null; // dispatch.ts clears it for the next attempt's clean reconcile
    ctx.timings.firstByte = 1234; // B commits a byte; A never did
    ctx.budgetReservation = holdFor(HOLD_B_PERIOD, 500_000n);
    ctx.budgetReservationSettled = false;

    await gate.release();
    await abandoned;

    // A's row must carry A's OWN key, error code and TTFT — every attempt-scoped field as it stood
    // when this invocation was entered, not as ctx stands now.
    const [rowA] = await h.adminSql<
      {
        attempt_number: number;
        model: string;
        error_code: string | null;
        ttft_ms: number | null;
        cost_usd: string;
      }[]
    >`SELECT attempt_number, model, error_code, ttft_ms, cost_usd
        FROM request_attempts WHERE org_id = ${orgId}`;
    expect(rowA!.attempt_number).toBe(0); // did not consume B's ledger key
    expect(rowA!.model).toBe(MODEL_A);
    expect(rowA!.error_code).toBe('upstream_rate_limited'); // coherent with outcome='error'
    expect(rowA!.ttft_ms).toBeNull(); // A never wrote a byte; the 1234 is B's

    // B now settles for real. Its key is still free, so its spend lands.
    ctx.usage = usageB;
    ctx.upstreamStatus = 200;
    await runReconcile(ctx);

    const attempts = await h.adminSql<
      { attempt_number: number; model: string; cost_usd: string }[]
    >`
      SELECT attempt_number, model, cost_usd FROM request_attempts WHERE org_id = ${orgId}
       ORDER BY attempt_number`;
    expect(attempts.map((r) => r.attempt_number)).toEqual([0, 1]);
    expect(attempts[1]!.model).toBe(MODEL_B);
    expect(Number(attempts[1]!.cost_usd)).toBeGreaterThan(0); // B's spend is on the ledger

    // §4.3: the aggregate is the SUM of the ledger. Derived from the rows rather than hardcoded, so
    // this stays honest across price-catalog changes while still proving nothing went missing.
    const [reqRow] = await h.adminSql<{ model: string; cost_usd: string }[]>`
      SELECT model, cost_usd FROM requests WHERE org_id = ${orgId}`;
    expect(reqRow!.model).toBe(MODEL_B);
    const ledgerTotal = attempts.reduce((s, r) => s + Number(r.cost_usd), 0);
    expect(Number(reqRow!.cost_usd)).toBeCloseTo(ledgerTotal, 6);
    expect(Number(reqRow!.cost_usd)).toBeGreaterThan(Number(attempts[0]!.cost_usd));
  }, 25_000);
});
