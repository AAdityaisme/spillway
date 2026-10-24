import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { MockAgent } from 'undici';
import { makeTestApp, type TestHarness } from '../../../test/helpers/app.js';
import { providerScopeId } from '../budget/resolver.js';
import { policyCache } from './auth.js';

/**
 * Provider-scoped enforce budgets across a CROSS-PROVIDER candidate chain (17 §2.2).
 *
 * THE GAP these pin. BUDGET used to run once, at the chain head, and filter provider budgets to the
 * HEAD provider — the spec said "provider budgets apply only to the served head provider", which
 * quietly assumed head == served. It isn't: routing builds chains of {provider, model} pairs with no
 * same-provider constraint, and DISPATCH advances across providers on any retryable failure without
 * re-entering BUDGET. Two consequences, one per test below:
 *   (a) a cap scoped to a TAIL provider was filtered out of every request whose head was a different
 *       provider, so it was never evaluated — while reconcile still bumped that provider's counter
 *       with the real spend. The cap was bookkeeping, not a control.
 *   (b) the request's single hold was sized max-over-chain and posted on the HEAD provider's counter
 *       row, so a pricey candidate belonging to ANOTHER provider inflated the head's cap by spend that
 *       structurally could not land on it — a false 402 on a cap that was never at risk.
 *
 * Both tests FAIL against the pre-fix code, and in opposite directions (a served 200 that should not
 * have been served; a 402 that should have been a 200), which is why they are worth having as a pair.
 */

const OPENAI_ORIGIN = 'https://api.openai.com';
const ANTHROPIC_ORIGIN = 'https://api.anthropic.com';
const sha = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest();
const KEY = 'mk-provscope-key';
const today = new Date().toISOString().slice(0, 10);

const HEAD_MODEL = 'gpt-4o-mini'; // openai head: $0.15/$0.60 per M → hold $0.002458
const TAIL_MODEL = 'claude-tail'; // anthropic tail: $2/$8 per M → hold $0.032770

const openaiCompletion = {
  id: 'chatcmpl-ps',
  object: 'chat.completion',
  created: 1_700_000_000,
  model: HEAD_MODEL,
  choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
};

const anthropicMessage = {
  id: 'msg_ps',
  type: 'message',
  role: 'assistant',
  model: TAIL_MODEL,
  content: [{ type: 'text', text: 'hi from the tail' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 10, output_tokens: 5 },
};

let h: TestHarness;
let mockAgent: MockAgent;
const orgId = randomUUID();
/** Deterministic provider scope ids — what a provider budget's scope_id and counter row must be. */
let openaiScope: string;
let anthropicScope: string;
/** Every upstream call the chain actually made, in order. */
let calls: string[] = [];

const post = () =>
  h.app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    payload: { model: 'xchain', messages: [{ role: 'user', content: 'hi' }] },
  });

/** One openai reply; intercepts are consumed in registration order (one per chain attempt). */
function interceptOpenai(statusCode: number, data: object): void {
  mockAgent
    .get(OPENAI_ORIGIN)
    .intercept({ path: '/v1/chat/completions', method: 'POST' })
    .reply(() => {
      calls.push('openai');
      return {
        statusCode,
        data,
        responseOptions: { headers: { 'content-type': 'application/json' } },
      };
    });
}

/** One anthropic reply. Registered even in the tests that must NOT reach it — an unconsumed intercept
 *  is the point: if the fix regresses, the chain dispatches onto it and the request 200s. */
function interceptAnthropic(statusCode: number, data: object): void {
  mockAgent
    .get(ANTHROPIC_ORIGIN)
    .intercept({ path: '/v1/messages', method: 'POST' })
    .reply(() => {
      calls.push('anthropic');
      return {
        statusCode,
        data,
        responseOptions: { headers: { 'content-type': 'application/json' } },
      };
    });
}

/** A provider-scope counter row's money, as the numeric(14,6) strings PG returns. */
async function providerCounter(
  scopeId: string,
): Promise<{ spent_usd: string; reserved_usd: string }> {
  const [r] = await h.adminSql<{ spent_usd: string; reserved_usd: string }[]>`
    SELECT spent_usd, reserved_usd FROM spend_counters
     WHERE org_id = ${orgId} AND scope_type = 'provider'
       AND scope_id = ${scopeId} AND period_key = ${today}`;
  return r ?? { spent_usd: '0.000000', reserved_usd: '0.000000' };
}

