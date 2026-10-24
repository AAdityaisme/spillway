import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { makeTestApp, type TestHarness } from '../../test/helpers/app.js';
import { withOrg } from '../db/tenancy.js';
import { virtualKeys } from '../db/schema.js';

/**
 * PHASE 3 — cross-tenant isolation, proven at the HTTP layer.
 *
 * WHY THIS FILE EXISTS: `rls-coverage.integration.test.ts` proves every RLS policy exists and
 * isolates — but it does so by calling `withOrg` directly. That proves the DATABASE isolates.
 * It does not prove that the 73 control-plane routes on top of it (30 of which take a resource
 * id — the by-id method+path pairs PROBES enumerates) reach the database the way they claim to.
 * A route that forgets `withOrg`, reads a path id before scoping it, or returns a body assembled
 * outside the transaction, passes every existing test in this repo. IDOR/BOLA is the #1 API vuln
 * class and it is exactly what this layer is supposed to stop.
 *
 * THE POSITIVE CONTROL IS THE POINT. Asserting "org A gets 404 for org B's id" is worthless on
 * its own — a typo'd URL returns 404 too, and a suite of typos passes forever while proving
 * nothing. So every probe runs TWICE: once as the owner (must succeed and return the resource),
 * once as the attacker (must be denied). A probe whose owner call fails is a broken probe and
 * fails the suite loudly rather than silently degrading into a tautology.
 *
 * LEAK DETECTION IS BY MARKER, NOT BY STATUS CODE. Each org's fixtures carry a unique
 * unguessable marker string. The attacker assertion is "the response body does not contain org
 * B's marker" — which catches a 200-with-data leak, a 500 whose stack trace echoes the row, and
 * an error envelope that helpfully names the resource it refused. Status code is asserted too,
 * but the marker is what makes this a security test instead of a routing test.
 */

interface OrgFixture {
  label: string;
  marker: string;
  userId: string;
  /** A second, non-owner member — the owner cannot be demoted or removed (last_owner, 409), so
   *  member probes need a target whose positive control can actually succeed. */
  spareUserId: string;
  token: string;
  orgId: string;
  teamId: string;
  providerKeyId: string;
  virtualKeyId: string;
  adminKeyId: string;
  budgetId: string;
  aliasId: string;
  routingRuleId: string;
  policyId: string;
  alertId: string;
  /** F6 fixtures — six by-id routes that used to be RLS-only (no redundant `eq(orgId)`). */
  requestId: string; // a `requests` row; doubles as the id for /requests/:id and /traces/:id
  decisionLogId: string;
  approvalId: string; // read + decided by the owner (positive control for GET and .../decisions)
  approvalCancelId: string; // separate pending approval so cancel doesn't fight the decision probe
}

/** A by-id route: owner must reach it, attacker must not. */
interface Probe {
  name: string;
  method: 'GET' | 'PATCH' | 'DELETE' | 'POST';
  /** Built from the fixture that OWNS the target resource. */
  url: (f: OrgFixture) => string;
  payload?: Record<string, unknown>;
  /**
   * How the route is expected to refuse a foreign id.
   *  'refuse' — by-id read/mutate: must answer 403/404, never process the request.
   *  'empty'  — org-scoped aggregate that takes an id as a FILTER (e.g. shadow-impact). RLS makes
   *             it return zero rows for a foreign id, so 200-with-nothing is the correct and
   *             non-leaking answer; it returns the same for an id that does not exist at all, so
   *             it is not an existence oracle either. Assert emptiness instead of a status.
   */
  mode?: 'refuse' | 'empty';
  /** Status codes that count as "refused" for THIS probe. Default [403, 404, 400]. Approval
   *  decisions/cancel go through a lock-and-validate path that answers 409 ("not pending") for a
   *  foreign id it can't see, same as a genuinely-decided approval — still "refused, not
   *  processed", just a different code than a plain by-id lookup. */
  refuseStatuses?: number[];
}

const DEFAULT_REFUSE_STATUSES = [403, 404, 400];

