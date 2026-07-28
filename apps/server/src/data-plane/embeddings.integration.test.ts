import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { MockAgent } from 'undici';
import { makeTestApp, type TestHarness } from '../../test/helpers/app.js';
import { policyCache } from './pipeline/auth.js';

/**
 * Task #9 exit gate: /v1/embeddings through the FULL data-plane vertical (AUTH → VALIDATE →
 * RATELIMIT → ROUTE → BUDGET → PRICING → DISPATCH → RECONCILE) against real RLS Postgres. The
 * endpoint exists to close a ledger hole — embedding traffic that bypassed the gateway made
 * chargeback statements wrong — so the assertions here are ledger-first: endpoint-tagged requests
 * row, exact input-only cost, counters ticked, and every governance gate (auth, allow-list,
 * capability, budget) applying to embeddings exactly as it does to chat.
 */

const OPENAI_ORIGIN = 'https://api.openai.com';
const EMBED_MODEL = 'text-embedding-3-small';

const sha = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest();
const ACTIVE_KEY = 'mk-embed-active-key';
const RESTRICTED_KEY = 'mk-embed-restricted'; // allowed_models = [gpt-4.1] — no embedding models

// A real OpenAI embeddings response shape. 1000 prompt tokens @ $0.02/M input = 20 µUSD.
const embeddingResponse = {
  object: 'list',
  data: [{ object: 'embedding', index: 0, embedding: [0.1, -0.2, 0.3] }],
  model: EMBED_MODEL,
  usage: { prompt_tokens: 1000, total_tokens: 1000 },
};
const EXPECTED_COST = '0.000020';

let h: TestHarness;
let mockAgent: MockAgent;
const orgId = randomUUID();

function interceptOnce(status: number, body: unknown): void {
  mockAgent
    .get(OPENAI_ORIGIN)
    .intercept({ path: '/v1/embeddings', method: 'POST' })
    .reply(status, body as never, { headers: { 'content-type': 'application/json' } });
}

