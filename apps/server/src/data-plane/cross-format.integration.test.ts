import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { MockAgent } from 'undici';
import { makeTestApp, type TestHarness } from '../../test/helpers/app.js';
import { openaiCompatAdapter } from './providers/openai-compat.js';
import type { Candidate } from './routing/compile.js';

/**
 * M2 cross-format integration gate (06-providers §2). Proves the multi-provider integration wiring
 * end-to-end against real RLS Postgres with the upstream intercepted by an undici MockAgent:
 *  - an Anthropic-model request through /v1/chat/completions dispatches to the mocked Anthropic
 *    /v1/messages upstream, reconciles Anthropic usage/cost correctly, and returns an OPENAI-shaped
 *    body (cross-format response translation);
 *  - POST /v1/messages (native Anthropic shape) routes to an Anthropic candidate and passes the
 *    response through unchanged;
 *  - GET /v1/models returns the merged catalog (aliases + concrete, OpenAI list shape);
 *  - the openai_compat adapter rejects an SSRF base_url (direct + routed);
 *  - default aliases are seeded on org creation.
 */

const ANTHROPIC_ORIGIN = 'https://api.anthropic.com';
const ANTHROPIC_MODEL = 'claude-sonnet-4-6';
const COMPAT_MODEL = 'ssrf-model';
const SSRF_BASE_URL = 'https://169.254.169.254/v1'; // https but link-local metadata → SSRF-blocked

const sha = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest();
const ACTIVE_KEY = 'mk-xfmt-active-key';

