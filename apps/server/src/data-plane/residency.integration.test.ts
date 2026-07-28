import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { MockAgent } from 'undici';
import { makeTestApp, type TestHarness } from '../../test/helpers/app.js';
import { policyCache } from './pipeline/auth.js';
import { resetResidencyCache } from './routing/residency.js';

/**
 * part-3/02 residency routing gate (end to end). A model tagged `residency_class='us_only'` in the
 * registry is unreachable by a `none`-compliance key (fail-closed 503 at ROUTE, before dispatch) but
 * reachable by a `us_only`-compliance key. Proves the whole chain: registry residency → bundle
 * compliance_class → route gate.
 */
const OPENAI_ORIGIN = 'https://api.openai.com';
const sha = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest();
const NONE_KEY = 'mk-res-none';
const US_KEY = 'mk-res-us';

const completion = {
  id: 'x',
  object: 'chat.completion',
  created: 1,
  model: 'gpt-4o',
  choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
};

let h: TestHarness;
let mockAgent: MockAgent;
const orgId = randomUUID();

function post(key: string) {
  return h.app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    payload: { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] },
  });
}

beforeAll(async () => {
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  h = await makeTestApp({ dispatcher: mockAgent });
  const sql = h.adminSql;
  await sql`INSERT INTO orgs (id, name, slug) VALUES (${orgId}, 'R', ${'r-' + orgId.slice(0, 8)})`;
  const sealed = h.encryptor.encrypt('sk-openai');
  await sql`INSERT INTO provider_keys
    (org_id, provider, label, key_prefix, key_ciphertext, key_iv, key_tag, enc_version, status)
    VALUES (${orgId}, 'openai', 'p', 'sk-o', ${sealed.ciphertext}, ${sealed.iv}, ${sealed.tag}, ${sealed.version}, 'active')`;
  // Two keys: default (inherits org default 'none') and an explicit us_only key.
  await sql`INSERT INTO virtual_keys (id, org_id, name, key_hash, key_prefix, status)
            VALUES (${randomUUID()}, ${orgId}, 'none', ${sha(NONE_KEY)}, 'mk-rn', 'active')`;
  await sql`INSERT INTO virtual_keys (id, org_id, name, key_hash, key_prefix, status, compliance_class)
            VALUES (${randomUUID()}, ${orgId}, 'us', ${sha(US_KEY)}, 'mk-ru', 'active', 'us_only')`;
  await sql`INSERT INTO model_prices (provider, model, input_usd_per_m, output_usd_per_m, cache_read_usd_per_m, source, synced_at)
            VALUES ('openai', 'gpt-4o', 2.5, 10, 1.25, 'litellm', now())`;
  // Tag gpt-4o as a us_only-residency model in the registry.
  await sql`INSERT INTO model_registry (canonical_id, provider_model_id, provider, lifecycle, residency_class, routing_eligible)
            VALUES ('openai/gpt-4o', 'gpt-4o', 'openai', 'beta', 'us_only', true)`;
});
afterAll(async () => {
  await h.close();
  await mockAgent.close();
});
beforeEach(() => {
  policyCache.clear();
  resetResidencyCache();
});

describe('residency routing gate (part-3/02)', () => {
  it('a none-compliance key is refused a us_only model (503, fail-closed, never dispatched)', async () => {
    const res = await post(NONE_KEY);
    expect(res.statusCode).toBe(503);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('no_route_available');
  });

  it('a us_only-compliance key IS served the us_only model', async () => {
    mockAgent
      .get(OPENAI_ORIGIN)
      .intercept({ path: '/v1/chat/completions', method: 'POST' })
      .reply(200, completion, { headers: { 'content-type': 'application/json' } });
    const res = await post(US_KEY);
    expect(res.statusCode).toBe(200);
  });
});
