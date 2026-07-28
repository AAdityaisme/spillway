import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { makeTestApp, type TestHarness } from '../../test/helpers/app.js';
import { runReconcile } from './reconcile.js';
import { providerScopeId } from './budget/resolver.js';
import { BurstTracker } from '../services/alerts/burst.js';
import type { PipelineContext } from './pipeline/context.js';
import type { ParsedUsage } from './providers/types.js';
import type { ModelPriceRow } from '@spillway/pricing';

/**
 * B3.1 exit gate: the request_attempts ledger. Idempotency (a retried reconcile no-ops — no double
 * charge), the §4.3 invariant (requests.cost_usd == SUM(attempts) == counter spent), and the §1.8
 * provider-scope counter bump. Calls runReconcile directly against real RLS Postgres.
 */

const usage: ParsedUsage = {
  input_tokens: 800, // full-rate (prompt 1000 − cached 200)
  output_tokens: 500,
  cached_read_tokens: 200,
  cache_write_5m_tokens: 0,
  cache_write_1h_tokens: 0,
  cache_type: null,
  reasoning_tokens: 0,
  usage_estimated: false,
};
// 800@2.5 + 200@0.25 + 500@10 (per 1M) = 2000 + 50 + 5000 = 7050 µUSD
const EXPECTED = 0.00705;
const price: ModelPriceRow = {
  provider: 'openai',
  inputUsdPerM: '2.500000',
  outputUsdPerM: '10.000000',
  cacheReadUsdPerM: '0.250000',
  cacheWrite5mUsdPerM: null,
  cacheWrite1hUsdPerM: null,
  inputUsdPerMLong: null,
  longContextThreshold: null,
};

let h: TestHarness;
const orgId = randomUUID();
const vkId = randomUUID();

function makeCtx(requestId: string, over: Partial<PipelineContext> = {}): PipelineContext {
  return {
    deps: { db: h.db, burstTracker: new BurstTracker() },
    policy: {
      orgId,
      virtualKeyId: vkId,
      teamId: null,
      configSnapshotHash: 'testhash',
      budgets: [],
    },
    usage,
    requestId,
    startedAt: Date.now() - 10,
    upstreamStatus: 200,
    errorCode: null,
    activeCandidate: { provider: 'openai', model: 'gpt-4.1', providerKeyId: 'pk' },
    candidate: { provider: 'openai', model: 'gpt-4.1', providerKeyId: 'pk' },
    priceByCandidate: new Map([['openai:gpt-4.1', price]]),
    requestedModel: 'gpt-4.1',
    stream: false,
    attemptNumber: 0,
    isFinalAttempt: true,
    servedUnderBudgetFallback: false,
    fallbackFrom: [],
    routeResult: { routingRuleId: null, requestedModel: 'gpt-4.1' },
    requestFeatures: { message_count: 1 },
    timings: {},
    validatedBody: {},
    req: { headers: {}, log: { error: () => {}, warn: () => {} } },
    ...over,
  } as unknown as PipelineContext;
}

beforeAll(async () => {
  h = await makeTestApp();
  const sql = h.adminSql;
  await sql`INSERT INTO orgs (id, name, slug) VALUES (${orgId}, 'A', ${'a-' + orgId.slice(0, 8)})`;
  await sql`INSERT INTO virtual_keys (id, org_id, name, key_hash, key_prefix, status)
            VALUES (${vkId}, ${orgId}, 'k', ${Buffer.from(vkId)}, 'mk-a', 'active')`;
  await sql`INSERT INTO model_prices (provider, model, input_usd_per_m, output_usd_per_m, cache_read_usd_per_m, source, synced_at)
            VALUES ('openai', 'gpt-4.1', 2.5, 10, 0.25, 'litellm', now())`;
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.adminSql`TRUNCATE requests, request_bodies, request_attempts, spend_counters`;
});

