import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { MockAgent } from 'undici';
import { makeTestApp, type TestHarness } from '../../test/helpers/app.js';

/**
 * Real-socket regression suite for the client-abort wiring (audit 2026-07-07 P0).
 *
 * `app.inject()` never opens a TCP socket, so it cannot catch request-lifecycle bugs:
 * the original `req.raw.on('close')` listener fired on request-BODY completion (Node ≥16
 * IncomingMessage semantics), aborting every live upstream call while the client was still
 * connected — empty 200, org floor-billed — and 340 inject()-based tests stayed green.
 * This file talks to the server over a real socket so that class of bug cannot regress.
 */

const OPENAI_ORIGIN = 'https://api.openai.com';
const SEED_MODEL = 'gpt-4.1';
const ACTIVE_KEY = 'mk-test-abort-wiring-key';

const sha = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest();

const completion = {
  id: 'chatcmpl-abort-wiring',
  object: 'chat.completion',
  created: 1_700_000_000,
  model: SEED_MODEL,
  choices: [
    { index: 0, message: { role: 'assistant', content: 'hello there' }, finish_reason: 'stop' },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
};

let h: TestHarness;
let mockAgent: MockAgent;
let baseUrl: string;
const orgId = randomUUID();

function intercept(status: number, body: unknown, delayMs = 0) {
  const chain = mockAgent
    .get(OPENAI_ORIGIN)
    .intercept({ path: '/v1/chat/completions', method: 'POST' })
    .reply(status, body as never, { headers: { 'content-type': 'application/json' } });
  if (delayMs > 0) chain.delay(delayMs);
}

function interceptSse(sseBody: string) {
  mockAgent
    .get(OPENAI_ORIGIN)
    .intercept({ path: '/v1/chat/completions', method: 'POST' })
    .reply(200, sseBody, { headers: { 'content-type': 'text/event-stream' } });
}

/** Real HTTP POST over the wire — NOT inject(). */
function post(payload: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
  return fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ACTIVE_KEY}` },
    body: JSON.stringify({
      model: SEED_MODEL,
      messages: [{ role: 'user', content: 'hi' }],
      ...payload,
    }),
    signal,
  });
}

async function waitFor<T>(fn: () => Promise<T>, pred: (v: T) => boolean, ms = 3000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (pred(v) || Date.now() - start > ms) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
}

const attempts = () =>
  h.adminSql`SELECT outcome, error_code, input_tokens, output_tokens, cost_usd
             FROM request_attempts`;

beforeAll(async () => {
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  h = await makeTestApp({ dispatcher: mockAgent });
  const sql = h.adminSql;

  await sql`INSERT INTO orgs (id, name, slug) VALUES (${orgId}, 'AbortWiring', ${'abortw-' + orgId.slice(0, 8)})`;
  const sealed = h.encryptor.encrypt('sk-openai-secret');
  await sql`
    INSERT INTO provider_keys
      (id, org_id, provider, label, key_prefix, key_ciphertext, key_iv, key_tag, enc_version, status)
    VALUES
      (${randomUUID()}, ${orgId}, 'openai', 'prod', 'sk-open',
       ${sealed.ciphertext}, ${sealed.iv}, ${sealed.tag}, ${sealed.version}, 'active')`;
  await sql`INSERT INTO virtual_keys (id, org_id, name, key_hash, key_prefix, status)
            VALUES (${randomUUID()}, ${orgId}, 'abort-wiring', ${sha(ACTIVE_KEY)}, 'mk-test-abw', 'active')`;
  await sql`
    INSERT INTO model_prices
      (provider, model, input_usd_per_m, output_usd_per_m, cache_read_usd_per_m, source, synced_at)
    VALUES ('openai', ${SEED_MODEL}, 2.5, 10, 0.25, 'litellm', now())`;

  // Real socket: listen on an ephemeral port.
  await h.app.listen({ port: 0, host: '127.0.0.1' });
  const addr = h.app.server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no bound address');
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await h.close();
  await mockAgent.close();
});

beforeEach(async () => {
  await h.adminSql`TRUNCATE requests, request_bodies, spend_counters, request_attempts`;
});

describe('client-abort wiring over a real socket', () => {
  it('a connected client gets the full upstream body (NOT an empty 200)', async () => {
    intercept(200, completion);
    const res = await post({});
    expect(res.status).toBe(200);
    const body = (await res.json()) as typeof completion;
    expect(body.choices[0]?.message?.content).toBe('hello there');

    const rows = await waitFor(attempts, (r) => r.length > 0);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).toBe('ok');
  });

  it('a connected streaming client receives SSE frames to [DONE]', async () => {
    const frames =
      `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'hi' } }] })}\n\n` +
      `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n` +
      'data: [DONE]\n\n';
    interceptSse(frames);

    const res = await post({ stream: true, stream_options: { include_usage: true } });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('"content":"hi"');
    expect(text).toContain('data: [DONE]');

    const rows = await waitFor(attempts, (r) => r.length > 0);
    expect(rows[0]!.outcome).toBe('ok');
  });

  it('a genuine mid-flight disconnect aborts upstream and floor-bills as client_closed', async () => {
    intercept(200, completion, 1500); // upstream slower than the client's patience
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 150);
    await expect(post({}, ac.signal)).rejects.toThrow();

    const rows = await waitFor(attempts, (r) => r.length > 0);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).toBe('client_closed');
    expect(rows[0]!.error_code).toBe('client_closed_request');
    // §4.5 input-token floor: the org pays for prompt tokens the provider ingested, never $0.
    expect(Number(rows[0]!.input_tokens)).toBeGreaterThan(0);
    expect(Number(rows[0]!.output_tokens)).toBe(0);
    expect(Number(rows[0]!.cost_usd)).toBeGreaterThan(0);
  });
});
