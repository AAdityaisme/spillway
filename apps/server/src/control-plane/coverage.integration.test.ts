import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeTestApp, type TestHarness } from '../../test/helpers/app.js';

/**
 * Coverage for the route groups the first two integration files left untested
 * (admin-api-keys, teams, org-settings, member removal) + the RBAC-on-read and
 * member-scoping fixes from the M1 audit.
 */
describe('M1 route coverage + RBAC reads', () => {
  let h: TestHarness;
  beforeEach(async () => {
    h = await makeTestApp();
  });
  afterEach(async () => {
    await h.close();
  });

  async function setupOrg(): Promise<{ owner: string; orgId: string }> {
    const owner = await h.token('user_owner');
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/orgs',
      headers: { authorization: `Bearer ${owner}` },
      payload: { name: 'Acme', slug: 'acme' },
    });
    return { owner, orgId: res.json<{ org: { id: string } }>().org.id };
  }

  async function addMember(
    owner: string,
    orgId: string,
    sub: string,
    role: string,
  ): Promise<string> {
    const tok = await h.token(sub);
    // mirror the invitee into users so the FK resolves
    await h.app.inject({
      method: 'GET',
      url: '/api/orgs',
      headers: { authorization: `Bearer ${tok}` },
    });
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/members',
      headers: { authorization: `Bearer ${owner}`, 'x-spillway-org': orgId },
      payload: { userId: sub, role },
    });
    expect(res.statusCode).toBe(201);
    return tok;
  }

  const auth = (tok: string, orgId: string) => ({
    authorization: `Bearer ${tok}`,
    'x-spillway-org': orgId,
  });

  // ── admin-api-keys (highest-privilege, was fully untested) ──
  it('admin-api-keys: owner-only create reveals plaintext once; viewer GET is 403', async () => {
    const { owner, orgId } = await setupOrg();
    const adminTok = await addMember(owner, orgId, 'user_admin', 'admin');
    const viewerTok = await addMember(owner, orgId, 'user_viewer', 'viewer');

    // owner creates → 201, plaintext once + no-store
    const create = await h.app.inject({
      method: 'POST',
      url: '/api/admin-api-keys',
      headers: auth(owner, orgId),
      payload: { name: 'ci-key', role: 'admin' },
    });
    expect(create.statusCode).toBe(201);
    expect(create.headers['cache-control']).toBe('no-store');
    const body = create.json<{ adminApiKey: { key: string } }>().adminApiKey;
    expect(body.key).toMatch(/^mk-admin-/);

    // admin (not owner) cannot create → 403 (owner-only)
    const adminCreate = await h.app.inject({
      method: 'POST',
      url: '/api/admin-api-keys',
      headers: auth(adminTok, orgId),
      payload: { name: 'x', role: 'admin' },
    });
    expect(adminCreate.statusCode).toBe(403);

    // viewer GET → 403 (the audit-fix gate); hash never present
    const viewerGet = await h.app.inject({
      method: 'GET',
      url: '/api/admin-api-keys',
      headers: auth(viewerTok, orgId),
    });
    expect(viewerGet.statusCode).toBe(403);

    const ownerGet = await h.app.inject({
      method: 'GET',
      url: '/api/admin-api-keys',
      headers: auth(owner, orgId),
    });
    const listed = ownerGet.json<{ adminApiKeys: Array<Record<string, unknown>> }>().adminApiKeys;
    expect(listed).toHaveLength(1);
    expect(listed[0]).not.toHaveProperty('key');
    expect(listed[0]).not.toHaveProperty('keyHash');
  });

  // ── teams CRUD + RBAC ──
  it('teams: admin CRUD works, viewer cannot mutate', async () => {
    const { owner, orgId } = await setupOrg();
    const viewerTok = await addMember(owner, orgId, 'user_v', 'viewer');

    const create = await h.app.inject({
      method: 'POST',
      url: '/api/teams',
      headers: auth(owner, orgId),
      payload: { name: 'Eng', slug: 'eng' },
    });
    expect(create.statusCode).toBe(201);
    const teamId = create.json<{ team: { id: string } }>().team.id;

    const viewerCreate = await h.app.inject({
      method: 'POST',
      url: '/api/teams',
      headers: auth(viewerTok, orgId),
      payload: { name: 'X', slug: 'x' },
    });
    expect(viewerCreate.statusCode).toBe(403);

    const patch = await h.app.inject({
      method: 'PATCH',
      url: `/api/teams/${teamId}`,
      headers: auth(owner, orgId),
      payload: { name: 'Engineering' },
    });
    expect(patch.statusCode).toBe(200);

    const del = await h.app.inject({
      method: 'DELETE',
      url: `/api/teams/${teamId}`,
      headers: auth(owner, orgId),
    });
    expect(del.statusCode).toBe(204);

    const list = await h.app.inject({
      method: 'GET',
      url: '/api/teams',
      headers: auth(owner, orgId),
    });
    expect(list.json<{ teams: unknown[] }>().teams).toHaveLength(0);
  });

  // ── org-settings ──
  it('org-settings: GET returns org, admin PATCH updates settings', async () => {
    const { owner, orgId } = await setupOrg();
    const get = await h.app.inject({ method: 'GET', url: '/api/org', headers: auth(owner, orgId) });
    expect(get.statusCode).toBe(200);
    expect(get.json<{ org: { slug: string } }>().org.slug).toBe('acme');

    const patch = await h.app.inject({
      method: 'PATCH',
      url: '/api/org',
      headers: auth(owner, orgId),
      payload: { bodyLoggingEnabled: true, bodyRetentionDays: 14 },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json<{ org: { bodyLoggingEnabled: boolean } }>().org.bodyLoggingEnabled).toBe(
      true,
    );
  });

  // ── members: removal + last-owner invariant on DELETE ──
  it('members: GET lists, DELETE removes, last-owner removal is 409', async () => {
    const { owner, orgId } = await setupOrg();
    await addMember(owner, orgId, 'user_m', 'member');

    const list = await h.app.inject({
      method: 'GET',
      url: '/api/members',
      headers: auth(owner, orgId),
    });
    expect(list.json<{ members: unknown[] }>().members).toHaveLength(2);

    const del = await h.app.inject({
      method: 'DELETE',
      url: '/api/members/user_m',
      headers: auth(owner, orgId),
    });
    expect(del.statusCode).toBe(204);

    // removing the sole owner → 409 last_owner
    const removeOwner = await h.app.inject({
      method: 'DELETE',
      url: '/api/members/user_owner',
      headers: auth(owner, orgId),
    });
    expect(removeOwner.statusCode).toBe(409);
  });

  // ── virtual-keys: member-scoping fix + revoke ──
  it('virtual-keys: members see only their own keys; PATCH revokes', async () => {
    const { owner, orgId } = await setupOrg();
    const memberTok = await addMember(owner, orgId, 'user_mem', 'member');

    const mk = (tok: string, name: string) =>
      h.app.inject({
        method: 'POST',
        url: '/api/virtual-keys',
        headers: auth(tok, orgId),
        payload: { name },
      });
    expect((await mk(owner, 'owners')).statusCode).toBe(201);
    const memKey = await mk(memberTok, 'mine');
    const memKeyId = memKey.json<{ virtualKey: { id: string } }>().virtualKey.id;

    // member sees only their own (1), owner sees both (2)
    const memList = await h.app.inject({
      method: 'GET',
      url: '/api/virtual-keys',
      headers: auth(memberTok, orgId),
    });
    expect(memList.json<{ virtualKeys: unknown[] }>().virtualKeys).toHaveLength(1);
    const ownerList = await h.app.inject({
      method: 'GET',
      url: '/api/virtual-keys',
      headers: auth(owner, orgId),
    });
    expect(ownerList.json<{ virtualKeys: unknown[] }>().virtualKeys).toHaveLength(2);

    const revoke = await h.app.inject({
      method: 'PATCH',
      url: `/api/virtual-keys/${memKeyId}`,
      headers: auth(owner, orgId),
      payload: { status: 'revoked' },
    });
    expect(revoke.statusCode).toBe(200);
    expect(revoke.json<{ virtualKey: { status: string } }>().virtualKey.status).toBe('revoked');
  });

  // ── audit coverage breadth (was only 2 actions) ──
  it('audit_log captures the breadth of mutation actions', async () => {
    const { owner, orgId } = await setupOrg();
    await h.app.inject({
      method: 'POST',
      url: '/api/teams',
      headers: auth(owner, orgId),
      payload: { name: 'T', slug: 't' },
    });
    await h.app.inject({
      method: 'POST',
      url: '/api/admin-api-keys',
      headers: auth(owner, orgId),
      payload: { name: 'k', role: 'admin' },
    });
    await h.app.inject({
      method: 'PATCH',
      url: '/api/org',
      headers: auth(owner, orgId),
      payload: { bodyRetentionDays: 7 },
    });

    const rows = await h.adminSql<{ action: string }[]>`
      select action from audit_log where org_id = ${orgId}`;
    const actions = new Set(rows.map((r) => r.action));
    for (const a of ['org.create', 'team.create', 'admin_api_key.create', 'org.update']) {
      expect(actions.has(a), `missing audit action ${a}`).toBe(true);
    }
  });
});
