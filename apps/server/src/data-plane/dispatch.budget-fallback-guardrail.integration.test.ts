import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { MockAgent } from 'undici';
import { makeTestApp, type TestHarness } from '../../test/helpers/app.js';
import { policyCache } from './pipeline/auth.js';

/**
 * Red-team finding fix (dispatch.ts `denyChainAdvance` / exhaustion branch): BUDGET's on_exceed
 * fallback path (pipeline/budget.ts `serveUnderFallback`) substitutes the WHOLE candidate chain for
 * a fallback alias AFTER route, and deliberately re-runs neither guardrails nor budget. If every
 * candidate in that substituted chain is denied by a model-scoped guardrail, denyChainAdvance
 * skip-not-fails past all of them and nothing is ever dispatched — the old behavior then reported the
 * exhausted loop as `all_providers_failed` (502), a wrong status/code that also skipped the
 * post-route blocked-decision path (no blocked `requests` row, no decision log). The fix: dispatch
 * now tracks whether ANYTHING was actually dispatched this chain-run; if nothing was, and at least
 * one candidate was skipped for a policy reason, it surfaces the FIRST denial via denyPostRoute
 * (terminal 403, the same governance writes route.ts's PASS-2 would have produced) instead of 502.
 * A chain where a candidate WAS dispatched (billed + reconciled) before the rest are denied must
 * still 502 — that's the non-regression case below.
 */

const OPENAI_ORIGIN = 'https://api.openai.com';
const sha = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest();
const KEY = 'mk-bg-p0-key';

let h: TestHarness;
let mockAgent: MockAgent;
const orgId = randomUUID();
const today = new Date().toISOString().slice(0, 10);
const month = new Date().toISOString().slice(0, 7);

function interceptWatched(status = 500): { models: () => string[] } {
  const models: string[] = [];
  mockAgent
    .get(OPENAI_ORIGIN)
    .intercept({ path: '/v1/chat/completions', method: 'POST' })
    .reply((opts) => {
      const b = typeof opts.body === 'string' ? (JSON.parse(opts.body) as { model: string }) : null;
      if (b) models.push(b.model);
      return {
        statusCode: status,
        data: { error: { message: 'boom' } } as never,
        responseOptions: { headers: { 'content-type': 'application/json' } },
      };
    });
  return { models: () => models };
}

const post = (payload: Record<string, unknown>) =>
  h.app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    payload: { model: 'gpt-4.1', messages: [{ role: 'user', content: 'hi' }], ...payload },
  });

/** Seed spend_counters at/over limit for the org day+month counters (triggers BUDGET's E-set). */
async function seedSpend(usd: string): Promise<void> {
  for (const pk of [today, month]) {
    await h.adminSql`INSERT INTO spend_counters (org_id, scope_type, scope_id, period_key, spent_usd)
      VALUES (${orgId}, 'org', ${orgId}, ${pk}, ${usd})
      ON CONFLICT (scope_type, scope_id, period_key) DO UPDATE SET spent_usd = ${usd}`;
  }
}

const seedFallbackBudget = (fallbackAlias: string) =>
  h.adminSql`INSERT INTO budgets (org_id, scope_type, scope_id, period, limit_usd, mode, on_exceed, fallback_alias)
    VALUES (${orgId}, 'org', ${orgId}, 'day', 0.001, 'enforce', 'fallback', ${fallbackAlias})`;

const seedDenyPolicy = (models: string[]) =>
  h.adminSql`INSERT INTO governance_policies (org_id, name, effect, reason, match, enforcement, enabled)
    VALUES (${orgId}, ${'p-' + randomUUID().slice(0, 8)}, 'deny', 'blocked',
            ${JSON.stringify({ models })}::jsonb, 'enforce', true)`;

