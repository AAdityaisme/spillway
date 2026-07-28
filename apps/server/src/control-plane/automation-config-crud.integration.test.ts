import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { makeTestApp, type TestHarness } from '../../test/helpers/app.js';

/**
 * B7.2d config CRUD: automation-rules (threshold-isolation validated), approval-policies, approver-
 * delegations. Governance-tier; admin+. Covers the load-bearing gates: bad threshold condition → 422,
 * a borrowed (non-member) delegation user → 400, and the tier gate.
 */
describe('automation + approval config CRUD (B7.2d)', () => {
  let h: TestHarness;
  beforeEach(async () => {
    h = await makeTestApp();
  });
  afterEach(async () => {
    await h.close();
  });

  async function seed(plan = 'governance'): Promise<{ hdr: Record<string, string> }> {
    const tok = await h.token('owner');
    const org = (
      await h.app.inject({
        method: 'POST',
        url: '/api/orgs',
        headers: { authorization: `Bearer ${tok}` },
        payload: { name: 'A', slug: 'org-' + randomUUID().slice(0, 8) },
      })
    ).json<{ org: { id: string } }>().org.id;
    await h.adminSql`UPDATE orgs SET plan = ${plan} WHERE id = ${org}`;
    return { hdr: { authorization: `Bearer ${tok}`, 'x-spillway-org': org } };
  }
  const post = (hdr: Record<string, string>, url: string, payload: unknown) =>
    h.app.inject({ method: 'POST', url, headers: hdr, payload: payload as object });

  it('automation-rule: create ok; a mixed threshold condition → 422', async () => {
    const { hdr } = await seed();
    const ok = await post(hdr, '/api/automation-rules', {
      name: 'pause-on-spike',
      priority: 10,
      triggerType: 'alert_fired',
      condition: { event_kind: 'anomaly', min_ratio: 3 },
      action: { type: 'pause_key' },
    });
    expect(ok.statusCode).toBe(201);
    // threshold field (min_ratio) mixed with an unrelated structured field → not isolated → 422
    const bad = await post(hdr, '/api/automation-rules', {
      name: 'bad',
      priority: 20,
      triggerType: 'alert_fired',
      condition: { min_ratio: 3, model: 'gpt-4o' },
      action: { type: 'pause_key' },
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json<{ error: { code: string } }>().error.code).toBe(
      'threshold_condition_not_isolated',
    );
  });

  it('approval-policy: create + list', async () => {
    const { hdr } = await seed();
    const res = await post(hdr, '/api/approval-policies', {
      name: 'budget-chain',
      kind: 'budget_increase',
      definition: {
        tiers: [
          { min_amount_usd: '0', steps: [{ approvers: { roles: ['admin'] }, quorum: 'any' }] },
        ],
      },
    });
    expect(res.statusCode).toBe(201);
    const list = await h.app.inject({ method: 'GET', url: '/api/approval-policies', headers: hdr });
    // The created policy PLUS the org-wide default seeded at org creation (§2.10).
    expect(list.json<{ approvalPolicies: unknown[] }>().approvalPolicies).toHaveLength(2);
  });

  it('delegation: member→member ok; a non-member endpoint → 400', async () => {
    const { hdr } = await seed();
    const org = hdr['x-spillway-org']!;
    await h.adminSql`INSERT INTO users (id, email) VALUES ('a', 'a@t.dev'), ('b', 'b@t.dev') ON CONFLICT (id) DO NOTHING`;
    await h.adminSql`INSERT INTO org_members (org_id, user_id, role) VALUES (${org}, 'a', 'admin'), (${org}, 'b', 'member')`;
    const ok = await post(hdr, '/api/delegations', {
      fromUser: 'a',
      toUser: 'b',
      startsAt: '2026-07-01T00:00:00Z',
      endsAt: '2026-07-31T00:00:00Z',
    });
    expect(ok.statusCode).toBe(201);
    // 'ghost' is not an org member → borrowed id dropped → 400
    const bad = await post(hdr, '/api/delegations', {
      fromUser: 'a',
      toUser: 'ghost',
      startsAt: '2026-07-01T00:00:00Z',
      endsAt: '2026-07-31T00:00:00Z',
    });
    expect(bad.statusCode).toBe(400);
  });

  it('free plan → 402 tier_required on automation-rules', async () => {
    const { hdr } = await seed('free');
    const res = await post(hdr, '/api/automation-rules', {
      name: 'x',
      priority: 1,
      triggerType: 'alert_fired',
      condition: {},
      action: { type: 'pause_key' },
    });
    expect(res.statusCode).toBe(402);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('tier_required');
  });

  it('delegation: self-delegation (fromUser===toUser) → clean 400, not a raw DB error (L37)', async () => {
    const { hdr } = await seed();
    const org = hdr['x-spillway-org']!;
    await h.adminSql`INSERT INTO users (id, email) VALUES ('sd', 'sd@t.dev') ON CONFLICT (id) DO NOTHING`;
    await h.adminSql`INSERT INTO org_members (org_id, user_id, role) VALUES (${org}, 'sd', 'admin')`;
    const bad = await post(hdr, '/api/delegations', {
      fromUser: 'sd',
      toUser: 'sd',
      startsAt: '2026-07-01T00:00:00Z',
      endsAt: '2026-07-31T00:00:00Z',
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json<{ error: { code: string } }>().error.code).toBe('validation_error');
  });

  it('automation-rule: atomic priority swap via /reorder succeeds where a single PATCH would 23505 (L38)', async () => {
    const { hdr } = await seed();
    const mk = async (name: string, priority: number): Promise<string> =>
      (
        await post(hdr, '/api/automation-rules', {
          name,
          priority,
          triggerType: 'alert_fired',
          condition: {},
          action: { type: 'pause_key' },
        })
      ).json<{ automationRule: { id: string } }>().automationRule.id;
    const a = await mk('a', 10);
    const b = await mk('b', 20);
    const res = await post(hdr, '/api/automation-rules/reorder', {
      order: [
        { id: a, priority: 20 },
        { id: b, priority: 10 },
      ],
    });
    expect(res.statusCode).toBe(200);
    const rows = await h.adminSql<{ id: string; priority: number }[]>`
      SELECT id, priority FROM automation_rules WHERE id IN (${a}, ${b})`;
    const byId = new Map(rows.map((r) => [r.id, r.priority]));
    expect(byId.get(a)).toBe(20);
    expect(byId.get(b)).toBe(10);
  });

  it('automation-rule: a schedule_cron rule arms an initial rule_schedule timer on create (M37)', async () => {
    const { hdr } = await seed();
    const org = hdr['x-spillway-org']!;
    const res = await post(hdr, '/api/automation-rules', {
      name: 'nightly',
      priority: 5,
      triggerType: 'schedule_cron',
      condition: {},
      action: { type: 'create_alert', kind: 'digest' },
      scheduleCron: '@every 1h',
    });
    expect(res.statusCode).toBe(201);
    const id = res.json<{ automationRule: { id: string } }>().automationRule.id;
    const timer = await h.adminSql`
      SELECT 1 FROM workflow_timers WHERE org_id = ${org} AND ref_id = ${id} AND kind = 'rule_schedule'`;
    expect(timer).toHaveLength(1);
  });
});