/** Releases are fire-and-forget (tracked, not awaited) — poll rather than read once. */
async function pollReserved(scopeId: string, want: string, ms = 3000): Promise<string> {
  const start = Date.now();
  for (;;) {
    const v = (await providerCounter(scopeId)).reserved_usd;
    if (v === want || Date.now() - start > ms) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function pollRows<T>(fn: () => Promise<T[]>, ms = 3000): Promise<T[]> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v.length > 0 || Date.now() - start > ms) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
}

beforeAll(async () => {
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  h = await makeTestApp({ dispatcher: mockAgent });
  const sql = h.adminSql;
  await sql`INSERT INTO orgs (id, name, slug) VALUES (${orgId}, 'PS', ${'ps-' + orgId.slice(0, 8)})`;
  for (const [provider, prefix, secret] of [
    ['openai', 'sk-open', 'sk-openai-secret'],
    ['anthropic', 'sk-ant', 'sk-ant-secret'],
  ] as const) {
    const sealed = h.encryptor.encrypt(secret);
    await sql`INSERT INTO provider_keys
      (org_id, provider, label, key_prefix, key_ciphertext, key_iv, key_tag, enc_version, status)
      VALUES (${orgId}, ${provider}, 'prod', ${prefix}, ${sealed.ciphertext}, ${sealed.iv}, ${sealed.tag}, ${sealed.version}, 'active')`;
  }
  await sql`INSERT INTO virtual_keys (id, org_id, name, key_hash, key_prefix, status)
            VALUES (${randomUUID()}, ${orgId}, 'k', ${sha(KEY)}, 'mk-provsc', 'active')`;
  // The whole point: a chain whose head and tail belong to DIFFERENT providers.
  await sql`INSERT INTO model_aliases (org_id, alias, targets)
            VALUES (${orgId}, 'xchain',
              '[{"provider":"openai","model":"gpt-4o-mini"},{"provider":"anthropic","model":"claude-tail"}]'::jsonb)`;
  await sql`INSERT INTO model_prices
    (provider, model, input_usd_per_m, output_usd_per_m, cache_read_usd_per_m, source, synced_at)
    VALUES ('openai', ${HEAD_MODEL}, 0.15, 0.6, 0.05, 'test', now()),
           ('anthropic', ${TAIL_MODEL}, 2, 8, 0.5, 'test', now())`;
  openaiScope = providerScopeId(orgId, 'openai');
  anthropicScope = providerScopeId(orgId, 'anthropic');
});

afterAll(async () => {
  await h.close();
  await mockAgent.close();
});

beforeEach(async () => {
  await h.adminSql`TRUNCATE requests, request_bodies, request_attempts, spend_counters, budgets, decision_logs`;
  policyCache.clear(); // budgets travel in the cached bundle; bust it so each test's budget is seen
  calls = [];
});

/** Seed a provider counter's spend for today (the day-period key a 'day' budget compares against). */
async function seedProviderSpend(scopeId: string, usd: string): Promise<void> {
  await h.adminSql`INSERT INTO spend_counters (org_id, scope_type, scope_id, period_key, spent_usd)
    VALUES (${orgId}, 'provider', ${scopeId}, ${today}, ${usd})
    ON CONFLICT (scope_type, scope_id, period_key) DO UPDATE SET spent_usd = ${usd}`;
}