function post(key: string | null, payload: Record<string, unknown>) {
  return h.app.inject({
    method: 'POST',
    url: '/v1/embeddings',
    headers: {
      'content-type': 'application/json',
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
    payload,
  });
}

/** RECONCILE runs post-response — poll until the ledger rows land. */
async function waitFor<T>(fn: () => Promise<T>, pred: (v: T) => boolean, ms = 3000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (pred(v) || Date.now() - start > ms) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
}

beforeAll(async () => {
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  h = await makeTestApp({ dispatcher: mockAgent });
  const sql = h.adminSql;

  await sql`INSERT INTO orgs (id, name, slug) VALUES (${orgId}, 'Embed', ${'em-' + orgId.slice(0, 8)})`;
  const sealed = h.encryptor.encrypt('sk-openai-secret');
  await sql`INSERT INTO provider_keys
      (org_id, provider, label, key_prefix, key_ciphertext, key_iv, key_tag, enc_version, status)
    VALUES (${orgId}, 'openai', 'prod', 'sk-open',
       ${sealed.ciphertext}, ${sealed.iv}, ${sealed.tag}, ${sealed.version}, 'active')`;
  await sql`INSERT INTO virtual_keys (id, org_id, name, key_hash, key_prefix, status)
            VALUES (${randomUUID()}, ${orgId}, 'active', ${sha(ACTIVE_KEY)}, 'mk-embed-act', 'active')`;
  await sql`INSERT INTO virtual_keys (id, org_id, name, key_hash, key_prefix, status, allowed_models)
            VALUES (${randomUUID()}, ${orgId}, 'restricted', ${sha(RESTRICTED_KEY)}, 'mk-embed-res', 'active', ${['gpt-4.1']})`;
  await sql`INSERT INTO model_prices
      (provider, model, input_usd_per_m, output_usd_per_m, cache_read_usd_per_m, source, synced_at)
    VALUES ('openai', ${EMBED_MODEL}, 0.02, 0, 0, 'litellm', now()),
           ('openai', 'gpt-4.1', 2.5, 10, 0.25, 'litellm', now()),
           ('anthropic', 'claude-haiku-4-5', 1, 5, 0.1, 'litellm', now())`;
});

afterAll(async () => {
  await h.close();
  await mockAgent.close();
});

beforeEach(async () => {
  await h.adminSql`TRUNCATE requests, request_bodies, spend_counters, request_attempts, budgets, governance_policies`;
  policyCache.clear(); // budgets + policies travel in the cached bundle — each test's seeding must be seen
});

describe('POST /v1/embeddings — full vertical', () => {
  it('proxies, meters input-only cost to the µUSD, and tags the ledger row endpoint=embeddings', async () => {
    interceptOnce(200, embeddingResponse);
    const res = await post(ACTIVE_KEY, { model: EMBED_MODEL, input: 'the quick brown fox' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.object).toBe('list'); // verbatim passthrough
    expect(body.data[0].embedding).toEqual([0.1, -0.2, 0.3]);

    const reqs = await waitFor(
      () =>
        h.adminSql<
          { endpoint: string; status: string; cost_usd: string; requested_model: string }[]
        >`SELECT endpoint, status, cost_usd::text, requested_model FROM requests`,
      (r) => r.length > 0,
    );
    expect(reqs).toHaveLength(1);
    expect(reqs[0]!.endpoint).toBe('embeddings');
    expect(reqs[0]!.status).toBe('ok');
    expect(reqs[0]!.requested_model).toBe(EMBED_MODEL);
    expect(Number(reqs[0]!.cost_usd)).toBeCloseTo(Number(EXPECTED_COST), 6);

    const attempts = await h.adminSql<{ outcome: string; input_tokens: number }[]>`
      SELECT outcome, input_tokens FROM request_attempts`;
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.outcome).toBe('ok');
    expect(attempts[0]!.input_tokens).toBe(1000);

    // org day counter: spend + success request_count — the chargeback truth
    const ctr = await waitFor(
      () =>
        h.adminSql<{ spent_usd: string; request_count: number }[]>`
          SELECT spent_usd::text, request_count FROM spend_counters
           WHERE scope_type = 'org' AND period_key LIKE '____-__-__'`,
      (r) => r.length > 0,
    );
    expect(Number(ctr[0]!.spent_usd)).toBeCloseTo(Number(EXPECTED_COST), 6);
    expect(Number(ctr[0]!.request_count)).toBe(1);
  });

  it('strips-and-records chat params on an embeddings body (x-spillway-dropped-params)', async () => {
    interceptOnce(200, embeddingResponse);
    const res = await post(ACTIVE_KEY, {
      model: EMBED_MODEL,
      input: 'hi',
      temperature: 0.7,
      messages: [{ role: 'user', content: 'not an embeddings field' }],
    });
    expect(res.statusCode).toBe(200);
    const dropped = String(res.headers['x-spillway-dropped-params'] ?? '');
    expect(dropped).toContain('temperature');
    expect(dropped).toContain('messages');
  });

  it('401s an unknown key — same auth gate as chat', async () => {
    const res = await post('mk-nope', { model: EMBED_MODEL, input: 'hi' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('key_not_found');
  });

  it('400s a body with no input', async () => {
    const res = await post(ACTIVE_KEY, { model: EMBED_MODEL });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_request');
  });

  it('403s a model outside the key allow-list', async () => {
    const res = await post(RESTRICTED_KEY, { model: EMBED_MODEL, input: 'hi' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('model_not_allowed');
  });

  it('hard-gates a chat-only model on the embeddings capability (never dispatches)', async () => {
    // claude-haiku-4-5 is priced + routable for CHAT; its catalog declares no 'embeddings'
    // feature, so ROUTE must gate it out — this is the fail-closed edge of the ledger claim.
    const res = await post(ACTIVE_KEY, { model: 'claude-haiku-4-5', input: 'hi' });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500); // client-class, never dispatched
    const rows = await h.adminSql`SELECT 1 FROM request_attempts`;
    expect(rows).toHaveLength(0); // nothing reached an upstream
  });

  it('enforces budgets on embeddings — 402 with the block envelope', async () => {
    await h.adminSql`INSERT INTO budgets (org_id, scope_type, scope_id, period, limit_usd, mode, on_exceed)
      VALUES (${orgId}, 'org', ${orgId}, 'day', 0.000001, 'enforce', 'block')`;
    await h.adminSql`INSERT INTO spend_counters (org_id, scope_type, scope_id, period_key, spent_usd)
      VALUES (${orgId}, 'org', ${orgId}, to_char(now() AT TIME ZONE 'utc','YYYY-MM-DD'), 0.000001)`;
    const res = await post(ACTIVE_KEY, { model: EMBED_MODEL, input: 'hi' });
    expect(res.statusCode).toBe(402);
    expect(res.json().error.code).toBe('budget_exceeded');
    // the fire-and-forget blocked row carries the REAL endpoint (was hardcoded 'chat_completions')
    const blocked = await waitFor(
      () =>
        h.adminSql<{ endpoint: string }[]>`
          SELECT endpoint FROM requests WHERE status = 'blocked'`,
      (r) => r.length > 0,
    );
    expect(blocked[0]!.endpoint).toBe('embeddings');
  });

  it('endpoint-scoped guardrails SEE embeddings traffic — deny fires + ledger row tagged', async () => {
    // Red-team task #9: the CEL activation hardcoded endpoint='chat_completions', so a policy like
    // this one could never fire on /v1/embeddings (or /v1/messages) — endpoint governance fail-open.
    await h.adminSql`INSERT INTO governance_policies (org_id, name, effect, reason, match, enforcement, enabled)
      VALUES (${orgId}, 'no-embeddings', 'deny', 'embeddings blocked',
              ${JSON.stringify({ endpoints: ['embeddings'] })}::jsonb, 'enforce', true)`;
    const res = await post(ACTIVE_KEY, { model: EMBED_MODEL, input: 'hi' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('rule_deny');

    const rows = await waitFor(
      () =>
        h.adminSql<{ endpoint: string; status: string }[]>`
          SELECT endpoint, status FROM requests`,
      (r) => r.length > 0,
    );
    expect(rows[0]!.status).toBe('blocked');
    expect(rows[0]!.endpoint).toBe('embeddings');
  });

  it('a chat_completions-scoped guardrail does NOT match embeddings (no over-block)', async () => {
    await h.adminSql`INSERT INTO governance_policies (org_id, name, effect, reason, match, enforcement, enabled)
      VALUES (${orgId}, 'chat-only', 'deny', 'chat blocked',
              ${JSON.stringify({ endpoints: ['chat_completions'] })}::jsonb, 'enforce', true)`;
    interceptOnce(200, embeddingResponse);
    const res = await post(ACTIVE_KEY, { model: EMBED_MODEL, input: 'hi' });
    expect(res.statusCode).toBe(200);
  });

  it('passes an upstream 4xx through and records the error attempt (bill-on-failure)', async () => {
    interceptOnce(400, { error: { message: 'invalid input', type: 'invalid_request_error' } });
    const res = await post(ACTIVE_KEY, { model: EMBED_MODEL, input: 'hi' });
    expect(res.statusCode).toBe(400);

    const reqs = await waitFor(
      () => h.adminSql<{ status: string; endpoint: string }[]>`
        SELECT status, endpoint FROM requests`,
      (r) => r.length > 0,
    );
    expect(reqs[0]!.status).toBe('error');
    expect(reqs[0]!.endpoint).toBe('embeddings');
    const attempts = await h.adminSql<{ outcome: string }[]>`
      SELECT outcome FROM request_attempts`;
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.outcome).toBe('error');
  });
});
