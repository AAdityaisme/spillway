import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { MockAgent } from 'undici';
import { makeTestApp, type TestHarness } from '../../test/helpers/app.js';
import { reconcileSampleCount, resetReconcileSlo } from './reconcile.slo.js';

/**
 * B3.2 commit-before-ack (17 §4.6, operator directive #1). On the non-streaming success path,
 * reconcile durably commits spend BEFORE reply.send — so the spend row is already present the instant
 * the client sees the 200 (no post-ack window where a crash loses the charge). Proven here by reading
 * the counter with NO polling: if it weren't committed before ack, inject would resolve first and the
 * read would be empty.
 */

const OPENAI_ORIGIN = 'https://api.openai.com';
const sha = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest();
const KEY = 'mk-crash-key';

const completion = {
  id: 'chatcmpl-c',
  object: 'chat.completion',
  created: 1_700_000_000,
  model: 'gpt-4.1',
  choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 },
};

let h: TestHarness;
let mockAgent: MockAgent;
const orgId = randomUUID();

beforeAll(async () => {
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  h = await makeTestApp({ dispatcher: mockAgent });
  const sql = h.adminSql;
  await sql`INSERT INTO orgs (id, name, slug) VALUES (${orgId}, 'C', ${'c-' + orgId.slice(0, 8)})`;
  const sealed = h.encryptor.encrypt('sk-openai-secret');
  await sql`INSERT INTO provider_keys
    (org_id, provider, label, key_prefix, key_ciphertext, key_iv, key_tag, enc_version, status)
    VALUES (${orgId}, 'openai', 'prod', 'sk-open', ${sealed.ciphertext}, ${sealed.iv}, ${sealed.tag}, ${sealed.version}, 'active')`;
  await sql`INSERT INTO virtual_keys (id, org_id, name, key_hash, key_prefix, status)
            VALUES (${randomUUID()}, ${orgId}, 'k', ${sha(KEY)}, 'mk-crash', 'active')`;
  await sql`INSERT INTO model_prices (provider, model, input_usd_per_m, output_usd_per_m, cache_read_usd_per_m, source, synced_at)
            VALUES ('openai', 'gpt-4.1', 2.5, 10, 0.25, 'litellm', now())`;
});
afterAll(async () => {
  await h.close();
  await mockAgent.close();
});
beforeEach(async () => {
  await h.adminSql`TRUNCATE requests, request_bodies, request_attempts, spend_counters`;
  resetReconcileSlo();
});

describe('commit-before-ack (17 §4.6, B3.2)', () => {
  it('spend is durably committed BEFORE the 200 is acked (no post-ack loss window)', async () => {
    mockAgent
      .get(OPENAI_ORIGIN)
      .intercept({ path: '/v1/chat/completions', method: 'POST' })
      .reply(200, completion as never, { headers: { 'content-type': 'application/json' } });

    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      payload: { model: 'gpt-4.1', messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(res.statusCode).toBe(200);

    // NO waitFor: the moment the client has its 200, the ledger + counter must ALREADY exist.
    const attempts = await h.adminSql`SELECT outcome FROM request_attempts WHERE org_id = ${orgId}`;
    expect(attempts).toHaveLength(1);
    const req = await h.adminSql`SELECT status FROM requests WHERE org_id = ${orgId}`;
    expect(req).toHaveLength(1);
    const ctr = await h.adminSql<{ request_count: number }[]>`
      SELECT request_count FROM spend_counters WHERE org_id = ${orgId} AND scope_type = 'org' LIMIT 1`;
    expect(Number(ctr[0]!.request_count)).toBe(1);

    // SLO instrument recorded the reconcile-tx latency.
    expect(reconcileSampleCount()).toBeGreaterThanOrEqual(1);
  });

  it('STREAMING: spend committed BEFORE the stream half-closes (reconcile precedes raw.end, red-team B3)', async () => {
    const sse =
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n' +
      'data: {"choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":500,"total_tokens":1500}}\n\n' +
      'data: [DONE]\n\n';
    mockAgent
      .get(OPENAI_ORIGIN)
      .intercept({ path: '/v1/chat/completions', method: 'POST' })
      .reply(200, sse, { headers: { 'content-type': 'text/event-stream' } });

    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      payload: { model: 'gpt-4.1', stream: true, messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(res.statusCode).toBe(200);

    // NO polling: the stream only completes AFTER reconcile commits (raw.end runs last), so the
    // ledger + counter must already exist the instant inject resolves. A pre-fix build (raw.end before
    // reconcile) would resolve inject first and read an empty ledger.
    const attempts = await h.adminSql`SELECT outcome FROM request_attempts WHERE org_id = ${orgId}`;
    expect(attempts).toHaveLength(1);
    const ctr = await h.adminSql<{ request_count: number }[]>`
      SELECT request_count FROM spend_counters WHERE org_id = ${orgId} AND scope_type = 'org' LIMIT 1`;
    expect(Number(ctr[0]!.request_count)).toBe(1);
  });
});