describe('reconcile attempts ledger (17 §4, B3.1)', () => {
  it('writes one attempt + aggregated requests row + counters (incl. provider scope)', async () => {
    await runReconcile(makeCtx(randomUUID()));

    const attempts = await h.adminSql`SELECT outcome, cost_usd FROM request_attempts`;
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.outcome).toBe('ok');

    const reqRow = await h.adminSql<{ cost_usd: string; status: string }[]>`
      SELECT cost_usd, status FROM requests WHERE org_id = ${orgId}`;
    expect(reqRow[0]!.status).toBe('ok');
    expect(Number(reqRow[0]!.cost_usd)).toBeCloseTo(EXPECTED, 6);

    // §4.3: requests.cost == SUM(attempts) == org counter spent
    const org = await h.adminSql<{ spent_usd: string; request_count: number }[]>`
      SELECT spent_usd, request_count FROM spend_counters WHERE scope_type = 'org' AND period_key LIKE '____-__-__'`;
    expect(Number(org[0]!.spent_usd)).toBeCloseTo(EXPECTED, 6);
    expect(Number(org[0]!.request_count)).toBe(1);

    // §1.8: provider-scope counter bumped for the served provider
    const provSid = providerScopeId(orgId, 'openai');
    const prov = await h.adminSql<{ spent_usd: string }[]>`
      SELECT spent_usd FROM spend_counters WHERE scope_type = 'provider' AND scope_id = ${provSid} LIMIT 1`;
    expect(prov).toHaveLength(1);
    expect(Number(prov[0]!.spent_usd)).toBeCloseTo(EXPECTED, 6);
  });

  it('is idempotent — a retried reconcile of the same attempt does not double-charge', async () => {
    const rid = randomUUID();
    await runReconcile(makeCtx(rid));
    await runReconcile(makeCtx(rid)); // retry — must no-op the whole tx

    expect(await h.adminSql`SELECT 1 FROM request_attempts WHERE request_id = ${rid}`).toHaveLength(
      1,
    );
    const org = await h.adminSql<{ spent_usd: string; request_count: number }[]>`
      SELECT spent_usd, request_count FROM spend_counters WHERE scope_type = 'org' AND period_key LIKE '____-__-__'`;
    expect(Number(org[0]!.spent_usd)).toBeCloseTo(EXPECTED, 6); // NOT doubled
    expect(Number(org[0]!.request_count)).toBe(1); // NOT 2
  });

  // STRESS: the sequential idempotency test proves the ON CONFLICT gate; this proves the advisory
  // lock (pg_advisory_xact_lock on hashtext(request_id)) serializes CONCURRENT settles of the same
  // request so 8 racing reconciles still charge exactly once — the core money invariant under load.
  it('stress: 8 concurrent reconciles of one request charge exactly once', async () => {
    const rid = randomUUID();
    await Promise.all(Array.from({ length: 8 }, () => runReconcile(makeCtx(rid))));

    expect(await h.adminSql`SELECT 1 FROM request_attempts WHERE request_id = ${rid}`).toHaveLength(
      1,
    );
    const org = await h.adminSql<{ spent_usd: string; request_count: number }[]>`
      SELECT spent_usd, request_count FROM spend_counters WHERE scope_type = 'org' AND period_key LIKE '____-__-__'`;
    expect(Number(org[0]!.spent_usd)).toBeCloseTo(EXPECTED, 6); // charged once, not 8×
    expect(Number(org[0]!.request_count)).toBe(1);
  });

  // audit M15: a non-final attempt that settles AFTER the final row exists (retry/reorder) must repair
  // the aggregated requests row from SUM(attempts) — cost AND every token column — order-independent.
  it('out-of-order late-settle re-derives the full requests row from SUM(attempts) (M15)', async () => {
    const rid = randomUUID();
    // attempt 0: non-final, billed error (some cost). attempt 1: final, ok.
    await runReconcile(
      makeCtx(rid, {
        attemptNumber: 0,
        isFinalAttempt: false,
        upstreamStatus: 500,
        errorCode: 'provider_5xx',
      } as Partial<PipelineContext>),
    );
    await runReconcile(makeCtx(rid, { attemptNumber: 1, isFinalAttempt: true }));
    // Re-settle attempt 0 OUT OF ORDER (after the final row already exists) — no-ops the attempt (ON
    // CONFLICT) but the step-4 branch re-derives the requests row so nothing drifts.
    await runReconcile(
      makeCtx(rid, {
        attemptNumber: 0,
        isFinalAttempt: false,
        upstreamStatus: 500,
        errorCode: 'provider_5xx',
      } as Partial<PipelineContext>),
    );

    const [agg] = await h.adminSql<{ sum: string; n: number }[]>`
      SELECT coalesce(sum(cost_usd),0)::text AS sum, count(*)::int AS n
        FROM request_attempts WHERE request_id = ${rid}`;
    expect(agg!.n).toBe(2);
    const [req] = await h.adminSql<
      { cost_usd: string; input_tokens: number; output_tokens: number }[]
    >`SELECT cost_usd::text, input_tokens, output_tokens FROM requests WHERE id = ${rid}`;
    // requests row == the whole ledger, regardless of settle order.
    expect(Number(req!.cost_usd)).toBeCloseTo(Number(agg!.sum), 6);
    expect(req!.input_tokens).toBe(usage.input_tokens * 2);
    expect(req!.output_tokens).toBe(usage.output_tokens * 2);
    // org counter (success request_count) bumped exactly once (only the final ok attempt).
    const [org] = await h.adminSql<{ request_count: number }[]>`
      SELECT request_count FROM spend_counters WHERE scope_type = 'org' AND period_key LIKE '____-__-__'`;
    expect(Number(org!.request_count)).toBe(1);
  });

  // audit L14: requests.usage_estimated must be bool_or over the ledger — if ANY attempt was an
  // estimate, the flag is true, even when the final attempt measured usage.
  it('usage_estimated is bool_or over attempts, not the final attempt alone (L14)', async () => {
    const rid = randomUUID();
    const estUsage = { ...usage, usage_estimated: true };
    await runReconcile(
      makeCtx(rid, {
        attemptNumber: 0,
        isFinalAttempt: false,
        upstreamStatus: 500,
        errorCode: 'provider_5xx',
        usage: estUsage,
      } as Partial<PipelineContext>),
    );
    await runReconcile(makeCtx(rid, { attemptNumber: 1, isFinalAttempt: true })); // final: measured
    const [req] = await h.adminSql<{ usage_estimated: boolean }[]>`
      SELECT usage_estimated FROM requests WHERE id = ${rid}`;
    expect(req!.usage_estimated).toBe(true); // a torn estimated attempt taints the summary flag
  });

  // audit L15: a non-billed settle (cost 0 AND no request-count delta — e.g. a pre-dispatch client
  // abort) must NOT write a spend_counters row for provider/team scopes.
  it('billed:false settle writes no counter row (L15)', async () => {
    const rid = randomUUID();
    await runReconcile(
      makeCtx(rid, {
        isFinalAttempt: true,
        upstreamStatus: 499,
        errorCode: 'client_closed',
        usage: null, // no usage → no cost
        activeCandidate: null,
        candidate: null,
      } as unknown as Partial<PipelineContext>),
    );
    // the attempt is recorded (audit) but no counter row exists — nothing was billed.
    const attempts =
      await h.adminSql`SELECT outcome FROM request_attempts WHERE request_id = ${rid}`;
    expect(attempts).toHaveLength(1);
    const counters = await h.adminSql`SELECT 1 FROM spend_counters`;
    expect(counters).toHaveLength(0);
  });

  // Task #15 (decided 2026-07-19): counters are MONEY-only. An error attempt that consumed real
  // tokens on a $0-priced model settles at cost 0 with no request-count delta → billed:false → no
  // counter row, same as a pre-dispatch abort. The ledger (request_attempts) still records the
  // attempt and its usage in full — activity reporting reads the ledger, not spend_counters.
  it('a $0-priced ERROR attempt with real usage writes the ledger row but no counter row (#15)', async () => {
    const rid = randomUUID();
    const freePrice: ModelPriceRow = {
      ...price,
      inputUsdPerM: '0.000000',
      outputUsdPerM: '0.000000',
      cacheReadUsdPerM: '0.000000',
    };
    await runReconcile(
      makeCtx(rid, {
        isFinalAttempt: true,
        upstreamStatus: 500,
        errorCode: 'provider_5xx',
        priceByCandidate: new Map([['openai:gpt-4.1', freePrice]]),
      } as Partial<PipelineContext>),
    );

    const attempts = await h.adminSql<
      { outcome: string; input_tokens: number; cost_usd: string }[]
    >`
      SELECT outcome, input_tokens, cost_usd FROM request_attempts WHERE request_id = ${rid}`;
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.outcome).not.toBe('ok');
    expect(attempts[0]!.input_tokens).toBe(usage.input_tokens); // usage lands in the ledger
    expect(Number(attempts[0]!.cost_usd)).toBe(0);
    const counters = await h.adminSql`SELECT 1 FROM spend_counters`;
    expect(counters).toHaveLength(0);
  });
});
