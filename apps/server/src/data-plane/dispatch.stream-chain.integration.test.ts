import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { MockAgent } from 'undici';
import { makeTestApp, type TestHarness } from '../../test/helpers/app.js';
import { policyCache } from './pipeline/auth.js';

/**
 * Streaming dispatch-chain fallback (15 §7.2). A retryable PRE-2xx (pre-first-byte) upstream failure
 * advances the candidate chain — the failed attempt reconciles NON-final, the served (fallback) model
 * bills, and fallback_from records the skipped candidate — exactly like the non-streaming path. A client
 * 4xx surfaces immediately (no cascade); an exhausted chain → 502. This is the money-path safety net for
 * the streaming fallback: it proves attempt-numbering + billing stay correct across a stream fallback.
 */
const OPENAI_ORIGIN = 'https://api.openai.com';
const sha = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest();
const KEY = 'mk-stream-chain';

/** A minimal valid OpenAI SSE completion stream, ending with usage + [DONE]. */
const sse = (model: string): string =>
  [
    `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }] })}`,
    '',
    `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1000, completion_tokens: 5, total_tokens: 1005 } })}`,
    '',
    'data: [DONE]',
    '',
  ].join('\n');

/** A 200 SSE stream whose FIRST event is an error frame (provider answered 200 then errored in-band). */
const errorFirstSse = (): string =>
  [
    `data: ${JSON.stringify({ error: { message: 'overloaded', type: 'server_error' } })}`,
    '',
    'data: [DONE]',
    '',
  ].join('\n');

let h: TestHarness;
let mockAgent: MockAgent;
const orgId = randomUUID();

interface Reply {
  status: number;
  body?: unknown;
  sse?: string;
}
function queue(replies: Reply[]): { models: () => string[] } {
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
          data: (r.sse ?? r.body) as never,
          responseOptions: {
            headers: { 'content-type': r.sse ? 'text/event-stream' : 'application/json' },
          },
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
    payload: { model, stream: true, messages: [{ role: 'user', content: 'hi' }] },
  });

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
  await sql`INSERT INTO orgs (id, name, slug) VALUES (${orgId}, 'SC', ${'sc-' + orgId.slice(0, 8)})`;
  const sealed = h.encryptor.encrypt('sk-openai-secret');
  await sql`INSERT INTO provider_keys
    (org_id, provider, label, key_prefix, key_ciphertext, key_iv, key_tag, enc_version, status)
    VALUES (${orgId}, 'openai', 'prod', 'sk-open', ${sealed.ciphertext}, ${sealed.iv}, ${sealed.tag}, ${sealed.version}, 'active')`;
  await sql`INSERT INTO virtual_keys (id, org_id, name, key_hash, key_prefix, status)
            VALUES (${randomUUID()}, ${orgId}, 'k', ${sha(KEY)}, 'mk-strm', 'active')`;
  await sql`INSERT INTO model_prices (provider, model, input_usd_per_m, output_usd_per_m, cache_read_usd_per_m, source, synced_at)
            VALUES ('openai', 'gpt-4o', 10, 30, 1, 'litellm', now()), ('openai', 'gpt-4o-mini', 1, 3, 0.1, 'litellm', now())`;
  await sql`INSERT INTO model_aliases (org_id, alias, targets) VALUES
    (${orgId}, 'multi', '[{"provider":"openai","model":"gpt-4o"},{"provider":"openai","model":"gpt-4o-mini"}]'::jsonb)`;
});
afterAll(async () => {
  await h.close();
  await mockAgent.close();
});
beforeEach(async () => {
  await h.adminSql`TRUNCATE requests, request_bodies, request_attempts, spend_counters`;
  policyCache.clear();
});

