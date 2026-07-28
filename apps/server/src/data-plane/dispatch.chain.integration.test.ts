import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { MockAgent } from 'undici';
import { makeTestApp, type TestHarness } from '../../test/helpers/app.js';
import { policyCache } from './pipeline/auth.js';

/**
 * B5.3 dispatch-chain executor exit gate (15 §7): retryable failure advances the candidate chain;
 * context_window 400 switches to the typed variant; a client 400 surfaces immediately (no cascade);
 * all-exhausted → 502 all_providers_failed; the served model's price is what bills; per-attempt ledger.
 */

const OPENAI_ORIGIN = 'https://api.openai.com';
const sha = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest();
const KEY = 'mk-chain-key';

const completion = (model: string) => ({
  id: 'chatcmpl',
  object: 'chat.completion',
  created: 1_700_000_000,
  model,
  choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1000, completion_tokens: 0, total_tokens: 1000 },
});

let h: TestHarness;
let mockAgent: MockAgent;
const orgId = randomUUID();

/** Queue upstream replies consumed in order (one per attempt). captured[] records each request body. */
function queue(replies: Array<{ status: number; body: unknown }>): { models: () => string[] } {
  const models: string[] = [];
  for (const r of replies) {
    mockAgent
      .get(OPENAI_ORIGIN)
      .intercept({ path: '/v1/chat/completions', method: 'POST' })
      .reply((opts) => {
        const b =
          typeof opts.body === 'string' ? (JSON.parse(opts.body) as { model: string }) : null;
        if (b) models.push(b.model);
        return {
          statusCode: r.status,
          data: r.body as never,
          responseOptions: { headers: { 'content-type': 'application/json' } },
        };
      });
  }
  return { models: () => models };
}

const post = (model: string) =>
  h.app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    payload: { model, messages: [{ role: 'user', content: 'hi' }] },
  });

beforeAll(async () => {
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  h = await makeTestApp({ dispatcher: mockAgent });
  const sql = h.adminSql;
  await sql`INSERT INTO orgs (id, name, slug) VALUES (${orgId}, 'CH', ${'ch-' + orgId.slice(0, 8)})`;
  const sealed = h.encryptor.encrypt('sk-openai-secret');
  await sql`INSERT INTO provider_keys
    (org_id, provider, label, key_prefix, key_ciphertext, key_iv, key_tag, enc_version, status)
    VALUES (${orgId}, 'openai', 'prod', 'sk-open', ${sealed.ciphertext}, ${sealed.iv}, ${sealed.tag}, ${sealed.version}, 'active')`;
  await sql`INSERT INTO virtual_keys (id, org_id, name, key_hash, key_prefix, status)
            VALUES (${randomUUID()}, ${orgId}, 'k', ${sha(KEY)}, 'mk-chain', 'active')`;
  // gpt-4o expensive, gpt-4o-mini cheap → prove the SERVED model's price bills.
  await sql`INSERT INTO model_prices (provider, model, input_usd_per_m, output_usd_per_m, cache_read_usd_per_m, source, synced_at)
            VALUES ('openai', 'gpt-4o', 10, 30, 1, 'litellm', now()), ('openai', 'gpt-4o-mini', 1, 3, 0.1, 'litellm', now())`;
  // 'multi' = a 2-candidate default chain; 'ctx' = default + a context_window typed variant.
  await sql`INSERT INTO model_aliases (org_id, alias, targets) VALUES
    (${orgId}, 'multi', '[{"provider":"openai","model":"gpt-4o"},{"provider":"openai","model":"gpt-4o-mini"}]'::jsonb),
    (${orgId}, 'ctx', '{"default":[{"provider":"openai","model":"gpt-4o"}],"context_window":[{"provider":"openai","model":"gpt-4o-mini"}]}'::jsonb)`;
});
afterAll(async () => {
  await h.close();
  await mockAgent.close();
});
beforeEach(async () => {
  await h.adminSql`TRUNCATE requests, request_bodies, request_attempts, spend_counters`;
  policyCache.clear();
});

describe('dispatch chain executor (15 §7, B5.3)', () => {
  it('advances past a 5xx to the next candidate; bills the SERVED (fallback) model', async () => {
    const cap = queue([
      { status: 500, body: { error: { message: 'boom' } } },
      { status: 200, body: completion('gpt-4o-mini') },
    ]);
    const res = await post('multi');
    expect(res.statusCode).toBe(200);
    expect(cap.models()).toEqual(['gpt-4o', 'gpt-4o-mini']); // head 500 → advanced to the tail

    const attempts = await pollRows(
      () =>
        h.adminSql`SELECT attempt_number, outcome, model FROM request_attempts WHERE org_id = ${orgId} ORDER BY attempt_number`,
    );
    expect(attempts.map((a) => a.outcome)).toEqual(['error', 'ok']);
    // cost billed at gpt-4o-mini (1/M input): 1000 in → 0.001; NOT gpt-4o's 0.010.
    const req = await h.adminSql<{ cost_usd: string; model: string }[]>`
      SELECT cost_usd, model FROM requests WHERE org_id = ${orgId}`;
    expect(req[0]!.model).toBe('gpt-4o-mini');
    expect(Number(req[0]!.cost_usd)).toBeCloseTo(0.001, 6);
  });

  it('a context_window 400 switches to the typed-fallback variant', async () => {
    const cap = queue([
      { status: 400, body: { error: { code: 'context_length_exceeded', message: 'too long' } } },
      { status: 200, body: completion('gpt-4o-mini') },
    ]);
    const res = await post('ctx');
    expect(res.statusCode).toBe(200);
    expect(cap.models()).toEqual(['gpt-4o', 'gpt-4o-mini']); // advanced into context_window variant
  });

  it('a bare client 400 surfaces immediately — never cascades', async () => {
    const cap = queue([{ status: 400, body: { error: { message: 'bad request' } } }]);
    const res = await post('multi');
    expect(res.statusCode).toBe(400);
    expect(cap.models()).toEqual(['gpt-4o']); // only the head was tried
  });

  it('all candidates fail → 502 all_providers_failed', async () => {
    const cap = queue([
      { status: 500, body: { error: {} } },
      { status: 503, body: { error: {} } },
    ]);
    const res = await post('multi');
    expect(res.statusCode).toBe(502);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('all_providers_failed');
    expect(cap.models()).toEqual(['gpt-4o', 'gpt-4o-mini']); // both tried before giving up
  });
});

async function pollRows<T>(fn: () => Promise<T[]>, ms = 3000): Promise<T[]> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v.length > 0 || Date.now() - start > ms) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
}
