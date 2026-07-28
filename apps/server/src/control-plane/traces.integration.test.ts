import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { makeTestApp, type TestHarness } from '../../test/helpers/app.js';

/**
 * B8.4 routing-trace read API (Part II §20 §6): assembles a request's decisions + attempts on
 * retrieval. Governance-tier ('audit_api'), admin+. 404 for an unknown/cross-org request.
 */
describe('routing trace (B8.4)', () => {
  let h: TestHarness;
  const orgId = randomUUID();
  const reqId = randomUUID();

  async function seed(plan = 'governance'): Promise<{ hdr: Record<string, string> }> {
    const tok = await h.token('owner');
    await h.adminSql`INSERT INTO orgs (id, name, slug) VALUES (${orgId}, 'A', ${'a-' + orgId.slice(0, 8)})`;
    await h.adminSql`INSERT INTO users (id, email) VALUES ('owner', 'o@t.dev') ON CONFLICT (id) DO NOTHING`;
    await h.adminSql`INSERT INTO org_members (org_id, user_id, role) VALUES (${orgId}, 'owner', 'owner')`;
    await h.adminSql`UPDATE orgs SET plan = ${plan} WHERE id = ${orgId}`;
    // a request with a rewrite decision + two attempts (5xx → advance → ok)
    await h.adminSql`INSERT INTO requests (id, org_id, requested_model, endpoint, status, cost_usd, config_snapshot_hash)
      VALUES (${reqId}, ${orgId}, 'gpt-4o', 'chat_completions', 'ok', '0.010000', 'snap-1')`;
    await h.adminSql`INSERT INTO decision_logs
      (decision_id, org_id, request_id, effect, enforcement, would_have, evaluated_policy_ids,
       matched_policy_ids, routing_rule_id, config_snapshot_hash, input_snapshot, cel_error)
      VALUES (${randomUUID()}, ${orgId}, ${reqId}, 'rewrite', 'enforce', false, '{}', '{}',
              ${randomUUID()}, 'snap-1', '{}'::jsonb, false)`;
    await h.adminSql`INSERT INTO request_attempts (request_id, attempt_number, org_id, provider, model, outcome, cost_usd)
      VALUES (${reqId}, 0, ${orgId}, 'openai', 'gpt-4o', 'error', null),
             (${reqId}, 1, ${orgId}, 'openai', 'gpt-4o-mini', 'ok', '0.010000')`;
    return { hdr: { authorization: `Bearer ${tok}`, 'x-spillway-org': orgId } };
  }

  beforeEach(async () => {
    h = await makeTestApp();
  });
  afterEach(async () => {
    await h.close();
  });

  it('assembles decisions + attempts for a request', async () => {
    const { hdr } = await seed();
    const res = await h.app.inject({ method: 'GET', url: `/api/traces/${reqId}`, headers: hdr });
    expect(res.statusCode).toBe(200);
    const { trace } = res.json<{
      trace: {
        status: string;
        decisions: { effect: string }[];
        attempts: { attemptNumber: number; outcome: string }[];
      };
    }>();
    expect(trace.status).toBe('ok');
    expect(trace.decisions.map((d) => d.effect)).toEqual(['rewrite']);
    expect(trace.attempts).toHaveLength(2);
    expect(trace.attempts.map((a) => a.outcome)).toEqual(['error', 'ok']); // ordered by attempt_number
  });

  it('404 for an unknown request', async () => {
    const { hdr } = await seed();
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/traces/${randomUUID()}`,
      headers: hdr,
    });
    expect(res.statusCode).toBe(404);
  });

  it('free plan → 402 tier_required', async () => {
    const { hdr } = await seed('free');
    const res = await h.app.inject({ method: 'GET', url: `/api/traces/${reqId}`, headers: hdr });
    expect(res.statusCode).toBe(402);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('tier_required');
  });

  // audit L39: a non-UUID id must be a declared 400 from the param schema, never a bubbled DB cast error.
  it('non-UUID id → 400 before any DB round-trip (L39)', async () => {
    const { hdr } = await seed();
    const res = await h.app.inject({ method: 'GET', url: '/api/traces/not-a-uuid', headers: hdr });
    expect(res.statusCode).toBe(400);
  });

  // audit L40: org B's admin must NOT be able to read org A's trace — RLS scopes assembleTrace to the
  // caller's org, so a cross-org read returns 404 (empty), not org A's routing/cost/decision data.
  it('cross-org read is 404, not a leak (L40)', async () => {
    await seed(); // seeds org A + its request reqId
    const orgB = randomUUID();
    const tokB = await h.token('ownerB');
    await h.adminSql`INSERT INTO orgs (id, name, slug, plan) VALUES (${orgB}, 'B', ${'b-' + orgB.slice(0, 8)}, 'governance')`;
    await h.adminSql`INSERT INTO users (id, email) VALUES ('ownerB', 'b@t.dev') ON CONFLICT (id) DO NOTHING`;
    await h.adminSql`INSERT INTO org_members (org_id, user_id, role) VALUES (${orgB}, 'ownerB', 'owner')`;
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/traces/${reqId}`, // org A's request id
      headers: { authorization: `Bearer ${tokB}`, 'x-spillway-org': orgB },
    });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain('snap-1'); // no org A config-hash / trace payload leaked
  });
});