describe('streaming dispatch chain (15 §7.2)', () => {
  it('advances past a pre-2xx 500 to the next candidate and streams it; bills the SERVED model', async () => {
    const cap = queue([
      { status: 500, body: { error: { message: 'boom' } } },
      { status: 200, sse: sse('gpt-4o-mini') },
    ]);
    const res = await post('multi');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(cap.models()).toEqual(['gpt-4o', 'gpt-4o-mini']); // head 500 → advanced to the tail

    const attempts = await pollRows(
      () =>
        h.adminSql<{ attempt_number: number; outcome: string; model: string }[]>`
          SELECT attempt_number, outcome, model FROM request_attempts WHERE org_id = ${orgId} ORDER BY attempt_number`,
    );
    expect(attempts.map((a) => a.outcome)).toEqual(['error', 'ok']); // non-final error + final ok
    const req = await h.adminSql<{ cost_usd: string; model: string; fallback_from: unknown }[]>`
      SELECT cost_usd, model, fallback_from FROM requests WHERE org_id = ${orgId}`;
    expect(req).toHaveLength(1); // exactly ONE requests row (no double-reconcile across the fallback)
    expect(req[0]!.model).toBe('gpt-4o-mini'); // served model, not the failed head — the fallback billed
    expect(Number(req[0]!.cost_usd)).toBeGreaterThan(0); // billed at the served candidate
    expect(JSON.stringify(req[0]!.fallback_from)).toContain('gpt-4o'); // provenance records the skip
  });

  it('a bare client 400 surfaces immediately — never cascades on a stream', async () => {
    const cap = queue([{ status: 400, body: { error: { message: 'bad request' } } }]);
    const res = await post('multi');
    expect(res.statusCode).toBe(400);
    expect(cap.models()).toEqual(['gpt-4o']); // only the head was tried
  });

  it('all candidates fail pre-2xx → 502 all_providers_failed', async () => {
    const cap = queue([
      { status: 500, body: { error: {} } },
      { status: 503, body: { error: {} } },
    ]);
    const res = await post('multi');
    expect(res.statusCode).toBe(502);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('all_providers_failed');
    expect(cap.models()).toEqual(['gpt-4o', 'gpt-4o-mini']);
  });

  it('a single healthy candidate streams with no fallback (no regression)', async () => {
    queue([{ status: 200, sse: sse('gpt-4o') }]);
    const res = await post('gpt-4o');
    expect(res.statusCode).toBe(200);
    const attempts = await pollRows(
      () => h.adminSql`SELECT attempt_number FROM request_attempts WHERE org_id = ${orgId}`,
    );
    expect(attempts).toHaveLength(1); // one attempt, no chain walk
  });

  // §7.2 first-chunk error peek: a 200 whose FIRST SSE event is an error frame is caught pre-commit and
  // advances the chain — exactly like a pre-2xx failure — instead of committing a 200 + in-band error.
  it('advances past a 200-then-first-chunk-error to the next candidate; bills the SERVED model', async () => {
    const cap = queue([
      { status: 200, sse: errorFirstSse() }, // 200 but errors in-band as the first event
      { status: 200, sse: sse('gpt-4o-mini') },
    ]);
    const res = await post('multi');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(cap.models()).toEqual(['gpt-4o', 'gpt-4o-mini']); // first-chunk error → advanced

    const attempts = await pollRows(
      () =>
        h.adminSql<{ outcome: string }[]>`
          SELECT outcome FROM request_attempts WHERE org_id = ${orgId} ORDER BY attempt_number`,
    );
    expect(attempts.map((a) => a.outcome)).toEqual(['error', 'ok']); // head error (non-final) + served ok
    const req = await h.adminSql<{ model: string; fallback_from: unknown }[]>`
      SELECT model, fallback_from FROM requests WHERE org_id = ${orgId}`;
    expect(req).toHaveLength(1);
    expect(req[0]!.model).toBe('gpt-4o-mini'); // never committed the erroring head — served the fallback
    expect(JSON.stringify(req[0]!.fallback_from)).toContain('gpt-4o');
  });

  it('a first-chunk error on the LAST candidate → 502 all_providers_failed (never a committed 200)', async () => {
    const cap = queue([
      { status: 200, sse: errorFirstSse() },
      { status: 200, sse: errorFirstSse() },
    ]);
    const res = await post('multi');
    expect(res.statusCode).toBe(502);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('all_providers_failed');
    expect(cap.models()).toEqual(['gpt-4o', 'gpt-4o-mini']);
  });
});
