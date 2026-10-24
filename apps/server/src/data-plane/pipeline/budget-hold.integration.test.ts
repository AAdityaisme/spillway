import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { MockAgent } from 'undici';
import { makeTestApp, type TestHarness } from '../../../test/helpers/app.js';
import { policyCache } from './auth.js';

/**
 * The pre-dispatch budget HOLD across a candidate-chain advance (red-team P0), plus the leak checks
 * that fix has to keep honest. Same shape as budget.integration.test.ts (full pipeline vs real RLS PG,
 * undici MockAgent upstream) — but its OWN MockAgent, because that suite registers a `.persist()`ed
 * 200 intercept which would out-match the ordered per-attempt intercepts these tests depend on.
 *
 * THE BUG: reconcile released the whole hold as its first statement, unconditionally — including on
 * the NON-FINAL reconcile dispatch.ts runs to log a retryable failure before advancing to the next
 * candidate (dispatch.ts's `ctx.isFinalAttempt = false; await runReconcile(ctx)` branch). Nothing
 * re-reserved, so from the head's failure until the tail settled, the request was in flight holding
 * NOTHING. A concurrent request on the same scope read reserved=0, passed the same hard cap, took its
 * own hold, and both settled: ~2× a hard cap off one retry.
 *
 * The hold is now placed PER CANDIDATE (17 §2.2): DISPATCH reserves the next candidate's hold before
 * releasing the one it is advancing off, so these tests also pin the ADVANCE ORDERING. There is no
 * moment in a chain advance with no hold on the row — the two overlap instead, which is why the cap
 * below is sized to admit the tail's hold on its own but not the tail's plus a second request's.
 */

const OPENAI_ORIGIN = 'https://api.openai.com';
const sha = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest();
const KEY = 'mk-hold-key';
const today = new Date().toISOString().slice(0, 10);

const completion = {
  id: 'chatcmpl-h',
  object: 'chat.completion',
  created: 1_700_000_000,
  model: 'gpt-4.1',
  choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
};

/**
 * The two per-candidate holds, to the µUSD: 1 estimated input token × input rate + the 4096-token
 * default output ceiling × output rate. Head (gpt-4o-mini @ $0.15/$0.60) = $0.002458; tail (gpt-4.1 @
 * $2/$8) = $0.032770. The tail's is what must be on the row once the chain has advanced onto it.
 */
const HEAD_HOLD = '0.002458';
const TAIL_HOLD = '0.032770';

let h: TestHarness;
let mockAgent: MockAgent;
const orgId = randomUUID();

const post = (payload: Record<string, unknown>) =>
  h.app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    payload: { model: 'chain', messages: [{ role: 'user', content: 'hi' }], ...payload },
  });

/** Queue ONE upstream reply. Intercepts are consumed in registration order → one per chain attempt. */
function intercept(reply: () => { statusCode: number; data: object }, delayMs = 0): void {
  const i = mockAgent
    .get(OPENAI_ORIGIN)
    .intercept({ path: '/v1/chat/completions', method: 'POST' })
    .reply(() => ({
      ...reply(),
      responseOptions: { headers: { 'content-type': 'application/json' } },
    }));
  if (delayMs > 0) i.delay(delayMs);
}

/** The org day-counter hold, as the numeric(14,6) string PG returns ('0.000000' when no row exists). */
async function reservedUsd(): Promise<string> {
  const [r] = await h.adminSql<{ reserved_usd: string }[]>`
    SELECT reserved_usd FROM spend_counters
     WHERE org_id = ${orgId} AND scope_type = 'org' AND period_key = ${today}`;
  return r?.reserved_usd ?? '0.000000';
}

