import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { makeTestApp, type TestHarness } from '../../test/helpers/app.js';

/**
 * Decision-log query API + shadow-impact (16 §6.6/§8.2). Seeds decision_logs (2 shadow would-have-deny
 * rows on a policy, plus an enforce deny) + their requests, then exercises the read surface: filtered
 * list, single record, the "would have denied N / $X" aggregate, and the admin-only gate.
 */
describe('decision-logs query + shadow-impact (16 §6.6/§8.2)', () => {
  let h: TestHarness;
  let orgId: string;
  let hdr: Record<string, string>;
  const policyId = randomUUID();

  beforeEach(async () => {
    h = await makeTestApp();
    const tok = await h.token('user_x');
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/orgs',
      headers: { authorization: `Bearer ${tok}` },
      payload: { name: 'A', slug: 'o-' + randomUUID().slice(0, 8) },
    });
    orgId = res.json<{ org: { id: string } }>().org.id;
    await h.adminSql`UPDATE orgs SET plan = 'governance' WHERE id = ${orgId}`;
    hdr = { authorization: `Bearer ${tok}`, 'x-spillway-org': orgId };

    const r1 = randomUUID();
    const r2 = randomUUID();
    await h.adminSql`INSERT INTO requests (id, org_id, endpoint, status, cost_usd, created_at)
      VALUES (${r1}, ${orgId}, 'chat_completions', 'ok', 2.5, now()),
             (${r2}, ${orgId}, 'chat_completions', 'ok', 1.25, now())`;
    const insLog = (
      decisionId: string,
      requestId: string | null,
      effect: string,
      wouldHave: boolean,
    ): Promise<unknown> => h.adminSql`
      INSERT INTO decision_logs (decision_id, org_id, request_id, effect, enforcement, would_have,
        deciding_policy_id, config_snapshot_hash, input_snapshot)
      VALUES (${decisionId}, ${orgId}, ${requestId}, ${effect},
              ${wouldHave ? 'shadow' : 'enforce'}, ${wouldHave}, ${policyId}, 'h', '{}'::jsonb)`;
    await insLog(r1, r1, 'deny', true); // shadow would-have-deny, cost 2.50
    await insLog(r2, r2, 'deny', true); // shadow would-have-deny, cost 1.25
    await insLog(randomUUID(), null, 'deny', false); // enforce deny (not counted in shadow-impact)
  });
  afterEach(async () => {
    await h.close();
  });

  it('lists decision logs, filters by effect, and fetches a single record (admin)', async () => {
    const list = await h.app.inject({ method: 'GET', url: '/api/decision-logs', headers: hdr });
    expect(list.statusCode).toBe(200);
    const rows = list.json<{ decisionLogs: { decision_id: string; effect: string }[] }>()
      .decisionLogs;
    expect(rows.length).toBe(3);

    const denyOnly = await h.app.inject({
      method: 'GET',
      url: '/api/decision-logs?effect=deny',
      headers: hdr,
    });
    expect(
      denyOnly
        .json<{ decisionLogs: { effect: string }[] }>()
        .decisionLogs.every((d) => d.effect === 'deny'),
    ).toBe(true);

    const single = await h.app.inject({
      method: 'GET',
      url: `/api/decision-logs/${rows[0]!.decision_id}`,
      headers: hdr,
    });
    expect(single.statusCode).toBe(200);
    expect(single.json<{ decisionLog: { decision_id: string } }>().decisionLog.decision_id).toBe(
      rows[0]!.decision_id,
    );
  });

  it('shadow-impact aggregates would-have count + dollar impact for a policy (§8.2)', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/policies/${policyId}/shadow-impact?window=7d`,
      headers: hdr,
    });
    expect(res.statusCode).toBe(200);
    const si = res.json<{
      shadowImpact: {
        byEffect: { effect: string; would_have_count: number; affected_requests: number }[];
        wouldHaveUsd: string;
      };
    }>().shadowImpact;
    const deny = si.byEffect.find((e) => e.effect === 'deny')!;
    expect(deny.would_have_count).toBe(2); // only the 2 shadow rows, not the enforce deny
    expect(deny.affected_requests).toBe(2);
    expect(Number(si.wouldHaveUsd)).toBe(3.75); // 2.50 + 1.25
  });

  it('a member cannot read decision logs (admin+ only)', async () => {
    await h.adminSql`INSERT INTO users (id, email) VALUES ('user_m', 'm@acme.test') ON CONFLICT DO NOTHING`;
    await h.adminSql`INSERT INTO org_members (org_id, user_id, role) VALUES (${orgId}, 'user_m', 'member')`;
    const mtok = await h.token('user_m');
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/decision-logs',
      headers: { authorization: `Bearer ${mtok}`, 'x-spillway-org': orgId },
    });
    expect(res.statusCode).toBe(403);
  });
});