beforeAll(async () => {
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  h = await makeTestApp({ dispatcher: mockAgent });
  const sql = h.adminSql;
  await sql`INSERT INTO orgs (id, name, slug) VALUES (${orgId}, 'BG', ${'bg-' + orgId.slice(0, 8)})`;
  const sealed = h.encryptor.encrypt('sk-openai-secret');
  await sql`INSERT INTO provider_keys
    (org_id, provider, label, key_prefix, key_ciphertext, key_iv, key_tag, enc_version, status)
    VALUES (${orgId}, 'openai', 'prod', 'sk-open', ${sealed.ciphertext}, ${sealed.iv}, ${sealed.tag}, ${sealed.version}, 'active')`;
  await sql`INSERT INTO virtual_keys (id, org_id, name, key_hash, key_prefix, status)
            VALUES (${randomUUID()}, ${orgId}, 'k', ${sha(KEY)}, 'mk-bg-p0', 'active')`;
  await sql`INSERT INTO model_prices (provider, model, input_usd_per_m, output_usd_per_m, cache_read_usd_per_m, source, synced_at)
            VALUES ('openai', 'gpt-4.1', 2, 8, 0.5, 'test', now()),
                   ('openai', 'gpt-4o', 10, 30, 1, 'test', now()),
                   ('openai', 'gpt-4o-mini', 1, 3, 0.1, 'test', now())`;
  // Requested/head model is bare 'gpt-4.1' — no alias, so PASS-1/PASS-2 at ROUTE never see the
  // fallback candidates below; BUDGET's on_exceed swap is the only thing that puts them on the chain.
  await sql`INSERT INTO model_aliases (org_id, alias, targets) VALUES
    (${orgId}, 'denied-all', '{"default":[{"provider":"openai","model":"gpt-4o-mini"},{"provider":"openai","model":"gpt-4o"}]}'::jsonb),
    (${orgId}, 'denied-tail', '{"default":[{"provider":"openai","model":"gpt-4o"},{"provider":"openai","model":"gpt-4o-mini"}]}'::jsonb)`;
});
afterAll(async () => {
  await h.close();
  await mockAgent.close();
});
beforeEach(async () => {
  await h.adminSql`TRUNCATE requests, request_bodies, request_attempts, spend_counters, budgets, decision_logs, governance_policies, routing_rules`;
  policyCache.clear();
});