describe('provider budgets bind the candidate being dispatched, not the chain head (17 §2.2)', () => {
  it('a TAIL provider cap blocks the advance onto it — the chain exhausts instead of overspending', async () => {
    // anthropic is capped at $0.05/day and has already spent it. openai (the head) is uncapped, so
    // pre-fix this budget was filtered out of the request entirely: the head 500s, the chain advances
    // onto anthropic, and it is SERVED (200) against an exhausted cap that reconcile then bumps
    // further. Post-fix anthropic is evaluated as the candidate about to be dispatched, is over its
    // own cap, and is skipped — which exhausts the chain into the existing all_providers_failed.
    await h.adminSql`INSERT INTO budgets (org_id, scope_type, scope_id, period, limit_usd, mode, on_exceed)
      VALUES (${orgId}, 'provider', ${anthropicScope}, 'day', 0.05, 'enforce', 'block')`;
    await seedProviderSpend(anthropicScope, '0.05'); // at the limit → blocks (>=)

    interceptOpenai(500, { error: { type: 'server_error', message: 'boom' } });
    interceptAnthropic(200, anthropicMessage); // must go unconsumed

    const res = await post();
    expect(res.statusCode).toBe(502); // PRE-FIX: 200, served by the capped provider
    expect(res.json<{ error: { code: string } }>().error.code).toBe('all_providers_failed');
    expect(calls).toEqual(['openai']); // the capped provider was never dispatched to

    // The capped counter must be untouched: no new spend, and no hold left behind on the skip path.
    const anth = await providerCounter(anthropicScope);
    expect(anth.spent_usd).toBe('0.050000');
    expect(await pollReserved(anthropicScope, '0.000000')).toBe('0.000000');

    // The failed head attempt is still fully accounted for — a skipped candidate must not turn the
    // billed attempt into an orphan (no `requests` row), which is what an over-optimistic "is there a
    // fallback left" answer would have caused.
    const reqs = await pollRows(
      () => h.adminSql<{ status: string }[]>`SELECT status FROM requests WHERE org_id = ${orgId}`,
    );
    expect(reqs.map((r) => r.status)).toEqual(['error']);
  }, 20_000);

  it('positive control: the SAME chain serves the tail when its provider cap has headroom', async () => {
    // Identical to the test above minus the seeded spend, so the 502 there is provably caused by the
    // cap and not by the chain shape, the anthropic mock, or the advance itself.
    await h.adminSql`INSERT INTO budgets (org_id, scope_type, scope_id, period, limit_usd, mode, on_exceed)
      VALUES (${orgId}, 'provider', ${anthropicScope}, 'day', 0.05, 'enforce', 'block')`;

    interceptOpenai(500, { error: { type: 'server_error', message: 'boom' } });
    interceptAnthropic(200, anthropicMessage);

    const res = await post();
    expect(res.statusCode).toBe(200);
    expect(calls).toEqual(['openai', 'anthropic']);

    // The hold followed the chain: the tail's spend landed on the ANTHROPIC provider counter (10 in @
    // $2/M + 5 out @ $8/M = $0.000060), and its hold was released once the request stopped dispatching.
    const anth = await providerCounter(anthropicScope);
    expect(anth.spent_usd).toBe('0.000060');
    expect(await pollReserved(anthropicScope, '0.000000')).toBe('0.000000');
  }, 20_000);

  it('a HEAD provider cap does not fire for a hold belonging to a DIFFERENT provider', async () => {
    // openai is capped at $0.01/day with nothing spent. The head's own hold is $0.002458 — a fifth of
    // the cap — so this request must be served. Pre-fix the hold was sized max-over-chain, i.e. for
    // the ANTHROPIC tail ($0.032770), and posted on the OPENAI provider row: 3× the cap, a 402 for
    // spend that could only ever have landed on anthropic's counter.
    await h.adminSql`INSERT INTO budgets (org_id, scope_type, scope_id, period, limit_usd, mode, on_exceed)
      VALUES (${orgId}, 'provider', ${openaiScope}, 'day', 0.01, 'enforce', 'block')`;

    interceptOpenai(200, openaiCompletion);

    const res = await post();
    expect(res.statusCode).toBe(200); // PRE-FIX: 402 budget_exceeded on openai's cap
    expect(calls).toEqual(['openai']);

    const oa = await providerCounter(openaiScope);
    expect(Number(oa.spent_usd)).toBeGreaterThan(0);
    expect(await pollReserved(openaiScope, '0.000000')).toBe('0.000000');
  });

  it('the FIRST candidate over its own provider cap still 402s with the blocked row (surface unchanged)', async () => {
    // The per-candidate gate must not have moved the first candidate's outcome: an at-limit cap on the
    // provider the request is about to be dispatched to is still a hard 402 with the governance write,
    // not a skip into all_providers_failed.
    await h.adminSql`INSERT INTO budgets (org_id, scope_type, scope_id, period, limit_usd, mode, on_exceed)
      VALUES (${orgId}, 'provider', ${openaiScope}, 'day', 0.001, 'enforce', 'block')`;
    await seedProviderSpend(openaiScope, '0.001');
    interceptAnthropic(200, anthropicMessage); // nothing may be dispatched, to either provider

    const res = await post();
    expect(res.statusCode).toBe(402);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('budget_exceeded');
    expect(res.headers['x-spillway-block-scope-type']).toBe('provider');
    expect(calls).toEqual([]);

    const blocked = await pollRows(
      () => h.adminSql<{ block_scope_type: string }[]>`
        SELECT block_scope_type FROM requests WHERE org_id = ${orgId} AND status = 'blocked'`,
    );
    expect(blocked[0]?.block_scope_type).toBe('provider');
    expect(await pollReserved(openaiScope, '0.000000')).toBe('0.000000');
  });
});
