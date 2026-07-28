import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { MockAgent } from 'undici';
import { makeTestApp, type TestHarness } from '../../../test/helpers/app.js';
import { policyCache } from '../pipeline/auth.js';

/**
 * B4 guardrail exit gate (16 §3). The load-bearing one is the SHADOWING-BYPASS regression (ADR-034):
 * a `deny` guardrail + a `rewrite` routing rule on the same model → 403, NOT rewritten-and-served.
 * Plus deny 403 wire body/headers + blocked row + decision log; flag → 2xx + header; shadow → allow +
 * would_have decision log. Full pipeline vs real RLS Postgres + a mock upstream.
 */

const OPENAI_ORIGIN = 'https://api.openai.com';
const sha = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest();
const KEY = 'mk-guard-key';

const completion = {
  id: 'chatcmpl-g',
  object: 'chat.completion',
  created: 1_700_000_000,
  model: 'gpt-4o',
  choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
};

let h: TestHarness;
let mockAgent: MockAgent;
const orgId = randomUUID();

function interceptOnce(): void {
  mockAgent
    .get(OPENAI_ORIGIN)
    .intercept({ path: '/v1/chat/completions', method: 'POST' })
    .reply(200, completion as never, { headers: { 'content-type': 'application/json' } });
}
const post = (model: string) =>
  h.app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    payload: { model, messages: [{ role: 'user', content: 'hi' }] },
  });

const seedPolicy = (o: {
  effect: string;
  models: string[];
  enforcement?: string;
  reason?: string;
}) =>
  h.adminSql`INSERT INTO governance_policies (org_id, name, effect, reason, match, enforcement, enabled)
    VALUES (${orgId}, ${'p-' + randomUUID().slice(0, 8)}, ${o.effect}, ${o.reason ?? 'blocked'},
            ${JSON.stringify({ models: o.models })}::jsonb, ${o.enforcement ?? 'enforce'}, true)`;

const TAGGED_KEY = 'mk-guard-tagged';
// wildcard-match policy gated by a CEL condition (loadBundle recompiles from condition_cel; program
// just satisfies the cel↔program CHECK).
const seedCelPolicy = (o: { effect: string; conditionCel: string; enforcement?: string }) =>
  h.adminSql`INSERT INTO governance_policies
    (org_id, name, effect, reason, match, condition_cel, condition_program, condition_cost, enforcement, enabled)
    VALUES (${orgId}, ${'pc-' + randomUUID().slice(0, 8)}, ${o.effect}, 'blocked', '{}'::jsonb,
            ${o.conditionCel}, ${Buffer.from(o.conditionCel)}, 1, ${o.enforcement ?? 'enforce'}, true)`;

beforeAll(async () => {
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  h = await makeTestApp({ dispatcher: mockAgent });
  const sql = h.adminSql;
  await sql`INSERT INTO orgs (id, name, slug) VALUES (${orgId}, 'G', ${'g-' + orgId.slice(0, 8)})`;
  const sealed = h.encryptor.encrypt('sk-openai-secret');
  await sql`INSERT INTO provider_keys
    (org_id, provider, label, key_prefix, key_ciphertext, key_iv, key_tag, enc_version, status)
    VALUES (${orgId}, 'openai', 'prod', 'sk-open', ${sealed.ciphertext}, ${sealed.iv}, ${sealed.tag}, ${sealed.version}, 'active')`;
  await sql`INSERT INTO virtual_keys (id, org_id, name, key_hash, key_prefix, status)
            VALUES (${randomUUID()}, ${orgId}, 'k', ${sha(KEY)}, 'mk-guard', 'active')`;
  await sql`INSERT INTO virtual_keys (id, org_id, name, key_hash, key_prefix, status, metadata)
            VALUES (${randomUUID()}, ${orgId}, 'tagged', ${sha(TAGGED_KEY)}, 'mk-tag', 'active', '{"sandbox":"1"}'::jsonb)`;
  await sql`INSERT INTO model_prices (provider, model, input_usd_per_m, output_usd_per_m, cache_read_usd_per_m, source, synced_at)
            VALUES ('openai', 'gpt-4o', 2.5, 10, 0.25, 'litellm', now())`;
});
afterAll(async () => {
  await h.close();
  await mockAgent.close();
});
beforeEach(async () => {
  await h.adminSql`TRUNCATE requests, request_bodies, request_attempts, spend_counters, decision_logs, governance_policies, routing_rules`;
  policyCache.clear(); // policies travel in the cached bundle
});

