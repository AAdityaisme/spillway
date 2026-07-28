import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { MockAgent } from 'undici';
import { makeTestApp, type TestHarness } from '../../../test/helpers/app.js';
import { getRateLimiter } from '../ratelimit/limiter.js';
import { policyCache } from './auth.js';

/**
 * B2.4 BUDGET exit gate: hard-402 wire response (headers + body) + blocked row/counter, serve-under-
 * fallback substitution, and the parallel slot released on every path. Full pipeline vs real RLS PG.
 */

const OPENAI_ORIGIN = 'https://api.openai.com';
const sha = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest();
const KEY = 'mk-budget-key';
const today = new Date().toISOString().slice(0, 10);
const month = new Date().toISOString().slice(0, 7);

const completion = {
  id: 'chatcmpl-b',
  object: 'chat.completion',
  created: 1_700_000_000,
  model: 'gpt-4o-mini',
  choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
};

let h: TestHarness;
let mockAgent: MockAgent;
const orgId = randomUUID();
let vkId: string;

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

const post = (payload: Record<string, unknown>) =>
  h.app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    payload: { model: 'gpt-4.1', messages: [{ role: 'user', content: 'hi' }], ...payload },
  });

/** Seed spend_counters at/over limit for the org day+month counters. */
async function seedSpend(usd: string): Promise<void> {
  for (const pk of [today, month]) {
    await h.adminSql`INSERT INTO spend_counters (org_id, scope_type, scope_id, period_key, spent_usd)
      VALUES (${orgId}, 'org', ${orgId}, ${pk}, ${usd})
      ON CONFLICT (scope_type, scope_id, period_key) DO UPDATE SET spent_usd = ${usd}`;
  }
}

beforeAll(async () => {
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  h = await makeTestApp({ dispatcher: mockAgent });
  const sql = h.adminSql;
  await sql`INSERT INTO orgs (id, name, slug) VALUES (${orgId}, 'B', ${'b-' + orgId.slice(0, 8)})`;
  const sealed = h.encryptor.encrypt('sk-openai-secret');
  await sql`INSERT INTO provider_keys
    (org_id, provider, label, key_prefix, key_ciphertext, key_iv, key_tag, enc_version, status)
    VALUES (${orgId}, 'openai', 'prod', 'sk-open', ${sealed.ciphertext}, ${sealed.iv}, ${sealed.tag}, ${sealed.version}, 'active')`;
  vkId = randomUUID();
  await sql`INSERT INTO virtual_keys (id, org_id, name, key_hash, key_prefix, status)
            VALUES (${vkId}, ${orgId}, 'k', ${sha(KEY)}, 'mk-budget', 'active')`;
  await sql`INSERT INTO model_aliases (org_id, alias, targets)
            VALUES (${orgId}, 'cheap',
              '{"default":[{"provider":"openai","model":"gpt-4o-mini"}],"context_window":[{"provider":"openai","model":"gpt-4.1"}]}'::jsonb)`;
  // A PRIMARY alias so a request can resolve VIA an alias — needed to prove fallback_from records the
  // SOURCE alias, not the destination (expanded-audit M5).
  await sql`INSERT INTO model_aliases (org_id, alias, targets)
            VALUES (${orgId}, 'primary',
              '{"default":[{"provider":"openai","model":"gpt-4.1"}]}'::jsonb)`;
  // An EMBEDDINGS-only fallback alias (priced, so it would dispatch if the gate were bypassed) — proves
  // the budget-fallback path re-applies the capability hard-gate (red-team part-3 #1).
  await sql`INSERT INTO model_aliases (org_id, alias, targets)
            VALUES (${orgId}, 'cheap-embed',
              '{"default":[{"provider":"openai","model":"text-embedding-3-small"}]}'::jsonb)`;
  await sql`INSERT INTO model_prices
    (provider, model, input_usd_per_m, output_usd_per_m, cache_read_usd_per_m, source, synced_at)
    VALUES ('openai', 'gpt-4.1', 2, 8, 0.5, 'test', now()),
           ('openai', 'gpt-4o-mini', 0.15, 0.6, 0.05, 'test', now()),
           ('openai', 'text-embedding-3-small', 0.02, 0, 0, 'test', now())`;
});

afterAll(async () => {
  await h.close();
  await mockAgent.close();
});

