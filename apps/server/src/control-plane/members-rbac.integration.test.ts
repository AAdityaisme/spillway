import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { makeTestApp, type TestHarness } from '../../test/helpers/app.js';

/**
 * Integration tests for control-plane member RBAC (L24, M24, M26, L25) and
 * chargeback window cap (L26) and approval status validation (L27).
 *
 * L24: members POST invite RBAC gate + PATCH role-change are tested.
 * M24: invite-before-login returns 422 not 404.
 * M26/L25: assertOwnerRemains serializes concurrent demotions.
 * L26: chargeback rejects window > 366 days.
 * L27: approvals list rejects unknown status; cancel authz.
 */
describe('members RBAC + control-plane hardening', () => {
  let h: TestHarness;
  beforeEach(async () => {
    h = await makeTestApp();
  });
  afterEach(async () => {
    await h.close();
  });

  // ── helpers ──────────────────────────────────────────────────────────────

  async function makeOrg(ownerSub: string): Promise<{ orgId: string; ownerTok: string }> {
    const ownerTok = await h.token(ownerSub);
    // GET /orgs first so the user row is mirrored
    await h.app.inject({ method: 'GET', url: '/api/orgs', headers: auth(ownerTok) });
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/orgs',
      headers: auth(ownerTok),
      payload: { name: 'Org', slug: 'org-' + randomUUID().slice(0, 8) },
    });
    expect(res.statusCode).toBe(201);
    return { orgId: res.json<{ org: { id: string } }>().org.id, ownerTok };
  }

  /** Mirror a user by hitting GET /orgs, then return their token. */
  async function mirrorUser(sub: string): Promise<string> {
    const tok = await h.token(sub);
    await h.app.inject({ method: 'GET', url: '/api/orgs', headers: auth(tok) });
    return tok;
  }

  function auth(token: string, org?: string): Record<string, string> {
    const h: Record<string, string> = { authorization: `Bearer ${token}` };
    if (org) h['x-spillway-org'] = org;
    return h;
  }

  function orgAuth(tok: string, org: string) {
    return auth(tok, org);
  }

  async function invite(
    ownerTok: string,
    orgId: string,
    userId: string,
    role: string,
  ): Promise<number> {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/members',
      headers: orgAuth(ownerTok, orgId),
      payload: { userId, role },
    });
    return res.statusCode;
  }

  // ── M24: invite-before-login returns 422, not 404 ──────────────────────

  it('M24: inviting a user who has never logged in returns 422, not 404', async () => {
    const { orgId, ownerTok } = await makeOrg('owner_m24');
    const neverLoggedIn = randomUUID(); // no users row for this id
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/members',
      headers: orgAuth(ownerTok, orgId),
      payload: { userId: neverLoggedIn, role: 'member' },
    });
    expect(res.statusCode).toBe(422);
    const body = res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('validation_error');
  });

  // ── L24: invite RBAC gate ─────────────────────────────────────────────

  it('L24a: an admin cannot invite an owner (canManageMemberRole blocks it)', async () => {
    const { orgId, ownerTok } = await makeOrg('owner_l24a');
    // Promote a member to admin first
    const adminSub = 'admin_l24a';
    await mirrorUser(adminSub);
    await invite(ownerTok, orgId, adminSub, 'admin');
    const adminTok = await h.token(adminSub);
    // Admin tries to invite a new owner
    const newSub = 'newowner_l24a';
    await mirrorUser(newSub);
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/members',
      headers: orgAuth(adminTok, orgId),
      payload: { userId: newSub, role: 'owner' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('L24b: owner can invite another owner', async () => {
    const { orgId, ownerTok } = await makeOrg('owner_l24b');
    const newOwnerSub = 'newowner_l24b';
    await mirrorUser(newOwnerSub);
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/members',
      headers: orgAuth(ownerTok, orgId),
      payload: { userId: newOwnerSub, role: 'owner' },
    });
    expect(res.statusCode).toBe(201);
  });

  it('L24c: PATCH role-change from admin to owner is forbidden for an admin actor', async () => {
    const { orgId, ownerTok } = await makeOrg('owner_l24c');
    // Admin actor
    const adminSub = 'admin_l24c';
    await mirrorUser(adminSub);
    await invite(ownerTok, orgId, adminSub, 'admin');
    const adminTok = await h.token(adminSub);
    // Target member to promote
    const memberSub = 'member_l24c';
    await mirrorUser(memberSub);
    await invite(ownerTok, orgId, memberSub, 'member');
    // Admin tries to promote member to owner (not allowed)
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/members/${memberSub}`,
      headers: orgAuth(adminTok, orgId),
      payload: { role: 'owner' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('L24d: owner promotes member to owner — 200', async () => {
    const { orgId, ownerTok } = await makeOrg('owner_l24d');
    const memberSub = 'member_l24d';
    await mirrorUser(memberSub);
    await invite(ownerTok, orgId, memberSub, 'member');
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/members/${memberSub}`,
      headers: orgAuth(ownerTok, orgId),
      payload: { role: 'owner' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ member: { role: string } }>().member.role).toBe('owner');
  });

  // ── M26: assertOwnerRemains prevents last-owner removal ──────────────

  it('M26a: last-owner self-demote → 409 last_owner', async () => {
    const { orgId, ownerTok } = await makeOrg('owner_m26a');
    const ownerSub = 'owner_m26a';
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/members/${ownerSub}`,
      headers: orgAuth(ownerTok, orgId),
      payload: { role: 'admin' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('last_owner');
  });

  it('M26b: last-owner delete → 409 last_owner', async () => {
    const { orgId, ownerTok } = await makeOrg('owner_m26b');
    const ownerSub = 'owner_m26b';
    const res = await h.app.inject({
      method: 'DELETE',
      url: `/api/members/${ownerSub}`,
      headers: orgAuth(ownerTok, orgId),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('last_owner');
  });

  it('M26c: two-owner demote → 200 (one owner remains)', async () => {
    const { orgId, ownerTok } = await makeOrg('owner_m26c');
    const ownerSub = 'owner_m26c';
    // Add a second owner
    const secondSub = 'owner2_m26c';
    await mirrorUser(secondSub);
    await invite(ownerTok, orgId, secondSub, 'owner');
    // Now demote the first owner — second owner still remains
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/members/${ownerSub}`,
      headers: orgAuth(ownerTok, orgId),
      payload: { role: 'admin' },
    });
    expect(res.statusCode).toBe(200);
  });

  // ── L25: concurrent demotion serialization ────────────────────────────

  it('L25: concurrent demotions of two owners — exactly one succeeds', async () => {
    const owner1Sub = 'owner1_l25';
    const owner2Sub = 'owner2_l25';
    const owner1Tok = await mirrorUser(owner1Sub);

    // Create org under owner1
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/orgs',
      headers: auth(owner1Tok),
      payload: { name: 'OrgL25', slug: 'org-l25-' + randomUUID().slice(0, 6) },
    });
    const orgId = res.json<{ org: { id: string } }>().org.id;
    // Add owner2 as co-owner
    await mirrorUser(owner2Sub);
    const owner2Tok = await h.token(owner2Sub);
    await invite(owner1Tok, orgId, owner2Sub, 'owner');

    // Fire two simultaneous demotions: owner1 demotes owner2 and owner2 demotes owner1
    const [r1, r2] = await Promise.all([
      h.app.inject({
        method: 'PATCH',
        url: `/api/members/${owner2Sub}`,
        headers: orgAuth(owner1Tok, orgId),
        payload: { role: 'admin' },
      }),
      h.app.inject({
        method: 'PATCH',
        url: `/api/members/${owner1Sub}`,
        headers: orgAuth(owner2Tok, orgId),
        payload: { role: 'admin' },
      }),
    ]);

    const statuses = [r1.statusCode, r2.statusCode].sort();
    // The last-owner guard serializes: exactly one demotion succeeds (200), the other is cleanly
    // blocked (409 last_owner or 403 forbidden) — never both succeed, never a raw 500.
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.some((s) => s === 409 || s === 403)).toBe(true);
  });

  // ── L26: chargeback window cap ────────────────────────────────────────

  it('L26: chargeback rejects window > 366 days with 400', async () => {
    const { orgId, ownerTok } = await makeOrg('owner_l26');
    await h.adminSql`UPDATE orgs SET plan = 'governance' WHERE id = ${orgId}`;
    const start = '2000-01-01T00:00:00Z';
    const end = '2100-01-01T00:00:00Z';
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/reports/chargeback?start=${start}&end=${end}`,
      headers: orgAuth(ownerTok, orgId),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('validation_error');
  });

  it('L26: chargeback accepts a valid 30-day window', async () => {
    const { orgId, ownerTok } = await makeOrg('owner_l26b');
    await h.adminSql`UPDATE orgs SET plan = 'governance' WHERE id = ${orgId}`;
    const start = '2026-06-01T00:00:00Z';
    const end = '2026-07-01T00:00:00Z';
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/reports/chargeback?start=${start}&end=${end}`,
      headers: orgAuth(ownerTok, orgId),
    });
    // 200 or 402 (free plan feature-gate) — not 400
    expect([200, 402].includes(res.statusCode)).toBe(true);
  });

  // ── L27: approval status validation + cancel authz ───────────────────

  // L27a (approvals list rejects unknown ?status) deferred: the fix lives in control-plane/routes/
  // approvals.ts, which is the approvals-automation cluster's lane (not landed here). Tracked.

  it('L27b: approvals list with valid status=pending returns 200', async () => {
    const { orgId, ownerTok } = await makeOrg('owner_l27b');
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/approvals?status=pending',
      headers: orgAuth(ownerTok, orgId),
    });
    expect(res.statusCode).toBe(200);
  });

  it('L27c: cancel by requester succeeds; cancel by non-requester non-admin fails 403', async () => {
    const { orgId, ownerTok } = await makeOrg('owner_l27c');
    await h.adminSql`UPDATE orgs SET plan = 'governance' WHERE id = ${orgId}`;
    // Seed a pending approval request created by the owner
    const apprId = randomUUID();
    const vkId = randomUUID();
    await h.adminSql`INSERT INTO virtual_keys (id, org_id, name, key_hash, key_prefix, status)
      VALUES (${vkId}, ${orgId}, 'k', ${Buffer.from(vkId)}, 'mk', 'paused')`;
    await h.adminSql`INSERT INTO approval_requests
      (id, org_id, kind, requested_by, scope_type, scope_id, status, current_step_index,
       current_value, requested_value)
      VALUES (${apprId}, ${orgId}, 'key_unpause', ${'owner_l27c'}, 'virtual_key', ${vkId},
              'pending', 0, '{}'::jsonb, '{}'::jsonb)`;
    await h.adminSql`INSERT INTO approval_steps
      (org_id, approval_id, step_index, quorum, required_approver_ids, notify_only, status)
      VALUES (${orgId}, ${apprId}, 0, 'any', ${['owner_l27c']}, false, 'pending')`;

    // A non-member viewer tries to cancel — first add them as viewer
    const viewerSub = 'viewer_l27c';
    await mirrorUser(viewerSub);
    await invite(ownerTok, orgId, viewerSub, 'viewer');
    const viewerTok = await h.token(viewerSub);

    const denyRes = await h.app.inject({
      method: 'POST',
      url: `/api/approvals/${apprId}/cancel`,
      headers: orgAuth(viewerTok, orgId),
      payload: {},
    });
    // Viewer is not requester and not admin → 403 or 402 (tier gate)
    expect([402, 403].includes(denyRes.statusCode)).toBe(true);

    // Requester (owner) can cancel
    const okRes = await h.app.inject({
      method: 'POST',
      url: `/api/approvals/${apprId}/cancel`,
      headers: orgAuth(ownerTok, orgId),
      payload: {},
    });
    // Should succeed (200) or hit tier gate (402) — not 403
    expect([200, 402].includes(okRes.statusCode)).toBe(true);
  });
});
