import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { MockAgent } from 'undici';
import { makeTestApp, type TestHarness } from '../../test/helpers/app.js';

/**
 * M2 Phase B exit gate: a real-OpenAI-shaped request through the full data-plane vertical
 * (AUTH → VALIDATE → ROUTE-min → DISPATCH → RECONCILE) against a real RLS-enforced Postgres,
 * with the upstream OpenAI call intercepted by an undici MockAgent (the `dispatcher` seam).
 *
 * This file is the test that catches the load-bearing landmines:
 *  - reconcile MUST run inside withOrg or RLS silently writes zero rows (asserted via adminSql);
 *  - input_tokens = prompt_tokens − cached_tokens (the cost regression);
 *  - cost computed to the cent; counters fed for every scope×period.
 */

const OPENAI_ORIGIN = 'https://api.openai.com';
const SEED_MODEL = 'gpt-4.1';

const sha = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest();
const ACTIVE_KEY = 'mk-test-active-key';
const PAUSED_KEY = 'mk-test-paused-key';
const RESTRICTED_KEY = 'mk-test-restricted-key'; // allowed_models = [gpt-4.1] only

// A real OpenAI chat.completion shape, incl. prompt_tokens_details.cached_tokens.
const completion = {
  id: 'chatcmpl-abc123',
  object: 'chat.completion',
  created: 1_700_000_000,
  model: SEED_MODEL,
  choices: [
    { index: 0, message: { role: 'assistant', content: 'hello there' }, finish_reason: 'stop' },
  ],
  usage: {
    prompt_tokens: 1000,
    completion_tokens: 500,
    total_tokens: 1500,
    prompt_tokens_details: { cached_tokens: 200 },
  },
};
// computeCost oracle: 800 full-rate input @2.5 + 200 cached @0.25 + 500 out @10 (per 1M)
//   = 2000 + 50 + 5000 = 7050 micro-USD = 0.007050 (cost.test.ts oracle).
const EXPECTED_COST = '0.007050';

let h: TestHarness;
let mockAgent: MockAgent;
const orgId = randomUUID();
const providerKeyId = randomUUID();

/** Queue one upstream reply for the next POST /v1/chat/completions. */
function interceptOnce(status: number, body: unknown): void {
  mockAgent
    .get(OPENAI_ORIGIN)
    .intercept({ path: '/v1/chat/completions', method: 'POST' })
    .reply(status, body as never, { headers: { 'content-type': 'application/json' } });
}

/** Queue one upstream SSE reply (text/event-stream body). */
function interceptSse(status: number, sseBody: string): void {
  mockAgent
    .get(OPENAI_ORIGIN)
    .intercept({ path: '/v1/chat/completions', method: 'POST' })
    .reply(status, sseBody, { headers: { 'content-type': 'text/event-stream' } });
}

/** Build an OpenAI-shaped SSE body: content deltas, optional usage-only chunk, optional [DONE]. */
function buildSse(opts: {
  contents: string[];
  usage?: { prompt: number; completion: number; cached?: number };
  done?: boolean;
}): string {
  const frames = opts.contents.map(
    (c) =>
      `data: ${JSON.stringify({ id: 'chatcmpl-x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: c } }] })}\n\n`,
  );
  if (opts.usage) {
    frames.push(
      `data: ${JSON.stringify({
        id: 'chatcmpl-x',
        object: 'chat.completion.chunk',
        choices: [],
        usage: {
          prompt_tokens: opts.usage.prompt,
          completion_tokens: opts.usage.completion,
          ...(opts.usage.cached !== undefined
            ? { prompt_tokens_details: { cached_tokens: opts.usage.cached } }
            : {}),
        },
      })}\n\n`,
    );
  }
  if (opts.done !== false) frames.push('data: [DONE]\n\n');
  return frames.join('');
}

function postStream(key: string, payload: Record<string, unknown>) {
  return h.app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    payload: {
      model: SEED_MODEL,
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      ...payload,
    },
  });
}

/**
 * Poll until `pred` holds (or timeout). RECONCILE on the success path runs AFTER the
 * response is sent (the client must not wait on the spend write), so `app.inject` resolves
 * before the requests/counters rows land — the test must wait for the post-response effect.
 */
async function waitFor<T>(fn: () => Promise<T>, pred: (v: T) => boolean, ms = 3000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (pred(v) || Date.now() - start > ms) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
}

function post(key: string | null, payload: Record<string, unknown>) {
  return h.app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: {
      'content-type': 'application/json',
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
    payload,
  });
}