describe('budget on_exceed fallback chain fully denied by guardrails (red-team P0 fix)', () => {
  it('every candidate in the substituted chain denied, nothing dispatched → terminal 403 policy denial (not 502)', async () => {
    await seedFallbackBudget('denied-all');
    await seedSpend('0.005'); // over the 0.001 cap → BUDGET substitutes the 'denied-all' alias
    // Denies BOTH fallback candidates; the requested head (gpt-4.1) is untouched, so ROUTE lets the
    // original request through — only the budget-substituted chain is denied.
    await seedDenyPolicy(['gpt-4o-mini', 'gpt-4o']);

    const res = await post({}); // no mock intercept registered — a real dispatch would 502, not 403

    expect(res.statusCode).toBe(403);
    const body = res.json<{ error: { code: string; spillway: { block_reason: string } } }>();
    expect(body.error.code).toBe('rule_deny');
    expect(body.error.spillway.block_reason).toBe('rule_deny');
    expect(res.headers['x-spillway-block-reason']).toBe('rule_deny');
    expect(res.headers['x-spillway-policy-id']).toBeTruthy();

    const blocked = await poll(
      () =>
        h.adminSql`SELECT block_reason FROM requests WHERE org_id = ${orgId} AND status = 'blocked'`,
    );
    expect(blocked[0]?.block_reason).toBe('rule_deny');
    const dl = await poll(
      () => h.adminSql`SELECT effect FROM decision_logs WHERE org_id = ${orgId}`,
    );
    expect(dl[0]?.effect).toBe('deny');

    // Nothing was ever attempted — no per-attempt ledger row for this request.
    const attempts = await h.adminSql`SELECT 1 FROM request_attempts WHERE org_id = ${orgId}`;
    expect(attempts.length).toBe(0);
  });

  it('streaming: same all-denied substitution → terminal 403, never a committed stream', async () => {
    await seedFallbackBudget('denied-all');
    await seedSpend('0.005');
    await seedDenyPolicy(['gpt-4o-mini', 'gpt-4o']);

    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      payload: { model: 'gpt-4.1', stream: true, messages: [{ role: 'user', content: 'hi' }] },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('rule_deny');
    const blocked = await poll(
      () =>
        h.adminSql`SELECT block_reason FROM requests WHERE org_id = ${orgId} AND status = 'blocked'`,
    );
    expect(blocked[0]?.block_reason).toBe('rule_deny');
  });

  it('non-regression: a candidate WAS dispatched before the rest are denied → still 502 all_providers_failed, never a blocked row', async () => {
    await seedFallbackBudget('denied-tail');
    await seedSpend('0.005'); // over cap → substitutes 'denied-tail' = [gpt-4o, gpt-4o-mini]
    // Only the TAIL (gpt-4o-mini) is denied; gpt-4o is dispatchable and will fail retryably.
    await seedDenyPolicy(['gpt-4o-mini']);
    const up = interceptWatched(500); // gpt-4o gets a retryable 500

    const res = await post({});

    expect(res.statusCode).toBe(502);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('all_providers_failed');
    expect(up.models()).toEqual(['gpt-4o']); // gpt-4o-mini was denied — skipped, never dispatched

    // The dispatched attempt reconciled normally (non-final error row) — billed work happened.
    const attempts = await poll(
      () =>
        h.adminSql<{ outcome: string; model: string }[]>`
          SELECT outcome, model FROM request_attempts WHERE org_id = ${orgId} ORDER BY attempt_number`,
    );
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ outcome: 'error', model: 'gpt-4o' });

    // Must NOT take the denyPostRoute path — no blocked requests row for this request.
    const blocked =
      await h.adminSql`SELECT 1 FROM requests WHERE org_id = ${orgId} AND status = 'blocked'`;
    expect(blocked.length).toBe(0);

    // Regression guard (dispatch.ts canAdvance/hasNext must be guardrail-aware): the denied tail is
    // NOT a viable fallback, so the dispatched gpt-4o attempt must reconcile FINAL — landing its
    // parent `requests` row. Before the fix, the guardrail-blind predicate saw gpt-4o-mini as "still
    // one to try", reconciled gpt-4o non-final, and the chain exhausted with a request_attempts row
    // but NO requests row — billed spend invisible to chargeback/reporting despite the counters
    // having already bumped for it.
    const requestRow = await poll(
      () =>
        h.adminSql<{ status: string; error_code: string; model: string; http_status: number }[]>`
          SELECT status, error_code, model, http_status FROM requests WHERE org_id = ${orgId}`,
    );
    expect(requestRow).toHaveLength(1);
    expect(requestRow[0]).toMatchObject({
      status: 'error',
      error_code: 'provider_unavailable',
      model: 'gpt-4o',
      http_status: 500,
    });
  });

  it('streaming non-regression: a candidate WAS dispatched before the rest are denied → still 502 all_providers_failed, and the requests row lands', async () => {
    await seedFallbackBudget('denied-tail');
    await seedSpend('0.005'); // over cap → substitutes 'denied-tail' = [gpt-4o, gpt-4o-mini]
    // Only the TAIL (gpt-4o-mini) is denied; gpt-4o is dispatchable and will fail retryably pre-commit.
    await seedDenyPolicy(['gpt-4o-mini']);
    const up = interceptWatched(500); // gpt-4o gets a retryable pre-2xx 500 (no bytes ever committed)

    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      payload: { model: 'gpt-4.1', stream: true, messages: [{ role: 'user', content: 'hi' }] },
    });

    expect(res.statusCode).toBe(502);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('all_providers_failed');
    expect(up.models()).toEqual(['gpt-4o']); // gpt-4o-mini was denied — skipped, never dispatched

    // The dispatched pre-commit attempt reconciled — billed work happened.
    const attempts = await poll(
      () =>
        h.adminSql<{ outcome: string; model: string }[]>`
          SELECT outcome, model FROM request_attempts WHERE org_id = ${orgId} ORDER BY attempt_number`,
    );
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ outcome: 'error', model: 'gpt-4o' });

    // Must NOT take the denyPostRoute path — no blocked requests row for this request.
    const blocked =
      await h.adminSql`SELECT 1 FROM requests WHERE org_id = ${orgId} AND status = 'blocked'`;
    expect(blocked.length).toBe(0);

    // Same regression guard as the non-streaming case, for runStreamChain's `hasNext`: the denied tail
    // is not a viable fallback, so the pre-commit gpt-4o failure must be tentatively FINAL from the
    // start (runStreamChain sets ctx.isFinalAttempt = !hasNext BEFORE dispatching) — landing the
    // parent `requests` row instead of leaving billed spend stranded in request_attempts only.
    const requestRow = await poll(
      () =>
        h.adminSql<{ status: string; error_code: string; model: string; http_status: number }[]>`
          SELECT status, error_code, model, http_status FROM requests WHERE org_id = ${orgId}`,
    );
    expect(requestRow).toHaveLength(1);
    expect(requestRow[0]).toMatchObject({
      status: 'error',
      error_code: 'provider_unavailable',
      model: 'gpt-4o',
      http_status: 500,
    });
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