// Anthropic native (non-streaming) response. input_tokens is RAW full-rate (post-cache-breakpoint).
const anthResponse = {
  id: 'msg_abc123',
  type: 'message',
  role: 'assistant',
  model: ANTHROPIC_MODEL,
  content: [{ type: 'text', text: 'hello from claude' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 800, output_tokens: 500, cache_read_input_tokens: 200 },
};
// cost oracle (anthropic: input billed as-is, cache read separate):
//   800·3 + 200·0.3 + 500·15 (per 1M) = 2400 + 60 + 7500 = 9960 µUSD = 0.009960
const EXPECTED_COST = '0.009960';

let h: TestHarness;
let mockAgent: MockAgent;
const orgId = randomUUID();
const anthKeyId = randomUUID();
const compatKeyId = randomUUID();

function interceptAnthropic(status: number, body: unknown): void {
  mockAgent
    .get(ANTHROPIC_ORIGIN)
    .intercept({ path: '/v1/messages', method: 'POST' })
    .reply(status, body as never, { headers: { 'content-type': 'application/json' } });
}

function post(
  url: string,
  key: string | null,
  payload: Record<string, unknown>,
  extra: Record<string, string> = {},
) {
  return h.app.inject({
    method: 'POST',
    url,
    headers: {
      'content-type': 'application/json',
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...extra,
    },
    payload,
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

beforeAll(async () => {
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  h = await makeTestApp({ dispatcher: mockAgent });
  const sql = h.adminSql;

  await sql`INSERT INTO orgs (id, name, slug) VALUES (${orgId}, 'Xfmt', ${'xfmt-' + orgId.slice(0, 8)})`;

  const anthSealed = h.encryptor.encrypt('sk-ant-secret');
  await sql`
    INSERT INTO provider_keys
      (id, org_id, provider, label, key_prefix, key_ciphertext, key_iv, key_tag, enc_version, status)
    VALUES
      (${anthKeyId}, ${orgId}, 'anthropic', 'prod', 'sk-ant',
       ${anthSealed.ciphertext}, ${anthSealed.iv}, ${anthSealed.tag}, ${anthSealed.version}, 'active')`;

  const compatSealed = h.encryptor.encrypt('sk-compat-secret');
  await sql`
    INSERT INTO provider_keys
      (id, org_id, provider, label, key_prefix, base_url, key_ciphertext, key_iv, key_tag, enc_version, status)
    VALUES
      (${compatKeyId}, ${orgId}, 'openai_compat', 'internal', 'sk-cmp', ${SSRF_BASE_URL},
       ${compatSealed.ciphertext}, ${compatSealed.iv}, ${compatSealed.tag}, ${compatSealed.version}, 'active')`;

  await sql`INSERT INTO virtual_keys (id, org_id, name, key_hash, key_prefix, status)
            VALUES (${randomUUID()}, ${orgId}, 'active', ${sha(ACTIVE_KEY)}, 'mk-xfmt-act', 'active')`;

  // an alias row (so GET /v1/models returns an alias entry)
  await sql`INSERT INTO model_aliases (id, org_id, alias, targets)
            VALUES (${randomUUID()}, ${orgId}, 'spillway/balanced',
                    ${sql.json([{ provider: 'anthropic', model: ANTHROPIC_MODEL }])})`;

  // priced models: anthropic (dispatch) + compat (pricing preflight) + an openai model with no key
  await sql`INSERT INTO model_prices
              (provider, model, input_usd_per_m, output_usd_per_m, cache_read_usd_per_m, context_window, max_output_tokens, source, synced_at)
            VALUES ('anthropic', ${ANTHROPIC_MODEL}, 3, 15, 0.3, 200000, 64000, 'litellm', now())`;
  await sql`INSERT INTO model_prices (provider, model, input_usd_per_m, output_usd_per_m, source, synced_at)
            VALUES ('openai_compat', ${COMPAT_MODEL}, 1, 1, 'litellm', now())`;
  await sql`INSERT INTO model_prices (provider, model, input_usd_per_m, output_usd_per_m, context_window, source, synced_at)
            VALUES ('openai', 'gpt-4.1', 2.5, 10, 1000000, 'litellm', now())`;
});

afterAll(async () => {
  await h.close();
  await mockAgent.close();
});

beforeEach(async () => {
  await h.adminSql`TRUNCATE requests, request_bodies, spend_counters, request_attempts`;
});

describe('/v1/chat/completions → Anthropic candidate (cross-format)', () => {
  it('dispatches to the mocked Anthropic upstream, returns an OpenAI-shaped body, meters + costs correctly', async () => {
    interceptAnthropic(200, anthResponse);
    const res = await post('/v1/chat/completions', ACTIVE_KEY, {
      model: ANTHROPIC_MODEL,
      messages: [{ role: 'user', content: 'hi' }],
    });

    // 1. OpenAI-shaped response body (translated from Anthropic)
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.object).toBe('chat.completion');
    expect(body.choices[0].message.role).toBe('assistant');
    expect(body.choices[0].message.content).toBe('hello from claude');
    expect(body.choices[0].finish_reason).toBe('stop'); // end_turn → stop
    // OpenAI usage semantics: prompt_tokens = total input (800 + 200 cached); cached surfaced separately
    expect(body.usage.prompt_tokens).toBe(1000);
    expect(body.usage.completion_tokens).toBe(500);
    expect(body.usage.prompt_tokens_details.cached_tokens).toBe(200);

    // 2. metered row: provider anthropic, RAW input (not summed with cache), exact cost
    const rows = await waitFor(
      () => h.adminSql`SELECT * FROM requests`,
      (r) => r.length === 1,
    );
    const r = rows[0];
    if (!r) throw new Error('expected a requests row');
    expect(r.provider).toBe('anthropic');
    expect(r.model).toBe(ANTHROPIC_MODEL);
    expect(r.status).toBe('ok');
    expect(r.endpoint).toBe('chat_completions');
    expect(r.input_tokens).toBe(800); // raw full-rate (Anthropic semantics — NOT 1000)
    expect(r.output_tokens).toBe(500);
    expect(r.cached_read_tokens).toBe(200);
    expect(r.usage_estimated).toBe(false);
    expect(Number(r.cost_usd)).toBeCloseTo(Number(EXPECTED_COST), 6);
  });
});

describe('POST /v1/messages (native Anthropic)', () => {
  it('routes to an Anthropic candidate and passes the Anthropic response through', async () => {
    interceptAnthropic(200, anthResponse);
    const res = await post('/v1/messages', ACTIVE_KEY, {
      model: ANTHROPIC_MODEL,
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    // native Anthropic shape passthrough (NOT translated)
    expect(body.type).toBe('message');
    expect(body.role).toBe('assistant');
    expect(body.content[0].type).toBe('text');
    expect(body.content[0].text).toBe('hello from claude');
    expect(body.stop_reason).toBe('end_turn');

    const rows = await waitFor(
      () => h.adminSql`SELECT * FROM requests`,
      (r) => r.length === 1,
    );
    const r = rows[0];
    if (!r) throw new Error('expected a requests row');
    expect(r.endpoint).toBe('messages');
    expect(r.provider).toBe('anthropic');
    expect(r.status).toBe('ok');
    expect(r.input_tokens).toBe(800);
    expect(Number(r.cost_usd)).toBeCloseTo(Number(EXPECTED_COST), 6);
  });
});

describe('GET /v1/models', () => {
  it('returns the merged catalog (aliases first, then concrete models, OpenAI list shape)', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: `Bearer ${ACTIVE_KEY}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      object: string;
      data: Array<{
        id: string;
        object: string;
        owned_by: string;
        spillway: {
          provider: string;
          is_alias: boolean;
          available: boolean;
          alias_targets: unknown;
        };
      }>;
    }>();
    expect(body.object).toBe('list');

    const alias = body.data.find((m) => m.id === 'spillway/balanced');
    expect(alias).toBeDefined();
    expect(alias!.spillway.is_alias).toBe(true);
    expect(alias!.owned_by).toBe('spillway');
    expect(alias!.spillway.available).toBe(true); // anthropic key is active

    const anthModel = body.data.find((m) => m.id === ANTHROPIC_MODEL);
    expect(anthModel).toBeDefined();
    expect(anthModel!.spillway.provider).toBe('anthropic');
    expect(anthModel!.spillway.available).toBe(true);

    // an openai model with no active provider key → listed, available:false
    const openaiModel = body.data.find((m) => m.id === 'gpt-4.1');
    expect(openaiModel).toBeDefined();
    expect(openaiModel!.owned_by).toBe('openai');
    expect(openaiModel!.spillway.available).toBe(false);

    // ordering: the alias precedes every concrete model
    const aliasIdx = body.data.findIndex((m) => m.spillway.is_alias);
    const firstConcreteIdx = body.data.findIndex((m) => !m.spillway.is_alias);
    expect(aliasIdx).toBeLessThan(firstConcreteIdx);
  });

  it('401 without a key', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/v1/models' });
    expect(res.statusCode).toBe(401);
  });
});

describe('openai_compat SSRF base_url rejection', () => {
  it('the adapter throws on an internal/link-local base_url (dispatch-time re-validation)', () => {
    const candidate: Candidate = {
      provider: 'openai_compat',
      model: COMPAT_MODEL,
      providerKeyId: compatKeyId,
      baseUrl: SSRF_BASE_URL,
    };
    expect(() =>
      openaiCompatAdapter.transform(
        { model: COMPAT_MODEL, messages: [{ role: 'user', content: 'hi' }] },
        candidate,
        'sk-compat-secret',
        { injectUsage: false },
      ),
    ).toThrow();
  });

  it('a routed request to an SSRF compat candidate never reaches upstream (502, no success)', async () => {
    const res = await post(
      '/v1/chat/completions',
      ACTIVE_KEY,
      { model: COMPAT_MODEL, messages: [{ role: 'user', content: 'hi' }] },
      { 'x-spillway-provider': 'openai_compat' }, // knob → route to the compat key
    );
    expect(res.statusCode).toBe(502); // config fault → chain exhausted, never dispatched upstream
  });
});

describe('default alias seeding on org creation', () => {
  it('POST /api/orgs seeds spillway/{cheap,balanced,premium}', async () => {
    const sub = `user_${randomUUID().slice(0, 8)}`;
    const tok = await h.token(sub);
    const authH = { authorization: `Bearer ${tok}` };
    await h.app.inject({ method: 'GET', url: '/api/orgs', headers: authH }); // mirror the user row
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/orgs',
      headers: authH,
      payload: { name: 'Seeded', slug: 'seeded-' + randomUUID().slice(0, 8) },
    });
    expect(res.statusCode).toBe(201);
    const newOrgId = res.json<{ org: { id: string } }>().org.id;

    const aliases =
      await h.adminSql`SELECT alias, targets FROM model_aliases WHERE org_id = ${newOrgId} ORDER BY alias`;
    expect(aliases.map((a) => a.alias)).toEqual([
      'spillway/balanced',
      'spillway/cheap',
      'spillway/premium',
    ]);
    const cheap = aliases.find((a) => a.alias === 'spillway/cheap');
    expect(cheap!.targets).toEqual([
      { provider: 'gemini', model: 'gemini-2.5-flash-lite' },
      { provider: 'openai', model: 'gpt-4.1-nano' },
    ]);
  });
});