beforeAll(async () => {
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect(); // undici-only; postgres-js (TCP) is unaffected
  h = await makeTestApp({ dispatcher: mockAgent });
  const sql = h.adminSql;

  await sql`INSERT INTO orgs (id, name, slug) VALUES (${orgId}, 'Acme', ${'acme-' + orgId.slice(0, 8)})`;

  const sealed = h.encryptor.encrypt('sk-openai-secret');
  await sql`
    INSERT INTO provider_keys
      (id, org_id, provider, label, key_prefix, key_ciphertext, key_iv, key_tag, enc_version, status)
    VALUES
      (${providerKeyId}, ${orgId}, 'openai', 'prod', 'sk-open',
       ${sealed.ciphertext}, ${sealed.iv}, ${sealed.tag}, ${sealed.version}, 'active')`;

  // virtual keys: active / paused / model-restricted
  await sql`INSERT INTO virtual_keys (id, org_id, name, key_hash, key_prefix, status)
            VALUES (${randomUUID()}, ${orgId}, 'active', ${sha(ACTIVE_KEY)}, 'mk-test-act', 'active')`;
  await sql`INSERT INTO virtual_keys (id, org_id, name, key_hash, key_prefix, status)
            VALUES (${randomUUID()}, ${orgId}, 'paused', ${sha(PAUSED_KEY)}, 'mk-test-pau', 'paused')`;
  await sql`INSERT INTO virtual_keys (id, org_id, name, key_hash, key_prefix, status, allowed_models)
            VALUES (${randomUUID()}, ${orgId}, 'restricted', ${sha(RESTRICTED_KEY)}, 'mk-test-res', 'active', ${[SEED_MODEL]})`;

  await sql`
    INSERT INTO model_prices
      (provider, model, input_usd_per_m, output_usd_per_m, cache_read_usd_per_m, source, synced_at)
    VALUES ('openai', ${SEED_MODEL}, 2.5, 10, 0.25, 'litellm', now())`;
});

afterAll(async () => {
  await h.close();
  await mockAgent.close();
});

beforeEach(async () => {
  // clean slate so per-test row/counter counts are exact
  await h.adminSql`TRUNCATE requests, request_bodies, spend_counters, request_attempts`;
});

