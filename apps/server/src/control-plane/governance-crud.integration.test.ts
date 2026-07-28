import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { makeTestApp, type TestHarness } from '../../test/helpers/app.js';

/**
 * B6.2–B6.5 governance CRUD: aliases + routing-rules (gateway-core) + guardrail policies (Governance,
 * CEL compiled at authoring) + alerts (Pro, kind registry). Covers the load-bearing gates: deny is not
 * a routing action, a bad CEL is a 422, tier gates, and the alert-kind registry.
 */
describe('governance CRUD (B6.2–B6.5)', () => {
  let h: TestHarness;
  beforeEach(async () => {
    h = await makeTestApp();
  });
  afterEach(async () => {
    await h.close();
  });

  async function seed(plan = 'governance'): Promise<{ hdr: Record<string, string> }> {
    const tok = await h.token('user_x');
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/orgs',
      headers: { authorization: `Bearer ${tok}` },
      payload: { name: 'A', slug: 'org-' + randomUUID().slice(0, 8) },
    });
    // Assert before dereferencing: a CI flake here once surfaced as a bare TypeError with the
    // actual error response swallowed (main run 29225365293). Fail with the body visible instead.
    expect(res.statusCode, `org create failed: ${res.body}`).toBe(201);
    const org = res.json<{ org: { id: string } }>().org.id;
    await h.adminSql`UPDATE orgs SET plan = ${plan} WHERE id = ${org}`;
    return { hdr: { authorization: `Bearer ${tok}`, 'x-spillway-org': org } };
  }
  const inject = (hdr: Record<string, string>, method: 'POST', url: string, payload: unknown) =>
    h.app.inject({ method, url, headers: hdr, payload: payload as object });

  it('aliases: create + list + duplicate 409', async () => {
    const { hdr } = await seed();
    const body = { alias: 'fast', targets: [{ provider: 'openai', model: 'gpt-4o-mini' }] };
    expect((await inject(hdr, 'POST', '/api/aliases', body)).statusCode).toBe(201);
    const list = await h.app.inject({ method: 'GET', url: '/api/aliases', headers: hdr });
    // org creation seeds spillway/{cheap,balanced,premium} (08-routing §2); +1 for the 'fast' alias.
    const aliases = list.json<{ aliases: Array<{ alias: string }> }>().aliases;
    expect(aliases).toHaveLength(4);
    expect(aliases.map((a) => a.alias)).toContain('fast');
    expect((await inject(hdr, 'POST', '/api/aliases', body)).statusCode).toBe(409); // dup alias
  });

  it('routing-rules: rewrite ok; deny rejected (ADR-034)', async () => {
    const { hdr } = await seed();
    const ok = await inject(hdr, 'POST', '/api/routing-rules', {
      priority: 10,
      match: { models: ['gpt-4o'] },
      action: { type: 'rewrite_model', to: { provider: 'openai', model: 'gpt-4o-mini' } },
    });
    expect(ok.statusCode).toBe(201);
    const deny = await inject(hdr, 'POST', '/api/routing-rules', {
      priority: 20,
      match: {},
      action: { type: 'deny', reason: 'no' },
    });
    expect(deny.statusCode).toBe(422); // deny is not a routing action (schema rejects → validation_error)
  });

  it('policies: create (governance); a bad CEL is 422; free plan → 402', async () => {
    const { hdr } = await seed();
    const good = await inject(hdr, 'POST', '/api/policies', {
      name: 'block-5.5',
      effect: 'deny',
      reason: 'blocked',
      match: { models: ['gpt-5.5'] },
      conditionCel: 'request.stream == true',
    });
    expect(good.statusCode).toBe(201);
    // banned comprehension macro → 422 cel_banned_macro (authoring-time compile)
    const badCel = await inject(hdr, 'POST', '/api/policies', {
      name: 'bad',
      effect: 'flag',
      reason: 'r',
      conditionCel: '[1,2].all(x, x > 0)',
    });
    expect(badCel.statusCode).toBe(422);
    expect(badCel.json<{ error: { code: string } }>().error.code).toBe('cel_banned_macro');

    // require_approval authoring is rejected until the grant mechanism (16 §3.4) is ADR-settled —
    // a clear 422 instead of a silent permanent 403 at request time.
    const ra = await inject(hdr, 'POST', '/api/policies', {
      name: 'needs-approval',
      effect: 'require_approval',
      reason: 'r',
    });
    expect(ra.statusCode).toBe(422);
    expect(ra.json<{ error: { code: string } }>().error.code).toBe('validation_error');

    const { hdr: freeHdr } = await seed('free');
    const gated = await inject(freeHdr, 'POST', '/api/policies', {
      name: 'x',
      effect: 'deny',
      reason: 'r',
    });
    expect(gated.statusCode).toBe(402);
    expect(gated.json<{ error: { code: string } }>().error.code).toBe('tier_required');
  });

  it('alerts: create (pro); unknown kind 422; system kind 422; free → 402', async () => {
    const { hdr } = await seed('pro');
    expect(
      (await inject(hdr, 'POST', '/api/alerts', { name: 'b', kind: 'budget_threshold' }))
        .statusCode,
    ).toBe(201);
    expect(
      (await inject(hdr, 'POST', '/api/alerts', { name: 'x', kind: 'telepathy' })).statusCode,
    ).toBe(422);
    expect(
      (await inject(hdr, 'POST', '/api/alerts', { name: 'x', kind: 'approval_notification' }))
        .statusCode,
    ).toBe(422); // system-managed kind not user-creatable
    const { hdr: freeHdr } = await seed('free');
    expect(
      (await inject(freeHdr, 'POST', '/api/alerts', { name: 'b', kind: 'budget_threshold' }))
        .statusCode,
    ).toBe(402);
  });

  it('org-create seeds the default approval policy; a human request freezes a chain from it (18 §2.10/§2.3)', async () => {
    const { hdr } = await seed();
    const orgId = hdr['x-spillway-org']!;

    // Part A (§2.10): org creation seeded the org-wide default policy (kind '*', scope_type NULL).
    const pol = await h.adminSql<{ kind: string; scope_type: string | null; enabled: boolean }[]>`
      SELECT kind, scope_type, enabled FROM approval_policies WHERE org_id = ${orgId}`;
    expect(pol).toHaveLength(1);
    expect(pol[0]!.kind).toBe('*');
    expect(pol[0]!.scope_type).toBeNull();
    expect(pol[0]!.enabled).toBe(true);

    // A second admin so the owner's own request has a non-requester approver (self-approval ban).
    await h.adminSql`INSERT INTO users (id, email) VALUES ('user_y', 'y@acme.test') ON CONFLICT DO NOTHING`;
    await h.adminSql`INSERT INTO org_members (org_id, user_id, role) VALUES (${orgId}, 'user_y', 'admin')`;

    // Part B (§2.3): a human budget_increase request selects the default policy and freezes a chain.
    const created = await inject(hdr, 'POST', '/api/approvals', {
      kind: 'budget_increase',
      scopeType: 'org',
      scopeId: orgId,
      requestedValue: { new_limit_usd: '500.000000', period: 'month' },
    });
    expect(created.statusCode, `create failed: ${created.body}`).toBe(201);
    const approval = created.json<{ approval: { id: string; status: string } }>().approval;
    expect(approval.status).toBe('pending');

    const detail = await h.app.inject({
      method: 'GET',
      url: `/api/approvals/${approval.id}`,
      headers: hdr,
    });
    const body = detail.json<{
      approval: { kind: string; requested_by: string };
      steps: { quorum: string; required_approver_ids: string[] }[];
    }>();
    expect(body.approval.kind).toBe('budget_increase');
    expect(body.approval.requested_by).toBe('user_x'); // never the body — the authed user
    expect(body.steps).toHaveLength(1);
    expect(body.steps[0]!.quorum).toBe('any');
    expect(body.steps[0]!.required_approver_ids).toEqual(['user_y']); // requester excluded
  });

  it('rejects an alert channel whose URL is SSRF-unsafe (§5.1)', async () => {
    const { hdr } = await seed();
    const res = await inject(hdr, 'POST', '/api/alerts', {
      name: 'x',
      kind: 'budget_threshold',
      channels: [{ type: 'webhook', url: 'https://169.254.169.254/x', secret: 's' }],
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
  });

  it('policies/lint flags an unreachable routing rule (L1, §9.1)', async () => {
    const { hdr } = await seed();
    const orgId = hdr['x-spillway-org']!;
    await h.adminSql`INSERT INTO routing_rules (org_id, priority, match, action, enabled) VALUES
      (${orgId}, 1, ${h.adminSql.json({} as never)}, ${h.adminSql.json({ type: 'set_fallbacks', fallbacks: [] } as never)}, true),
      (${orgId}, 2, ${h.adminSql.json({ models: ['gpt-4o'] } as never)}, ${h.adminSql.json({ type: 'set_fallbacks', fallbacks: [] } as never)}, true)`;
    const res = await inject(hdr, 'POST', '/api/policies/lint', {});
    expect(res.statusCode).toBe(200);
    const findings = res.json<{ findings: { rule: string }[] }>().findings;
    expect(findings.some((f) => f.rule === 'L1')).toBe(true);
  });

  it('policies/lint flags a dead route (L3) and an unservable alias target (L4, §9.1)', async () => {
    const { hdr } = await seed();
    const orgId = hdr['x-spillway-org']!;
    const ruleId = randomUUID();
    // Enforcing, unconditional deny on gpt-4o + a routing rule that rewrites TO gpt-4o → dead route.
    await h.adminSql`INSERT INTO governance_policies (org_id, name, effect, reason, match, enforcement, enabled)
      VALUES (${orgId}, 'deny-4o', 'deny', 'blocked', ${h.adminSql.json({ models: ['gpt-4o'] } as never)}, 'enforce', true)`;
    await h.adminSql`INSERT INTO routing_rules (id, org_id, priority, match, action, enabled) VALUES
      (${ruleId}, ${orgId}, 50, ${h.adminSql.json({} as never)},
       ${h.adminSql.json({ type: 'rewrite_model', to: { provider: 'openai', model: 'gpt-4o' } } as never)}, true)`;
    // An alias targeting a provider the org has no active key for.
    await h.adminSql`INSERT INTO model_aliases (org_id, alias, targets)
      VALUES (${orgId}, 'badprov', ${h.adminSql.json([{ provider: 'gemini', model: 'gemini-2.5-flash' }] as never)})`;

    const res = await inject(hdr, 'POST', '/api/policies/lint', {});
    expect(res.statusCode).toBe(200);
    const findings = res.json<{ findings: { rule: string; subjectIds: string[] }[] }>().findings;
    expect(findings.some((f) => f.rule === 'L3' && f.subjectIds.includes(ruleId))).toBe(true);
    expect(findings.some((f) => f.rule === 'L4' && f.subjectIds.includes('badprov'))).toBe(true);
  });

  it('a viewer cannot open an approval request (§2.3 → 403)', async () => {
    const { hdr } = await seed();
    const orgId = hdr['x-spillway-org']!;
    await h.adminSql`INSERT INTO users (id, email) VALUES ('user_v', 'v@acme.test') ON CONFLICT DO NOTHING`;
    await h.adminSql`INSERT INTO org_members (org_id, user_id, role) VALUES (${orgId}, 'user_v', 'viewer')`;
    const vtok = await h.token('user_v');
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/approvals',
      headers: { authorization: `Bearer ${vtok}`, 'x-spillway-org': orgId },
      payload: { kind: 'key_unpause', scopeType: 'virtual_key', scopeId: randomUUID() },
    });
    expect(res.statusCode).toBe(403);
  });
});