/** The route's finally releases fire-and-forget (tracked, not awaited) — poll rather than read once. */
async function pollReserved(want: string, ms = 3000): Promise<string> {
  const start = Date.now();
  for (;;) {
    const v = await reservedUsd();
    if (v === want || Date.now() - start > ms) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
}

beforeAll(async () => {
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  h = await makeTestApp({ dispatcher: mockAgent });
  const sql = h.adminSql;
  await sql`INSERT INTO orgs (id, name, slug) VALUES (${orgId}, 'H', ${'h-' + orgId.slice(0, 8)})`;
  const sealed = h.encryptor.encrypt('sk-openai-secret');
  await sql`INSERT INTO provider_keys
    (org_id, provider, label, key_prefix, key_ciphertext, key_iv, key_tag, enc_version, status)
    VALUES (${orgId}, 'openai', 'prod', 'sk-open', ${sealed.ciphertext}, ${sealed.iv}, ${sealed.tag}, ${sealed.version}, 'active')`;
  await sql`INSERT INTO virtual_keys (id, org_id, name, key_hash, key_prefix, status)
            VALUES (${randomUUID()}, ${orgId}, 'k', ${sha(KEY)}, 'mk-hold', 'active')`;
  // cheap head → pricy tail. A retryable failure on the head advances DISPATCH onto the tail, which
  // bills at 13× the head's rate — the exact shape the hold is sized for.
  await sql`INSERT INTO model_aliases (org_id, alias, targets)
            VALUES (${orgId}, 'chain',
              '{"default":[{"provider":"openai","model":"gpt-4o-mini"},{"provider":"openai","model":"gpt-4.1"}]}'::jsonb)`;
  await sql`INSERT INTO model_prices
    (provider, model, input_usd_per_m, output_usd_per_m, cache_read_usd_per_m, source, synced_at)
    VALUES ('openai', 'gpt-4.1', 2, 8, 0.5, 'test', now()),
           ('openai', 'gpt-4o-mini', 0.15, 0.6, 0.05, 'test', now())`;
});

afterAll(async () => {
  await h.close();
  await mockAgent.close();
});

beforeEach(async () => {
  await h.adminSql`TRUNCATE requests, request_bodies, spend_counters, budgets, decision_logs, routing_rules`;
  policyCache.clear(); // budgets travel in the cached bundle; bust it so each test's budget is seen
});

describe('pre-dispatch budget hold across a chain advance (red-team P0)', () => {
  it('keeps the hold through a retryable head failure — a concurrent request on the same cap is still blocked', async () => {
    // cap 0.034 is sized against the per-candidate holds: it fits the tail's $0.032770 alone (so R1's
    // own advance is admitted — a request must never block itself by advancing) but NOT that plus a
    // second request's $0.002458 head hold. So R2's verdict is decided entirely by whether R1's hold
    // is still on the row while R1 is in flight on the tail.
    await h.adminSql`INSERT INTO budgets (org_id, scope_type, scope_id, period, limit_usd, mode, on_exceed)
      VALUES (${orgId}, 'org', ${orgId}, 'day', 0.034, 'enforce', 'block')`;

    let tailDispatched: (() => void) | undefined;
    const onTail = new Promise<void>((r) => (tailDispatched = r));
    // attempt 1 — the cheap head 429s: retryable, so DISPATCH reconciles it NON-final and advances.
    intercept(() => ({
      statusCode: 429,
      data: { error: { type: 'rate_limit_error', message: 'slow down' } },
    }));
    // attempt 2 — the pricy tail, held open so R1 is provably still in flight when R2 is evaluated.
    intercept(() => {
      tailDispatched!();
      return { statusCode: 200, data: completion };
    }, 1000);

    const r1 = post({});
    await onTail; // the head has 429'd, its non-final reconcile has committed, the tail is in flight

    // THE PRE-FIX FAILURE: that non-final reconcile had already zeroed this row. It now carries the
    // TAIL's own hold — the candidate actually in flight — which also pins the advance ordering: the
    // tail's hold was reserved BEFORE the head's was released, and the head's is gone by dispatch.
    expect(await reservedUsd()).toBe(TAIL_HOLD);

    // ...and so the concurrent request must NOT pass the cap: its own $0.002458 head hold on top of
    // R1's $0.032770 crosses 0.034. Pre-fix it saw reserved=0, passed, and dispatched — there is no
    // third intercept, so a 502 here rather than a 402 is itself proof it reached a wire it should
    // never have reached.
    const r2 = await post({});
    expect(r2.statusCode).toBe(402);
    expect(r2.json<{ error: { code: string } }>().error.code).toBe('budget_exceeded');

    expect((await r1).statusCode).toBe(200);
    // R1 settled on the TAIL's rate (10 in @ $2/M + 5 out @ $8/M = $0.000060) — the spend the hold was
    // sized to cover. R2's hold went back on its block path; R1's on its final reconcile.
    expect(await pollReserved('0.000000')).toBe('0.000000');
    const [ctr] = await h.adminSql<{ spent_usd: string }[]>`
      SELECT spent_usd FROM spend_counters
       WHERE org_id = ${orgId} AND scope_type = 'org' AND period_key = ${today}`;
    expect(ctr!.spent_usd).toBe('0.000060');
  }, 20_000);

  // A retained hold never expires, so every leak permanently shrinks the customer's own cap by one
  // request's estimate — a self-inflicted DoS. These two pin the release on both terminating shapes.
  it('the served candidate holds ITS OWN cost, and the hold returns to zero afterwards', async () => {
    await h.adminSql`INSERT INTO budgets (org_id, scope_type, scope_id, period, limit_usd, mode, on_exceed)
      VALUES (${orgId}, 'org', ${orgId}, 'day', 100, 'enforce', 'block')`;
    let dispatched: (() => void) | undefined;
    const inFlight = new Promise<void>((r) => (dispatched = r));
    intercept(() => {
      dispatched!();
      return { statusCode: 200, data: completion };
    }, 500);
    const pending = post({});
    await inFlight;
    // The hold in flight is the HEAD's own cost. Pre-fix it was the chain MAXIMUM ($0.032770, the
    // gpt-4.1 tail's) posted on this row for a request that never touched gpt-4.1 — 13× the honest
    // size, and on a cap that had to absorb it.
    expect(await reservedUsd()).toBe(HEAD_HOLD);
    const res = await pending;
    expect(res.statusCode).toBe(200);
    expect(await pollReserved('0.000000')).toBe('0.000000');
    const [ctr] = await h.adminSql<{ spent_usd: string }[]>`
      SELECT spent_usd FROM spend_counters
       WHERE org_id = ${orgId} AND scope_type = 'org' AND period_key = ${today}`;
    expect(Number(ctr!.spent_usd)).toBeGreaterThan(0); // it really did settle to spend
  });

  it('no leak: the hold returns to zero after a terminal failure that exhausted the chain', async () => {
    // Both candidates 5xx: head → non-final reconcile (HOLDS) → advance → tail → terminal reconcile
    // (RELEASES) → 502. Exactly the hold-then-release path the isFinalAttempt gate creates, so this is
    // the test that would catch the gate being applied without a release on the terminal branch.
    await h.adminSql`INSERT INTO budgets (org_id, scope_type, scope_id, period, limit_usd, mode, on_exceed)
      VALUES (${orgId}, 'org', ${orgId}, 'day', 100, 'enforce', 'block')`;
    for (let i = 0; i < 2; i++) {
      intercept(() => ({
        statusCode: 500,
        data: { error: { type: 'server_error', message: 'boom' } },
      }));
    }
    const res = await post({});
    expect(res.statusCode).toBe(502);
    expect(await pollReserved('0.000000')).toBe('0.000000');
  }, 20_000);
});