describe('POST /v1/chat/completions — auth + validate rejections', () => {
  it('401 on an unknown key (OpenAI error shape + x-spillway-request-id)', async () => {
    const res = await post('mk-does-not-exist', {
      model: SEED_MODEL,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.error.type).toBe('spillway_error');
    expect(body.error.code).toBe('key_not_found');
    expect(res.headers['x-spillway-request-id']).toBeTruthy();
  });

  it('401 on a missing key', async () => {
    const res = await post(null, {
      model: SEED_MODEL,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.statusCode).toBe(401);
  });

  it('401 on a malformed (sk-) key — never reaches the DB', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer sk-not-a-spillway-key',
      },
      payload: { model: SEED_MODEL, messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('key_not_found');
  });

  it('403 key_paused on a paused key', async () => {
    const res = await post(PAUSED_KEY, {
      model: SEED_MODEL,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('key_paused');
  });

  it('403 model_not_allowed when the model is outside the key allow-list', async () => {
    const res = await post(RESTRICTED_KEY, {
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.statusCode).toBe(403);
    const body = res.json();
    expect(body.error.code).toBe('model_not_allowed');
    expect(body.error.param).toBe('model');
  });
});

describe('POST /v1/chat/completions — dispatch + reconcile', () => {
  it('upstream 400 → client 400, an error row is recorded, request_count NOT incremented (§4.4)', async () => {
    interceptOnce(400, { error: { message: 'bad request', type: 'invalid_request_error' } });
    const res = await post(ACTIVE_KEY, {
      model: SEED_MODEL,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.statusCode).toBe(400);

    const rows = await h.adminSql`SELECT status, http_status, error_code, org_id FROM requests`;
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (!row) throw new Error('expected an error requests row');
    expect(row.status).toBe('error');
    expect(row.http_status).toBe(400);
    expect(row.error_code).toBe('invalid_request'); // mapped code threaded to the row (red-team)
    expect(row.org_id).toBe(orgId);

    // an error attempt is recorded in the ledger (queryable), but request_count is success-only (§4.4)
    const attempts = await h.adminSql`SELECT outcome FROM request_attempts`;
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.outcome).toBe('error');
    // #15 (decided 2026-07-19): a $0 error settle is billed:false → NO counter rows at all. The
    // ledger row above is the only record; zero-value rows would churn updated_at and materialize
    // phantom scope rows. (This test previously pinned the opposite — 2 zero-value org rows.)
    const counters = await h.adminSql`SELECT 1 FROM spend_counters WHERE scope_type = 'org'`;
    expect(counters).toHaveLength(0);
  });

  it('a 200 with NO usage block settles an ESTIMATED row, never $0 (compat-server class)', async () => {
    // Compat/self-hosted servers routinely omit `usage`. This previously billed exactly $0 for a
    // served response — real spend invisible in the ledger. Must mirror the streaming contract:
    // a served request always produces a metered row, flagged usage_estimated.
    const { usage: _dropped, ...noUsage } = completion;
    interceptOnce(200, noUsage);
    const res = await post(ACTIVE_KEY, {
      model: SEED_MODEL,
      messages: [{ role: 'user', content: 'estimate me please' }],
    });
    expect(res.statusCode).toBe(200);

    const attempts = await waitFor(
      () =>
        h.adminSql<
          {
            input_tokens: number;
            output_tokens: number;
            usage_estimated: boolean;
            cost_usd: string;
          }[]
        >`SELECT input_tokens, output_tokens, usage_estimated, cost_usd FROM request_attempts`,
      (r) => r.length > 0,
    );
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.usage_estimated).toBe(true);
    expect(attempts[0]!.input_tokens).toBeGreaterThan(0); // estimated from the request
    expect(attempts[0]!.output_tokens).toBeGreaterThan(0); // estimated from choices[].message.content
    expect(Number(attempts[0]!.cost_usd)).toBeGreaterThan(0); // never $0 for a served response
  });

  it('upstream 200 with an unparseable body → 502 (no row recorded)', async () => {
    interceptOnce(200, 'this is not json');
    const res = await post(ACTIVE_KEY, {
      model: SEED_MODEL,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.statusCode).toBe(502);
    const rows = await h.adminSql`SELECT 1 FROM requests`;
    expect(rows).toHaveLength(0);
  });

  // ── THE NAMED EXIT GATE ───────────────────────────────────────────────────
  it('real-openai-shape request → passthrough + metered + costed + counter ticked', async () => {
    interceptOnce(200, completion);
    const res = await post(ACTIVE_KEY, {
      model: SEED_MODEL,
      messages: [{ role: 'user', content: 'hi' }],
    });

    // 1. 200 + verbatim passthrough of the upstream completion
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(completion);

    // 2. x-spillway-request-id present and === the inserted requests.id
    const reqId = res.headers['x-spillway-request-id'] as string;
    expect(reqId).toBeTruthy();

    // 3. exactly one requests row, metered correctly (reconcile runs post-send → poll)
    const rows = await waitFor(
      () => h.adminSql`SELECT * FROM requests`,
      (r) => r.length === 1,
    );
    expect(rows).toHaveLength(1);
    const r = rows[0];
    if (!r) throw new Error('expected a requests row');
    expect(r.id).toBe(reqId);
    expect(r.status).toBe('ok');
    expect(r.provider).toBe('openai');
    expect(r.model).toBe(SEED_MODEL);
    expect(r.requested_model).toBe(SEED_MODEL);
    expect(r.input_tokens).toBe(800); // 1000 prompt − 200 cached (the cost regression)
    expect(r.output_tokens).toBe(500);
    expect(r.cached_read_tokens).toBe(200);
    expect(r.usage_estimated).toBe(false);
    expect(r.org_id).toBe(orgId);

    // 4. cost to the cent
    expect(Number(r.cost_usd)).toBeCloseTo(Number(EXPECTED_COST), 6);

    // 5. six counter rows: vk / org / provider × {month, day} (provider scope added in §1.8), each
    //    ticked (request_count success-only → 1 on this OK request) + costed.
    const counters = await waitFor(
      () => h.adminSql`SELECT scope_type, period_key, spent_usd, request_count FROM spend_counters`,
      (c) => c.length === 6,
    );
    expect(counters).toHaveLength(6);
    const scopeTypes = counters.map((c) => c.scope_type).sort();
    expect(scopeTypes).toEqual([
      'org',
      'org',
      'provider',
      'provider',
      'virtual_key',
      'virtual_key',
    ]);
    for (const c of counters) {
      expect(Number(c.request_count)).toBe(1);
      expect(Number(c.spent_usd)).toBeCloseTo(Number(EXPECTED_COST), 6);
    }
  });
});

describe('POST /v1/chat/completions — streaming (Phase C)', () => {
  // ── THE NAMED STREAMING EXIT GATE ─────────────────────────────────────────
  it('streamed openai request → verbatim SSE passthrough + exact metered/costed row + counters', async () => {
    interceptSse(
      200,
      buildSse({
        contents: ['Hello', ' world'],
        usage: { prompt: 1000, completion: 500, cached: 200 },
      }),
    );
    const res = await postStream(ACTIVE_KEY, {}); // client did NOT request include_usage

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    const reqId = res.headers['x-spillway-request-id'] as string;
    expect(reqId).toBeTruthy();

    // content forwarded + [DONE] present; the INJECTED usage-only frame is stripped (D1)
    const payload = res.payload;
    expect(payload).toContain('Hello');
    expect(payload).toContain(' world');
    expect(payload).toContain('[DONE]');
    expect(payload).not.toContain('"usage"'); // client didn't ask → usage frame not forwarded

    // metered row (reconcile is post-send → poll)
    const rows = await waitFor(
      () => h.adminSql`SELECT * FROM requests`,
      (r) => r.length === 1,
    );
    const r = rows[0];
    if (!r) throw new Error('expected a streaming requests row');
    expect(r.id).toBe(reqId);
    expect(r.stream).toBe(true);
    expect(r.status).toBe('ok');
    expect(r.provider).toBe('openai');
    expect(r.input_tokens).toBe(800); // 1000 − 200 cached (captured even though frame was stripped)
    expect(r.output_tokens).toBe(500);
    expect(r.usage_estimated).toBe(false);
    expect(r.ttft_ms).not.toBeNull();
    expect(Number(r.cost_usd)).toBeCloseTo(Number(EXPECTED_COST), 6);

    const counters = await waitFor(
      () => h.adminSql`SELECT scope_type, spent_usd, request_count FROM spend_counters`,
      (c) => c.length === 4,
    );
    for (const c of counters) {
      expect(Number(c.request_count)).toBe(1);
      expect(Number(c.spent_usd)).toBeCloseTo(Number(EXPECTED_COST), 6);
    }
  });

  it('forwards the usage chunk verbatim when the client asked for include_usage', async () => {
    interceptSse(200, buildSse({ contents: ['hi'], usage: { prompt: 10, completion: 5 } }));
    const res = await postStream(ACTIVE_KEY, { stream_options: { include_usage: true } });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('"usage"'); // client asked → NOT stripped
    expect(res.payload).toContain('[DONE]');
  });

  it('no usage chunk → estimated usage (usage_estimated=true, non-zero), still metered', async () => {
    interceptSse(200, buildSse({ contents: ['Hello world'] })); // no usage frame, has [DONE]
    const res = await postStream(ACTIVE_KEY, {});
    expect(res.statusCode).toBe(200);
    const reqId = res.headers['x-spillway-request-id'] as string;

    const rows = await waitFor(
      () => h.adminSql`SELECT * FROM requests WHERE id = ${reqId}`,
      (r) => r.length === 1,
    );
    const r = rows[0];
    if (!r) throw new Error('expected a streaming requests row');
    expect(r.stream).toBe(true);
    expect(r.usage_estimated).toBe(true);
    expect(r.output_tokens).toBeGreaterThan(0); // estimated from "Hello world"
  });

  it('no [DONE] but a usage frame WAS captured → real usage (not estimated), still counted', async () => {
    // ADR-034 L10: a captured usage frame is authoritative even if the terminal [DONE] never
    // arrives — don't mislabel real usage as estimated just because the sentinel is missing.
    interceptSse(
      200,
      buildSse({ contents: ['partial'], usage: { prompt: 10, completion: 5 }, done: false }),
    );
    const res = await postStream(ACTIVE_KEY, {});
    expect(res.statusCode).toBe(200);
    const reqId = res.headers['x-spillway-request-id'] as string;

    const rows = await waitFor(
      () => h.adminSql`SELECT * FROM requests WHERE id = ${reqId}`,
      (r) => r.length === 1,
    );
    const r = rows[0];
    if (!r) throw new Error('expected a streaming requests row');
    expect(r.usage_estimated).toBe(false); // captured usage → real, despite missing [DONE]
    expect(r.output_tokens).toBe(5);
  });

  it('CRLF-bearing unknown param name does not crash the stream or lose the spend row (red-team ADR-034 C1)', async () => {
    interceptSse(200, buildSse({ contents: ['ok'], usage: { prompt: 10, completion: 5 } }));
    const res = await postStream(ACTIVE_KEY, { 'x\r\nX-Injected: evil': 1 });
    expect(res.statusCode).toBe(200); // did NOT throw in writeHead → did NOT escape to the route
    const reqId = res.headers['x-spillway-request-id'] as string;
    // the dropped-params header is sanitized — no raw CR/LF leaked into a response header
    const dp = res.headers['x-spillway-dropped-params'];
    if (typeof dp === 'string') expect(dp).not.toMatch(/[\r\n]/);

    const rows = await waitFor(
      () => h.adminSql`SELECT * FROM requests WHERE id = ${reqId}`,
      (r) => r.length === 1,
    );
    expect(rows).toHaveLength(1); // spend row NOT lost (the critical: reconcile still ran)
  });
});
