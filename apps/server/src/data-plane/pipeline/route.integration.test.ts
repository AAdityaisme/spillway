import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { MockAgent } from 'undici';
import { makeTestApp, type TestHarness } from '../../../test/helpers/app.js';

/**
 * B2.3 ROUTE exit gate: alias + literal resolution, hard-filter 403s, no_route_available 503,
 * through the full pipeline (AUTH→VALIDATE→RATELIMIT→ROUTE→DISPATCH) against real RLS Postgres +
 * an undici MockAgent upstream. Proves the routing engine replaced pickOpenAIKey correctly.
 */

const OPENAI_ORIGIN = 'https://api.openai.com';
const sha = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest();
const ACTIVE = 'mk-route-active';
const RESTRICTED = 'mk-route-restricted'; // allowed_models = [gpt-4.1]

const completion = {
  id: 'chatcmpl-x',
  object: 'chat.completion',
  created: 1_700_000_000,
  model: 'gpt-4.1',
  choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
};

let h: TestHarness;
let mockAgent: MockAgent;
const orgId = randomUUID();

/** Intercept the next upstream call; capture the request body so we can assert the resolved model. */
function interceptCapture(): { body: () => Record<string, unknown> | undefined } {
  let captured: Record<string, unknown> | undefined;
  mockAgent
    .get(OPENAI_ORIGIN)
    .intercept({ path: '/v1/chat/completions', method: 'POST' })
    .reply((opts) => {
      captured = typeof opts.body === 'string' ? JSON.parse(opts.body) : undefined;
      return {
        statusCode: 200,
        data: completion,
        responseOptions: { headers: { 'content-type': 'application/json' } },
      };
    });
  return { body: () => captured };
}

function post(key: string, payload: Record<string, unknown>, headers: Record<string, string> = {}) {
  return h.app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, ...headers },
    payload: { messages: [{ role: 'user', content: 'hi' }], ...payload },
  });
}

beforeAll(async () => {
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  h = await makeTestApp({ dispatcher: mockAgent });
  const sql = h.adminSql;
  await sql`INSERT INTO orgs (id, name, slug) VALUES (${orgId}, 'R', ${'r-' + orgId.slice(0, 8)})`;
  const sealed = h.encryptor.encrypt('sk-openai-secret');
  await sql`INSERT INTO provider_keys
    (org_id, provider, label, key_prefix, key_ciphertext, key_iv, key_tag, enc_version, status)
    VALUES (${orgId}, 'openai', 'prod', 'sk-open', ${sealed.ciphertext}, ${sealed.iv}, ${sealed.tag}, ${sealed.version}, 'active')`;
  await sql`INSERT INTO virtual_keys (id, org_id, name, key_hash, key_prefix, status)
            VALUES (${randomUUID()}, ${orgId}, 'active', ${sha(ACTIVE)}, 'mk-route-a', 'active')`;
  await sql`INSERT INTO virtual_keys (id, org_id, name, key_hash, key_prefix, status, allowed_models)
            VALUES (${randomUUID()}, ${orgId}, 'restricted', ${sha(RESTRICTED)}, 'mk-route-r', 'active', ${['gpt-4.1']})`;
  await sql`INSERT INTO model_aliases (org_id, alias, targets)
            VALUES (${orgId}, 'fast', '[{"provider":"openai","model":"gpt-4o-mini"}]'::jsonb)`;
  // An embeddings-only alias — used to prove the Part III capability hard-gate (a chat/tools request
  // routed here is a genuine unsupported_feature 400 at ROUTE, before dispatch).
  await sql`INSERT INTO model_aliases (org_id, alias, targets)
            VALUES (${orgId}, 'embed-only', '[{"provider":"openai","model":"text-embedding-3-small"}]'::jsonb)`;
  // Every dispatchable model must be priceable before the gateway will send it
  // upstream (unknown pricing is a fail-closed governance control).
  await sql`INSERT INTO model_prices
    (provider, model, input_usd_per_m, output_usd_per_m, cache_read_usd_per_m, source, synced_at)
    VALUES ('openai', 'gpt-4.1', 2, 8, 0.5, 'test', now()),
           ('openai', 'gpt-4o-mini', 0.15, 0.6, 0.05, 'test', now())`;
});

afterAll(async () => {
  await h.close();
  await mockAgent.close();
});

describe('ROUTE resolution (15 §4, B2.3)', () => {
  it('resolves a literal model to the org openai key (200)', async () => {
    const cap = interceptCapture();
    const res = await post(ACTIVE, { model: 'gpt-4.1' });
    expect(res.statusCode).toBe(200);
    expect(cap.body()?.model).toBe('gpt-4.1');
  });

  it('resolves an alias to its target model (upstream receives the rewritten model)', async () => {
    const cap = interceptCapture();
    const res = await post(ACTIVE, { model: 'fast' });
    expect(res.statusCode).toBe(200);
    expect(cap.body()?.model).toBe('gpt-4o-mini'); // alias 'fast' → gpt-4o-mini
  });

  it('hard-filters a disallowed model (403 model_not_allowed)', async () => {
    const res = await post(RESTRICTED, { model: 'gpt-4o' });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('model_not_allowed');
  });

  it('fails closed before dispatch when a routed model has no price', async () => {
    const res = await post(ACTIVE, { model: 'gpt-unpriced' });
    expect(res.statusCode).toBe(503);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('service_unavailable');
  });

  it('Part III capability hard-gate: a tools request to an embeddings model → 400 unsupported_feature', async () => {
    const res = await post(ACTIVE, {
      model: 'embed-only',
      tools: [{ type: 'function', function: { name: 'get_weather' } }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('unsupported_feature');
  });

  it('the hard-gate is non-breaking: a tools request to a tools-capable model routes normally', async () => {
    const cap = interceptCapture();
    const res = await post(ACTIVE, {
      model: 'gpt-4.1',
      tools: [{ type: 'function', function: { name: 'get_weather' } }],
    });
    expect(res.statusCode).toBe(200); // gpt-4.1 declares tools → gate passes
    expect(cap.body()?.model).toBe('gpt-4.1');
  });

  it('capability filter fails OPEN when no catalog is loaded — never no_route_available (15 §5.1)', async () => {
    // No model-capability catalog is populated (policy.capabilities is empty), so the hard filter
    // degrades to best-effort forwarding rather than emptying the pool and 503-ing every
    // require-capabilities request. The request proceeds PAST route (it fails downstream at dispatch
    // here for lack of a mocked upstream) — the invariant is that ROUTE did not reject it as
    // no_route_available. The genuine-miss 503 (catalog present, cap unmatched) is unit-tested in
    // resolve.test.ts.
    const res = await post(
      ACTIVE,
      { model: 'gpt-4.1' },
      { 'x-spillway-require-capabilities': 'vision' },
    );
    expect(res.statusCode).not.toBe(503);
    expect(res.json<{ error?: { code: string } }>().error?.code).not.toBe('no_route_available');
  });
});