describe('guardrail deny-overrides (16 §3, B4)', () => {
  it('SHADOWING-BYPASS regression: a deny is NOT shadowed by a rewrite rule (ADR-034) → 403', async () => {
    await seedPolicy({ effect: 'deny', models: ['gpt-4o'], reason: 'model_blocked' });
    // a rewrite rule that WOULD send gpt-4o → gpt-4o-mini if routing shadowed the deny.
    await h.adminSql`INSERT INTO routing_rules (org_id, priority, match, action, enabled)
      VALUES (${orgId}, 10, '{"models":["gpt-4o"]}'::jsonb,
              '{"type":"rewrite_model","to":{"provider":"openai","model":"gpt-4o-mini"}}'::jsonb, true)`;

    const res = await post('gpt-4o');
    expect(res.statusCode).toBe(403); // deny wins — never rewritten + served
    const body = res.json<{ error: { code: string; spillway: { block_reason: string } } }>();
    expect(body.error.code).toBe('rule_deny');
    expect(body.error.spillway.block_reason).toBe('rule_deny');
    expect(res.headers['x-spillway-block-reason']).toBe('rule_deny');
    expect(res.headers['x-spillway-policy-id']).toBeTruthy();

    // blocked requests row + a decision log written (fire-and-forget → poll)
    const blocked = await poll(
      () =>
        h.adminSql`SELECT block_reason FROM requests WHERE org_id = ${orgId} AND status = 'blocked'`,
    );
    expect(blocked[0]?.block_reason).toBe('rule_deny');
    const dl = await poll(
      () => h.adminSql`SELECT effect FROM decision_logs WHERE org_id = ${orgId}`,
    );
    expect(dl[0]?.effect).toBe('deny');
  });

  it('flag effect → 2xx + x-spillway-guardrail-flags header', async () => {
    await seedPolicy({ effect: 'flag', models: ['gpt-4o'], reason: 'watched' });
    interceptOnce();
    const res = await post('gpt-4o');
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-spillway-guardrail-flags']).toBeTruthy();
  });

  it('shadow deny → 2xx (does not block) + a would_have decision log', async () => {
    await seedPolicy({ effect: 'deny', models: ['gpt-4o'], enforcement: 'shadow' });
    interceptOnce();
    const res = await post('gpt-4o');
    expect(res.statusCode).toBe(200); // shadow never acts
    const dl = await poll(
      () =>
        h.adminSql`SELECT effect, would_have FROM decision_logs WHERE org_id = ${orgId} AND effect = 'allow_shadow'`,
    );
    expect(dl[0]?.would_have).toBe(true);
  });

  it('no policy matches → normal 200', async () => {
    await seedPolicy({ effect: 'deny', models: ['some-other-model'] });
    interceptOnce();
    const res = await post('gpt-4o');
    expect(res.statusCode).toBe(200);
  });
});

describe('CEL attributes + fail-closed logging (red-team B2/B4)', () => {
  const taggedPost = (model: string) =>
    h.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TAGGED_KEY}` },
      payload: { model, messages: [{ role: 'user', content: 'hi' }] },
    });

  it('a deny on identity.key_tags FIRES for a tagged key (no longer silently bypassed)', async () => {
    await seedCelPolicy({ effect: 'deny', conditionCel: '"sandbox" in identity.key_tags' });
    const res = await taggedPost('gpt-4o');
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('rule_deny');
  });

  it('the SAME key_tags deny does NOT fire for an untagged key', async () => {
    await seedCelPolicy({ effect: 'deny', conditionCel: '"sandbox" in identity.key_tags' });
    interceptOnce();
    const res = await post('gpt-4o'); // untagged KEY → key_tags [] → condition false → served
    expect(res.statusCode).toBe(200);
  });

  it('a CEL runtime error fails CLOSED (enforce deny) and logs cel_error=true', async () => {
    // request.temperature is absent → unguarded read raises → enforce fail-closed → deny.
    await seedCelPolicy({ effect: 'deny', conditionCel: 'request.temperature > 0.5' });
    const res = await post('gpt-4o');
    expect(res.statusCode).toBe(403);
    const rows = await poll<{ cel_error: boolean }>(
      () =>
        h.adminSql`SELECT cel_error FROM decision_logs WHERE org_id = ${orgId} AND effect = 'deny'`,
    );
    expect(rows[0]?.cel_error).toBe(true);
  });
});

async function poll<T>(fn: () => Promise<T[]>, ms = 3000): Promise<T[]> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v.length > 0 || Date.now() - start > ms) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
}
