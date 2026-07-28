import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { MockAgent } from 'undici';
import { makeTestApp, type TestHarness } from '../test/helpers/app.js';

/**
 * B9 end-to-end happy path — the whole M3 governance vertical wired together through HTTP:
 * provision an org + provider key + virtual key + budget + alias + guardrail policy via the CONTROL
 * plane, then drive a real chat request through the DATA plane (alias resolved, guardrails passed,
 * budget checked, dispatched, reconciled), and confirm the spend surfaces in the chargeback report and
 * the routing trace. One test that proves control plane + data plane + reporting agree.
 */
describe('M3 governance E2E (B9)', () => {
  let h: TestHarness;
  let mockAgent: MockAgent;
  const OPENAI = 'https://api.openai.com';

  beforeEach(async () => {
    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    h = await makeTestApp({ dispatcher: mockAgent });
  });
  afterEach(async () => {
    await h.close();
    await mockAgent.close();
  });

  it('provision → serve → reconcile → chargeback + trace all agree', async () => {
    const tok = await h.token('owner');
    const admin = (url: string, payload?: unknown, org?: string) =>
      h.app.inject({
        method: payload ? 'POST' : 'GET',
        url,
        headers: {
          authorization: `Bearer ${tok}`,
          ...(org ? { 'x-spillway-org': org } : {}),
        },
        ...(payload ? { payload: payload as object } : {}),
      });

    // 1. org (governance plan for the guardrail + budget features)
    const orgId = (
      await admin('/api/orgs', { name: 'Acme', slug: 'acme-' + randomUUID().slice(0, 8) })
    ).json<{ org: { id: string } }>().org.id;
    await h.adminSql`UPDATE orgs SET plan = 'governance' WHERE id = ${orgId}`;
    // model price for reconcile costing
    await h.adminSql`INSERT INTO model_prices (provider, model, input_usd_per_m, output_usd_per_m, cache_read_usd_per_m, source, synced_at)
      VALUES ('openai', 'gpt-4o-mini', 1, 3, 0.1, 'litellm', now())`;

    // 2. provider key + virtual key (grab the revealed key once)
    const pk = await admin(
      '/api/provider-keys',
      { provider: 'openai', label: 'prod', apiKey: 'sk-openai-secret' },
      orgId,
    );
    expect(pk.statusCode).toBe(201);
    const vk = await admin('/api/virtual-keys', { name: 'app-key' }, orgId);
    expect(vk.statusCode).toBe(201);
    const apiKey = vk.json<{ virtualKey: { key: string } }>().virtualKey.key;

    // 3. budget + alias + a (non-matching) guardrail policy
    expect(
      (
        await admin(
          '/api/budgets',
          { scopeType: 'org', scopeId: orgId, period: 'day', limitUsd: '100' },
          orgId,
        )
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await admin(
          '/api/aliases',
          { alias: 'fast', targets: [{ provider: 'openai', model: 'gpt-4o-mini' }] },
          orgId,
        )
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await admin(
          '/api/policies',
          { name: 'block-5.5', effect: 'deny', reason: 'blocked', match: { models: ['gpt-5.5'] } },
          orgId,
        )
      ).statusCode,
    ).toBe(201);

    // 4. drive a real chat request through the gateway (alias 'fast' → gpt-4o-mini)
    mockAgent
      .get(OPENAI)
      .intercept({ path: '/v1/chat/completions', method: 'POST' })
      .reply(
        200,
        {
          id: 'chatcmpl-e2e',
          object: 'chat.completion',
          model: 'gpt-4o-mini',
          choices: [
            { index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 },
        },
        { headers: { 'content-type': 'application/json' } },
      );
    const chat = await h.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      payload: { model: 'fast', messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(chat.statusCode).toBe(200);

    // 5a. reconciled: a requests row exists (served gpt-4o-mini), committed before the ack
    const reqRow = await h.adminSql<{ id: string; status: string; cost_usd: string }[]>`
      SELECT id, status, cost_usd FROM requests WHERE org_id = ${orgId} AND status = 'ok'`;
    expect(reqRow).toHaveLength(1);
    expect(Number(reqRow[0]!.cost_usd)).toBeCloseTo(0.0025, 6); // 1000*1/1M + 500*3/1M

    // 5b. chargeback report reflects the spend + reconciles
    const cb = await admin('/api/reports/chargeback?group_by=model', undefined, orgId);
    expect(cb.statusCode).toBe(200);
    const stmt = cb.json<{
      statement: { totalCostUsd: string; reconciliation: { consistent: boolean } };
    }>().statement;
    expect(stmt.totalCostUsd).toBe('0.002500');
    expect(stmt.reconciliation.consistent).toBe(true);

    // 5c. the routing trace assembles for the served request
    const trace = await admin(`/api/traces/${reqRow[0]!.id}`, undefined, orgId);
    expect(trace.statusCode).toBe(200);
    const t = trace.json<{ trace: { status: string; attempts: unknown[] } }>().trace;
    expect(t.status).toBe('ok');
    expect(t.attempts.length).toBeGreaterThanOrEqual(1);
  });
});