describe('cross-tenant isolation — every by-id route, both directions', () => {
  let h: TestHarness;
  let A: OrgFixture;
  let B: OrgFixture;

  // One app + two fully-populated orgs for the whole file. Fixture setup is ~30 HTTP calls;
  // rebuilding it per-probe would turn a 4s suite into a 4-minute one for no added coverage.
  beforeAll(async () => {
    h = await makeTestApp();
    A = await seedOrg('a');
    B = await seedOrg('b');
  }, 120_000);

  afterAll(async () => {
    await h.close();
  });

  const auth = (f: OrgFixture) => ({
    authorization: `Bearer ${f.token}`,
    'x-spillway-org': f.orgId,
  });

  /** POST helper that fails LOUDLY with the server's error body — a silently-skipped fixture is
   *  a silently-unproven route. */
  async function create(
    f: OrgFixture,
    url: string,
    payload: Record<string, unknown>,
  ): Promise<string> {
    const res = await h.app.inject({ method: 'POST', url, headers: auth(f), payload });
    if (res.statusCode !== 200 && res.statusCode !== 201) {
      throw new Error(`fixture ${url} for org ${f.label} failed: ${res.statusCode} ${res.body}`);
    }
    // Each create route wraps its row under its own key ({team: …}, {virtualKey: …}); take the
    // first value carrying an id rather than hard-coding 11 different envelope names.
    const body = res.json<Record<string, { id?: string }>>();
    const id = Object.values(body).find(
      (v): v is { id: string } => !!v && typeof v === 'object' && typeof v.id === 'string',
    )?.id;
    if (!id) throw new Error(`fixture ${url} for org ${f.label} returned no id: ${res.body}`);
    return id;
  }

  async function seedOrg(label: string): Promise<OrgFixture> {
    // Unguessable per-org marker: every fixture below is named with it, so any response body
    // echoing another org's data trips the assertion regardless of which field carried it.
    const marker = `xtenant-${label}-${crypto.randomUUID()}`;
    const userId = `user_${label}_${crypto.randomUUID().slice(0, 8)}`;
    const token = await h.token(userId);

    const orgRes = await h.app.inject({
      method: 'POST',
      url: '/api/orgs',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: `Org ${label}`, slug: `org-${label}-${crypto.randomUUID().slice(0, 8)}` },
    });
    expect(orgRes.statusCode, `org ${label} create: ${orgRes.body}`).toBe(201);
    const orgId = orgRes.json<{ org: { id: string } }>().org.id;

    // Entitlement gates (alerts/policies/automation) read orgs.plan and 402 on the free tier.
    // Bump both orgs so a PLAN check can never be what denies the attacker — otherwise this
    // suite would "pass" while proving billing works, not that tenancy does.
    await h.adminSql`update orgs set plan = 'enterprise' where id = ${orgId}`;

    const f = { label, marker, userId, token, orgId } as OrgFixture;

    // A second member to aim the member probes at. The user row must already exist (the route
    // 422s on an unknown user id), and a user row is created by the org-create path — so the
    // spare mints its own token and its own throwaway org first, then joins this one.
    f.spareUserId = `spare_${label}_${crypto.randomUUID().slice(0, 8)}`;
    const spareToken = await h.token(f.spareUserId);
    const spareOrg = await h.app.inject({
      method: 'POST',
      url: '/api/orgs',
      headers: { authorization: `Bearer ${spareToken}` },
      payload: {
        name: `Spare ${label}`,
        slug: `spare-${label}-${crypto.randomUUID().slice(0, 8)}`,
      },
    });
    expect(spareOrg.statusCode, `spare user ${label}: ${spareOrg.body}`).toBe(201);
    const join = await h.app.inject({
      method: 'POST',
      url: '/api/members',
      headers: auth(f),
      payload: { userId: f.spareUserId, role: 'member' },
    });
    expect(join.statusCode, `spare member join ${label}: ${join.body}`).toBeLessThan(400);

    f.teamId = await create(f, '/api/teams', {
      name: `team-${marker}`,
      slug: `team-${label}-${crypto.randomUUID().slice(0, 8)}`,
    });
    f.providerKeyId = await create(f, '/api/provider-keys', {
      provider: 'openai',
      label: `pk-${marker}`,
      apiKey: `sk-${marker}`,
    });
    f.virtualKeyId = await create(f, '/api/virtual-keys', { name: `vk-${marker}` });
    f.adminKeyId = await create(f, '/api/admin-api-keys', { name: `ak-${marker}`, role: 'admin' });
    f.budgetId = await create(f, '/api/budgets', {
      scopeType: 'org',
      scopeId: orgId,
      period: 'month',
      limitUsd: '100.00',
    });
    f.aliasId = await create(f, '/api/aliases', {
      alias: `alias-${marker}`,
      targets: [{ provider: 'openai', model: `gpt-4o-${marker}` }],
    });
    f.routingRuleId = await create(f, '/api/routing-rules', {
      priority: 10,
      description: `rr-${marker}`,
      match: {},
      action: { type: 'rewrite_model', to: { provider: 'openai', model: 'gpt-4o' } },
    });
    f.policyId = await create(f, '/api/policies', {
      name: `pol-${marker}`,
      effect: 'flag',
      reason: `reason-${marker}`,
    });
    f.alertId = await create(f, '/api/alerts', {
      name: `alert-${marker}`,
      kind: 'budget_threshold',
      config: { note: marker },
    });

    // F6 fixtures. `requests`/`decision_logs` are data-plane-written (no control-plane create
    // route) — seed directly as superuser, same technique rls-coverage.integration.test.ts uses.
    f.requestId = crypto.randomUUID();
    await h.adminSql`insert into requests (id, org_id, endpoint, status, requested_model)
      values (${f.requestId}, ${orgId}, 'chat_completions', 'ok', ${`gpt-4o-${marker}`})`;
    f.decisionLogId = crypto.randomUUID();
    await h.adminSql`insert into decision_logs
        (decision_id, org_id, request_id, effect, enforcement, config_snapshot_hash, input_snapshot, reason)
      values (${f.decisionLogId}, ${orgId}, ${f.requestId}, 'flag', 'enforce', 'hash-x', '{}'::jsonb, ${marker})`;

    // Approvals must be REQUESTED by the spare member (not the owner) so the owner can decide/
    // cancel them without tripping the self-approval ban — mirrors the real shape (member
    // requests, admin/owner decides). Needs its own virtual key created BY the spare (a member
    // may request only for a key they created — approvals.ts assertScopeAccess).
    const spareVk = await h.app.inject({
      method: 'POST',
      url: '/api/virtual-keys',
      headers: { authorization: `Bearer ${spareToken}`, 'x-spillway-org': orgId },
      payload: { name: `vk-spare-${marker}` },
    });
    if (spareVk.statusCode !== 201) throw new Error(`spare virtual-key ${label}: ${spareVk.body}`);
    const spareVkId = spareVk.json<{ virtualKey: { id: string } }>().virtualKey.id;

    async function createApproval(): Promise<string> {
      const res = await h.app.inject({
        method: 'POST',
        url: '/api/approvals',
        headers: { authorization: `Bearer ${spareToken}`, 'x-spillway-org': orgId },
        payload: {
          kind: 'key_unpause',
          scopeType: 'virtual_key',
          scopeId: spareVkId,
          requestedValue: {},
        },
      });
      if (res.statusCode !== 201) throw new Error(`approval fixture ${label}: ${res.body}`);
      return res.json<{ approval: { id: string } }>().approval.id;
    }
    // Two independent pending approvals: one is read then DECIDED (terminal), the other is only
    // ever cancelled — sharing one id would make whichever probe runs second fail for the OWNER
    // with 409 (not pending), which reads as a broken probe rather than a real failure.
    f.approvalId = await createApproval();
    f.approvalCancelId = await createApproval();

    return f;
  }

  // Every route that takes a resource id. Adding a route here is one line — and a route absent
  // from this table is a route nobody has proven isolates.
  // ORDER MATTERS. The positive-control block runs these same probes as the owner, for real —
  // so a DELETE must come after every other probe against that resource, or it pulls the fixture
  // out from under them and they 404 for the owner (which reads as a broken probe, correctly).
  const PROBES: Probe[] = [
    // teams
    {
      name: 'PATCH /api/teams/:id',
      method: 'PATCH',
      url: (f) => `/api/teams/${f.teamId}`,
      payload: { name: 'renamed-by-attacker' },
    },
    { name: 'DELETE /api/teams/:id', method: 'DELETE', url: (f) => `/api/teams/${f.teamId}` },
    // keys
    {
      name: 'PATCH /api/virtual-keys/:id',
      method: 'PATCH',
      url: (f) => `/api/virtual-keys/${f.virtualKeyId}`,
      payload: { status: 'revoked' },
    },
    {
      name: 'PATCH /api/admin-api-keys/:id',
      method: 'PATCH',
      url: (f) => `/api/admin-api-keys/${f.adminKeyId}`,
      payload: { status: 'revoked' },
    },
    {
      name: 'DELETE /api/provider-keys/:id',
      method: 'DELETE',
      url: (f) => `/api/provider-keys/${f.providerKeyId}`,
    },
    // budgets
    {
      name: 'PATCH /api/budgets/:id',
      method: 'PATCH',
      url: (f) => `/api/budgets/${f.budgetId}`,
      payload: { limitUsd: '999999.00' },
    },
    { name: 'DELETE /api/budgets/:id', method: 'DELETE', url: (f) => `/api/budgets/${f.budgetId}` },
    // aliases
    {
      name: 'PATCH /api/aliases/:id',
      method: 'PATCH',
      url: (f) => `/api/aliases/${f.aliasId}`,
      payload: { targets: [{ provider: 'openai', model: 'hijacked' }] },
    },
    { name: 'DELETE /api/aliases/:id', method: 'DELETE', url: (f) => `/api/aliases/${f.aliasId}` },
    // routing rules
    {
      name: 'PATCH /api/routing-rules/:id',
      method: 'PATCH',
      url: (f) => `/api/routing-rules/${f.routingRuleId}`,
      payload: { enabled: false },
    },
    {
      name: 'DELETE /api/routing-rules/:id',
      method: 'DELETE',
      url: (f) => `/api/routing-rules/${f.routingRuleId}`,
    },
    // policies — shadow-impact reads decision_logs FILTERED by policy id, so it is an 'empty'
    // probe, and it must run before the policy is deleted.
    {
      name: 'PATCH /api/policies/:id',
      method: 'PATCH',
      url: (f) => `/api/policies/${f.policyId}`,
      payload: { enabled: false },
    },
    {
      name: 'GET /api/policies/:id/shadow-impact',
      method: 'GET',
      url: (f) => `/api/policies/${f.policyId}/shadow-impact`,
      mode: 'empty',
    },
    {
      name: 'DELETE /api/policies/:id',
      method: 'DELETE',
      url: (f) => `/api/policies/${f.policyId}`,
    },
    // alerts — /test before the delete, same reason
    {
      name: 'PATCH /api/alerts/:id',
      method: 'PATCH',
      url: (f) => `/api/alerts/${f.alertId}`,
      payload: { enabled: false },
    },
    {
      name: 'POST /api/alerts/:id/test',
      method: 'POST',
      url: (f) => `/api/alerts/${f.alertId}/test`,
      payload: {},
    },
    { name: 'DELETE /api/alerts/:id', method: 'DELETE', url: (f) => `/api/alerts/${f.alertId}` },
    // members — aimed at the spare, never the owner (demoting/removing the last owner is a 409
    // business rule that would mask the tenancy result).
    {
      name: 'PATCH /api/members/:userId',
      method: 'PATCH',
      url: (f) => `/api/members/${f.spareUserId}`,
      payload: { role: 'viewer' },
    },
    {
      name: 'DELETE /api/members/:userId',
      method: 'DELETE',
      url: (f) => `/api/members/${f.spareUserId}`,
    },
    // F6 — six by-id routes that were RLS-ONLY: memberScope() returns undefined for admin/owner
    // (requests.ts), and the approvals/traces/decision-logs reads are raw SQL with no org
    // predicate at all. Now carry the same redundant `eq(orgId)` as everything above; these
    // probes are what keeps that true.
    { name: 'GET /api/requests/:id', method: 'GET', url: (f) => `/api/requests/${f.requestId}` },
    { name: 'GET /api/traces/:id', method: 'GET', url: (f) => `/api/traces/${f.requestId}` },
    {
      name: 'GET /api/decision-logs/:decisionId',
      method: 'GET',
      url: (f) => `/api/decision-logs/${f.decisionLogId}`,
    },
    {
      name: 'GET /api/approvals/:id',
      method: 'GET',
      url: (f) => `/api/approvals/${f.approvalId}`,
    },
    {
      name: 'POST /api/approvals/:id/decisions',
      method: 'POST',
      url: (f) => `/api/approvals/${f.approvalId}/decisions`,
      payload: { decision: 'approve' },
      refuseStatuses: [403, 404, 400, 409], // lockPending answers 409 for an id it can't see
    },
    {
      name: 'POST /api/approvals/:id/cancel',
      method: 'POST',
      url: (f) => `/api/approvals/${f.approvalCancelId}/cancel`,
      payload: {},
      refuseStatuses: [403, 404, 400, 409],
    },
  ];

  // it.each([]) registers ZERO tests and reports green — an empty PROBES would silently disarm
  // this whole suite. Fail loudly instead of not existing.
  it('PROBES is non-empty (an empty array would silently disarm this suite)', () => {
    expect(PROBES.length).toBeGreaterThan(0);
  });

  // ── the attack ────────────────────────────────────────────────────────────────────────────
  // Org A's own credentials (valid token, valid membership in A) aimed at org B's resource ids.
  // This is the realistic shape: not a forged token, a legitimate customer walking ids.
  it.each(PROBES)('$name — org A cannot touch org B', async (probe) => {
    const res = await h.app.inject({
      method: probe.method,
      url: probe.url(B), // B's resource id …
      headers: auth(A), // … with A's identity and A's org header
      payload: probe.payload,
    });

    expect(
      res.body.includes(B.marker),
      `${probe.name} LEAKED org B data to org A (status ${res.statusCode}): ${res.body.slice(0, 400)}`,
    ).toBe(false);
    expect(res.body.includes(B.orgId), `${probe.name} echoed org B's id back to org A`).toBe(false);

    if (probe.mode === 'empty') {
      // Org-scoped aggregate: RLS yields nothing for a foreign filter id. Assert it really is
      // nothing, rather than a status — a 200 carrying B's numbers would slip past a status check.
      const body = res.json<{ shadowImpact?: { byEffect?: unknown[]; wouldHaveUsd?: string } }>();
      expect(body.shadowImpact?.byEffect ?? [], `${probe.name} returned org B's rows`).toHaveLength(
        0,
      );
      expect(body.shadowImpact?.wouldHaveUsd, `${probe.name} returned org B's dollars`).toBe('0');
      return;
    }
    expect(
      probe.refuseStatuses ?? DEFAULT_REFUSE_STATUSES,
      `${probe.name} answered ${res.statusCode} — a request aimed at another org must be refused, not processed`,
    ).toContain(res.statusCode);
  });

  // ── the positive control ──────────────────────────────────────────────────────────────────
  // Same requests, owner's credentials. Without this, every assertion above is satisfied by a
  // route that simply does not exist. Runs AFTER the attack block so the destructive DELETE
  // probes cannot remove the fixtures the attack block needs.
  it.each(PROBES)('$name — the owner CAN reach it (probe is real)', async (probe) => {
    const res = await h.app.inject({
      method: probe.method,
      url: probe.url(B),
      headers: auth(B),
      payload: probe.payload,
    });
    expect(
      res.statusCode,
      `${probe.name} failed for its OWNER (${res.body.slice(0, 300)}) — the isolation assertion above proves nothing`,
    ).toBeLessThan(400);
  });

  // ── membership, not just row scoping ──────────────────────────────────────────────────────
  it("rejects A presenting B's org header — membership is checked before any row is read", async () => {
    for (const url of ['/api/teams', '/api/provider-keys', '/api/budgets', '/api/virtual-keys']) {
      const res = await h.app.inject({
        method: 'GET',
        url,
        headers: { authorization: `Bearer ${A.token}`, 'x-spillway-org': B.orgId },
      });
      expect(res.statusCode, `${url} with a borrowed org header`).toBe(403);
      expect(res.body.includes(B.marker), `${url} leaked B's data on a borrowed org header`).toBe(
        false,
      );
    }
  });

  // ── list endpoints must not enumerate ─────────────────────────────────────────────────────
  it('list endpoints return only the caller org’s rows', async () => {
    for (const url of [
      '/api/teams',
      '/api/provider-keys',
      '/api/virtual-keys',
      '/api/admin-api-keys',
      '/api/budgets',
      '/api/aliases',
      '/api/routing-rules',
      '/api/policies',
      '/api/alerts',
      '/api/members',
      '/api/requests',
      '/api/decision-logs',
    ]) {
      const res = await h.app.inject({ method: 'GET', url, headers: auth(A) });
      expect(res.statusCode, `${url} for its own org`).toBeLessThan(400);
      expect(res.body.includes(B.marker), `${url} enumerated org B's rows to org A`).toBe(false);
    }
  });

  // ── the teeth check ───────────────────────────────────────────────────────────────────────
  // The handoff's Phase 3 exit criterion: this suite must FAIL if a policy were dropped. Proving
  // that by argument is worthless, so drop one for real and watch isolation break.
  //
  // Note WHICH layer this proves. The routes carry a redundant `eq(table.orgId, orgId)` alongside
  // RLS, so dropping a policy does NOT open the HTTP layer — defence in depth working as designed.
  // The mutation is therefore applied where RLS is the ONLY guard: a `withOrg` transaction, the
  // same seam every route sits on. If RLS ever silently stopped being load-bearing, this fails.
  const ORIGINAL_VK_POLICY = `create policy virtual_keys_org_isolation on virtual_keys for all to spillway_app using (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid)`;

  const readVirtualKeysAsA = () =>
    withOrg(h.db, A.orgId, (tx) =>
      tx.select({ id: virtualKeys.id, name: virtualKeys.name }).from(virtualKeys),
    );

  it('DROPPING a policy fails closed, it does not leak', async () => {
    // Worth asserting as a property in its own right, and it is why the teeth check below has to
    // WEAKEN rather than drop: with FORCE ROW LEVEL SECURITY on and no policy left to match,
    // Postgres denies everything. A dropped policy is an outage, not a breach. (Discovered by
    // this suite's first mutation attempt reporting "no leak" — the mutation was wrong, not the
    // isolation.)
    await h.adminSql`drop policy virtual_keys_org_isolation on virtual_keys`;
    try {
      expect(await readVirtualKeysAsA(), 'a policy-less table should expose NOTHING').toHaveLength(
        0,
      );
    } finally {
      await h.adminSql.unsafe(ORIGINAL_VK_POLICY);
    }
    expect((await readVirtualKeysAsA()).length).toBeGreaterThan(0); // restored
  });

  it('would fail if a policy stopped scoping by org (mutation proof — the teeth check)', async () => {
    // The realistic regression is not a deleted policy; it is a policy that still exists, still
    // looks fine in a migration diff, and no longer isolates — `USING (true)`, a dropped
    // `org_id =` clause, a `USING (true)` slipped in to "fix" a job that could not see its rows.
    // If this suite cannot catch that, it cannot catch anything.
    const before = await readVirtualKeysAsA();
    expect(before.length, 'control: A can see its OWN keys').toBeGreaterThan(0);
    expect(before.every((r) => !r.name.includes(B.marker))).toBe(true);

    await h.adminSql`drop policy virtual_keys_org_isolation on virtual_keys`;
    await h.adminSql`create policy virtual_keys_org_isolation on virtual_keys for all to spillway_app using (true)`;
    try {
      const leaked = await readVirtualKeysAsA();
      expect(
        leaked.some((r) => r.name.includes(B.marker)),
        'a non-scoping policy did NOT leak — this suite has no teeth and would not catch a real regression',
      ).toBe(true);
    } finally {
      // Restore verbatim from 0002_rls_policies.sql. A test that leaves the DB permissive would
      // silently disarm every assertion that runs after it.
      await h.adminSql`drop policy virtual_keys_org_isolation on virtual_keys`;
      await h.adminSql.unsafe(ORIGINAL_VK_POLICY);
    }

    const after = await readVirtualKeysAsA();
    expect(
      after.every((r) => !r.name.includes(B.marker)),
      'isolation restored',
    ).toBe(true);
  });

  // ── F6 — proving the redundant predicate actually does something ─────────────────────────────
  // GET /api/requests/:id used to be RLS-ONLY (memberScope() returns undefined for admin/owner,
  // so the query had no org predicate at all). Under intact RLS it never leaked — A's own
  // `withOrg(db, A.orgId, …)` GUC already hides B's row — which is exactly why the earlier PROBES
  // entry above doesn't prove this route has a SECOND layer. Weaken RLS the same way the teeth
  // check above does and watch the HTTP layer alone decide the outcome.
  const ORIGINAL_REQUESTS_POLICY = `create policy requests_org_isolation on requests for all to spillway_app using (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid)`;

  it('GET /api/requests/:id refuses org B even with RLS weakened (F6 defence-in-depth)', async () => {
    await h.adminSql`drop policy requests_org_isolation on requests`;
    await h.adminSql`create policy requests_org_isolation on requests for all to spillway_app using (true)`;
    try {
      const res = await h.app.inject({
        method: 'GET',
        url: `/api/requests/${B.requestId}`,
        headers: auth(A),
      });
      expect(
        res.body.includes(B.marker),
        `RLS weakened to USING (true) and the route still leaked B's request — the eq(orgId) ` +
          `predicate is not doing its job: ${res.body.slice(0, 300)}`,
      ).toBe(false);
      expect([403, 404, 400]).toContain(res.statusCode);
    } finally {
      await h.adminSql`drop policy requests_org_isolation on requests`;
      await h.adminSql.unsafe(ORIGINAL_REQUESTS_POLICY);
    }
  });
});