beforeEach(async () => {
  await h.adminSql`TRUNCATE requests, request_bodies, spend_counters, budgets, decision_logs, routing_rules`;
  policyCache.clear(); // budgets travel in the cached bundle; bust it so each test's budget is seen
});

describe('BUDGET stage (17 §2, B2.4)', () => {
  it('hard-402s at/over an enforce+block budget with wire headers + blocked row/counter', async () => {
    await h.adminSql`INSERT INTO budgets (org_id, scope_type, scope_id, period, limit_usd, mode, on_exceed)
      VALUES (${orgId}, 'org', ${orgId}, 'day', 0.001, 'enforce', 'block')`;
    await seedSpend('0.001'); // spent == limit → block (>=)

    const res = await post({});
    expect(res.statusCode).toBe(402);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('budget_exceeded');
    expect(res.headers['x-spillway-block-scope-type']).toBe('org');
    expect(res.headers['x-spillway-block-limit-usd']).toBe('0.001000');

    // fire-and-forget blocked row + blocked_count bump (poll — written post-throw)
    const blocked = await pollRows(
      () => h.adminSql`SELECT status FROM requests WHERE org_id = ${orgId} AND status = 'blocked'`,
    );
    expect(blocked.length).toBe(1);
    const ctr = await h.adminSql<{ blocked_count: number }[]>`
      SELECT blocked_count FROM spend_counters WHERE org_id = ${orgId} AND scope_type = 'org' AND period_key = ${today}`;
    expect(Number(ctr[0]!.blocked_count)).toBeGreaterThanOrEqual(1);

    expect(getRateLimiter().parallelInFlight(`par:${vkId}`)).toBe(0); // slot released on the 402 path

    // B8.1: the block writes a budget_block decision log (fire-and-forget)
    const dl = await pollRows(
      () =>
        h.adminSql`SELECT effect FROM decision_logs WHERE org_id = ${orgId} AND effect = 'budget_block'`,
    );
    expect(dl.length).toBe(1);
  });

  it('B8.1: a routing rewrite writes a rewrite decision log', async () => {
    await h.adminSql`INSERT INTO budgets (org_id, scope_type, scope_id, period, limit_usd, mode, on_exceed)
      VALUES (${orgId}, 'org', ${orgId}, 'day', 100, 'enforce', 'block')`;
    await h.adminSql`INSERT INTO routing_rules (org_id, priority, match, action, enabled)
      VALUES (${orgId}, 10, '{"models":["gpt-4.1"]}'::jsonb,
              '{"type":"rewrite_model","to":{"provider":"openai","model":"gpt-4o-mini"}}'::jsonb, true)`;
    const cap = interceptCapture();
    const res = await post({ model: 'gpt-4.1' });
    expect(res.statusCode).toBe(200);
    expect(cap.body()?.model).toBe('gpt-4o-mini'); // rewritten
    const dl = await pollRows(
      () =>
        h.adminSql`SELECT routing_rule_id FROM decision_logs WHERE org_id = ${orgId} AND effect = 'rewrite'`,
    );
    expect(dl.length).toBe(1);
  });

  it('serves under fallback (substitutes the alias chain) instead of 402', async () => {
    await h.adminSql`INSERT INTO budgets (org_id, scope_type, scope_id, period, limit_usd, mode, on_exceed, fallback_alias)
      VALUES (${orgId}, 'org', ${orgId}, 'day', 0.001, 'enforce', 'fallback', 'cheap')`;
    await seedSpend('0.005'); // over limit → fallback

    const cap = interceptCapture();
    const res = await post({ model: 'gpt-4.1' });
    expect(res.statusCode).toBe(200);
    expect(cap.body()?.model).toBe('gpt-4o-mini'); // substituted to the 'cheap' alias target
    // slot released in the route finally — on the success path that runs just after inject resolves.
    await pollUntil(() => getRateLimiter().parallelInFlight(`par:${vkId}`) === 0);
    expect(getRateLimiter().parallelInFlight(`par:${vkId}`)).toBe(0);
  });

  it('budget fallback does NOT bypass the capability hard-gate — an incapable substitute is refused, not served (red-team part-3 #1)', async () => {
    // enforce+fallback to an EMBEDDINGS-only alias. A tools request routed via the (tools-capable)
    // 'primary' alias exhausts the budget → the substitute resolves to an embeddings model that cannot
    // do tools. Before the fix, applyBudgetFallback skipped the Part III capability gate and would have
    // SERVED it (silently dropping tools → wrong-shaped answer, 200). Now the admissible filter empties
    // the substituted chain → hard 402, never an incapable dispatch. The alias IS priced, so a 402 here
    // isolates the capability gate (not a fail-closed pricing miss).
    await h.adminSql`INSERT INTO budgets (org_id, scope_type, scope_id, period, limit_usd, mode, on_exceed, fallback_alias)
      VALUES (${orgId}, 'org', ${orgId}, 'day', 0.001, 'enforce', 'fallback', 'cheap-embed')`;
    await seedSpend('0.005'); // over limit → fallback

    const res = await post({
      model: 'primary',
      tools: [{ type: 'function', function: { name: 'get_weather' } }],
    });
    expect(res.statusCode).toBe(402); // refused — the embeddings substitute is filtered, so no dispatch
    expect(res.json<{ error: { code: string } }>().error.code).toBe('budget_exceeded');
  });

  it('keeps typed fallbacks aligned with the budget-substituted alias', async () => {
    await h.adminSql`INSERT INTO budgets (org_id, scope_type, scope_id, period, limit_usd, mode, on_exceed, fallback_alias)
      VALUES (${orgId}, 'org', ${orgId}, 'day', 0.001, 'enforce', 'fallback', 'cheap')`;
    await seedSpend('0.005');

    const models: string[] = [];
    for (const response of [
      { status: 400, data: { error: { code: 'context_length_exceeded', message: 'too long' } } },
      { status: 200, data: { ...completion, model: 'gpt-4.1' } },
    ]) {
      mockAgent
        .get(OPENAI_ORIGIN)
        .intercept({ path: '/v1/chat/completions', method: 'POST' })
        .reply((opts) => {
          const body =
            typeof opts.body === 'string' ? (JSON.parse(opts.body) as { model: string }) : null;
          if (body) models.push(body.model);
          return {
            statusCode: response.status,
            data: response.data,
            responseOptions: { headers: { 'content-type': 'application/json' } },
          };
        });
    }

    const res = await post({ model: 'gpt-4.1' });
    expect(res.statusCode).toBe(200);
    expect(models).toEqual(['gpt-4o-mini', 'gpt-4.1']);
  });

  it('M5: fallback_from records the SOURCE (primary) alias, not the destination alias', async () => {
    // Route via primary alias → hit an enforce+fallback org budget → substitute to 'cheap'. The
    // provenance marker must record from_alias='primary' (where we fell FROM), not 'cheap' (where we
    // landed). The pre-fix read ctx.routeResult.resolvedViaAlias AFTER overwriting it (expanded-audit M5).
    await h.adminSql`INSERT INTO budgets (org_id, scope_type, scope_id, period, limit_usd, mode, on_exceed, fallback_alias)
      VALUES (${orgId}, 'org', ${orgId}, 'day', 0.001, 'enforce', 'fallback', 'cheap')`;
    await seedSpend('0.005'); // over limit → fallback
    interceptCapture();
    const res = await post({ model: 'primary' });
    expect(res.statusCode).toBe(200);
    const rows = await pollRows(
      () => h.adminSql<{ fallback_from: Array<{ from_alias: string; reason: string }> }[]>`
        SELECT fallback_from FROM requests
        WHERE org_id = ${orgId} AND status = 'ok' AND fallback_from IS NOT NULL
        ORDER BY created_at DESC LIMIT 1`,
    );
    const marker = rows[0]?.fallback_from.find((m) => m.reason === 'budget_fallback');
    expect(marker?.from_alias).toBe('primary'); // NOT 'cheap'
  });

  it('reserve-ahead (H2): blocks when the request hold would cross the cap, though spent alone is under', async () => {
    // limit 1.0; spent 0.99 → 0.01 headroom, LESS than this request's ~0.033 estimate (gpt-4.1, up to
    // 4096 output tokens @ $8/M). The atomic hold crosses the cap → 402, no upstream call. (The old
    // post-hoc compare would have served this and overspent.) No intercept — it must not dispatch.
    await h.adminSql`INSERT INTO budgets (org_id, scope_type, scope_id, period, limit_usd, mode, on_exceed)
      VALUES (${orgId}, 'org', ${orgId}, 'day', 1.0, 'enforce', 'block')`;
    await seedSpend('0.99');
    const res = await post({});
    expect(res.statusCode).toBe(402);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('budget_exceeded');
    // the hold was released on the block path (not left dangling)
    const [ctr] = await h.adminSql<{ reserved_usd: string }[]>`
      SELECT reserved_usd FROM spend_counters WHERE org_id = ${orgId} AND scope_type = 'org' AND period_key = ${today}`;
    expect(Number(ctr!.reserved_usd)).toBe(0);
  });

  it('fails CLOSED (402) when the fallback alias is unresolvable — never serves past budget', async () => {
    // on_exceed=fallback but the alias does not exist → the chain can't resolve → must 402, NOT
    // fall open and serve the original model unbudgeted (red-team budget-bypass invariant, 17 §2).
    await h.adminSql`INSERT INTO budgets (org_id, scope_type, scope_id, period, limit_usd, mode, on_exceed, fallback_alias)
      VALUES (${orgId}, 'org', ${orgId}, 'day', 0.001, 'enforce', 'fallback', 'ghost')`;
    await seedSpend('0.005'); // over limit
    const res = await post({});
    expect(res.statusCode).toBe(402);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('budget_exceeded');
    expect(getRateLimiter().parallelInFlight(`par:${vkId}`)).toBe(0);
  });

  it('proceeds normally when under budget', async () => {
    await h.adminSql`INSERT INTO budgets (org_id, scope_type, scope_id, period, limit_usd, mode, on_exceed)
      VALUES (${orgId}, 'org', ${orgId}, 'day', 100, 'enforce', 'block')`;
    const cap = interceptCapture();
    const res = await post({});
    expect(res.statusCode).toBe(200);
    expect(cap.body()?.model).toBe('gpt-4.1');
  });

  it('atomic reservation: two concurrent requests cannot both pass a hard cap (H2)', async () => {
    // limit 0.05 fits ONE request's ~0.033 estimate but not two. Pre-reservation both would read
    // spent=0 and pass; with the hold, whichever reserves second sees spent+reserved >= limit → 402.
    // This is the race the old read-once-compare lost.
    await h.adminSql`INSERT INTO budgets (org_id, scope_type, scope_id, period, limit_usd, mode, on_exceed)
      VALUES (${orgId}, 'org', ${orgId}, 'day', 0.05, 'enforce', 'block')`;
    mockAgent
      .get(OPENAI_ORIGIN)
      .intercept({ path: '/v1/chat/completions', method: 'POST' })
      .reply(() => ({
        statusCode: 200,
        data: completion,
        responseOptions: { headers: { 'content-type': 'application/json' } },
      }))
      .persist();
    const [a, b] = await Promise.all([post({}), post({})]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 402]); // exactly one served, one blocked
  });

  // Every counter-row writer (reserve, release, blocked-bump, reconcile) must take the shared
  // spend_counters tuples in ONE canonical order (SCOPE_RANK scope-major, [month, day]). The blocked
  // path used per-row statements and release used an OR'd UPDATE (plan-order locking) — under a
  // concurrent blocked burst those deadlocked (40P01), reserveBudget surfaced it, and clients got 502
  // "upstream_error" for requests that never left the building (stress budget-race, 2026-07-19).
  it('30-way blocked burst: every client 402s (never 502) and no blocked_count bump is lost', async () => {
    await h.adminSql`INSERT INTO budgets (org_id, scope_type, scope_id, period, limit_usd, mode, on_exceed)
      VALUES (${orgId}, 'org', ${orgId}, 'day', 0.001, 'enforce', 'block')`;
    await seedSpend('0.001'); // already at limit → all 30 block

    const N = 30;
    const results = await Promise.all(Array.from({ length: N }, () => post({})));
    const statuses = results.map((r) => r.statusCode);
    expect(statuses.every((s) => s === 402)).toBe(true);

    // fire-and-forget writers: poll until every bump lands — a lost one is a governance under-report
    const ctr = await pollRows(async () => {
      const rows = await h.adminSql<{ blocked_count: number }[]>`
        SELECT blocked_count FROM spend_counters
         WHERE org_id = ${orgId} AND scope_type = 'org' AND period_key = ${today} AND blocked_count >= ${N}`;
      return rows;
    }, 8000);
    expect(Number(ctr[0]?.blocked_count)).toBe(N);
  }, 30_000);
});

async function pollRows<T>(fn: () => Promise<T[]>, ms = 3000): Promise<T[]> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v.length > 0 || Date.now() - start > ms) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function pollUntil(pred: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!pred() && Date.now() - start < ms) await new Promise((r) => setTimeout(r, 15));
}
