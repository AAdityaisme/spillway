import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { makeTestApp, type TestHarness } from '../../test/helpers/app.js';
import { withOrg } from '../db/tenancy.js';

describe('M1 keys, audit, RBAC', () => {
  let h: TestHarness;
  beforeEach(async () => {
    h = await makeTestApp();
  });
  afterEach(async () => {
    await h.close();
  });

  async function createOrg(token: string): Promise<string> {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/orgs',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'A', slug: 'org-a' },
    });
    return res.json<{ org: { id: string } }>().org.id;
  }

  it('reveals a virtual key plaintext exactly once', async () => {
    const tok = await h.token('user_x');
    const org = await createOrg(tok);
    const create = await h.app.inject({
      method: 'POST',
      url: '/api/virtual-keys',
      headers: { authorization: `Bearer ${tok}`, 'x-spillway-org': org },
      payload: { name: 'prod' },
    });
    expect(create.statusCode).toBe(201);
    expect(create.headers['cache-control']).toBe('no-store');
    const body = create.json<{ virtualKey: { key: string; keyPrefix: string } }>().virtualKey;
    expect(body.key).toMatch(/^mk-live-/);

    const list = await h.app.inject({
      method: 'GET',
      url: '/api/virtual-keys',
      headers: { authorization: `Bearer ${tok}`, 'x-spillway-org': org },
    });
    const listed = list.json<{ virtualKeys: Array<Record<string, unknown>> }>().virtualKeys;
    expect(listed).toHaveLength(1);
    expect(listed[0]).not.toHaveProperty('key');
    expect(listed[0]).not.toHaveProperty('keyHash');
    expect(listed[0]?.keyPrefix).toBe(body.keyPrefix);
  });

  it('rejects a virtual key referencing a team from another org (red-team H1)', async () => {
    const tok = await h.token('user_x');
    const orgA = await createOrg(tok);
    // Seed a second org + its team directly (bypass RLS). user_x is NOT a member of org B, and
    // the teams FK alone would accept teamB because Postgres RI bypasses RLS — the route must
    // reject it via an RLS-scoped ownership check.
    const orgB = randomUUID();
    const teamB = randomUUID();
    await h.adminSql`INSERT INTO orgs (id, name, slug) VALUES (${orgB}, 'B', 'org-b')`;
    await h.adminSql`INSERT INTO teams (id, org_id, name, slug) VALUES (${teamB}, ${orgB}, 'team-b', 'team-b')`;

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/virtual-keys',
      headers: { authorization: `Bearer ${tok}`, 'x-spillway-org': orgA },
      payload: { name: 'x', teamId: teamB },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('validation_error');
    // and NO key was created for org A
    const rows = await h.adminSql`SELECT 1 FROM virtual_keys WHERE org_id = ${orgA}`;
    expect(rows).toHaveLength(0);
  });

  it('writes an audit row for every mutation', async () => {
    const tok = await h.token('user_x');
    const org = await createOrg(tok);
    await h.app.inject({
      method: 'POST',
      url: '/api/provider-keys',
      headers: { authorization: `Bearer ${tok}`, 'x-spillway-org': org },
      payload: { provider: 'openai', label: 'k', apiKey: 'sk-x' },
    });
    const rows = await h.adminSql<{ action: string }[]>`
      select action from audit_log where org_id = ${org} order by id`;
    const actions = rows.map((r) => r.action);
    expect(actions).toContain('org.create');
    expect(actions).toContain('provider_key.create');
  });

  it('forbids UPDATE on audit_log via the app role (append-only)', async () => {
    const tok = await h.token('user_x');
    const org = await createOrg(tok);
    await expect(
      withOrg(h.db, org, (tx) =>
        tx.execute(sql`update audit_log set action = 'tampered' where org_id = ${org}`),
      ),
    ).rejects.toThrow();
  });

  it('enforces RBAC: a viewer cannot create provider keys', async () => {
    const tokX = await h.token('user_x');
    const tokY = await h.token('user_y');
    const org = await createOrg(tokX);
    // mirror Y into users so the invite FK resolves
    await h.app.inject({
      method: 'GET',
      url: '/api/orgs',
      headers: { authorization: `Bearer ${tokY}` },
    });
    const invite = await h.app.inject({
      method: 'POST',
      url: '/api/members',
      headers: { authorization: `Bearer ${tokX}`, 'x-spillway-org': org },
      payload: { userId: 'user_y', role: 'viewer' },
    });
    expect(invite.statusCode).toBe(201);

    const denied = await h.app.inject({
      method: 'POST',
      url: '/api/provider-keys',
      headers: { authorization: `Bearer ${tokY}`, 'x-spillway-org': org },
      payload: { provider: 'openai', label: 'k', apiKey: 'sk-y' },
    });
    expect(denied.statusCode).toBe(403);
  });

  it('protects the last owner (cannot self-demote)', async () => {
    const tok = await h.token('user_x');
    const org = await createOrg(tok);
    const res = await h.app.inject({
      method: 'PATCH',
      url: '/api/members/user_x',
      headers: { authorization: `Bearer ${tok}`, 'x-spillway-org': org },
      payload: { role: 'admin' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('rejects an SSRF base_url on openai_compat provider keys', async () => {
    const tok = await h.token('user_x');
    const org = await createOrg(tok);
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/provider-keys',
      headers: { authorization: `Bearer ${tok}`, 'x-spillway-org': org },
      payload: {
        provider: 'openai_compat',
        label: 'evil',
        apiKey: 'sk-x',
        baseUrl: 'https://169.254.169.254/latest',
      },
    });
    expect(res.statusCode).toBe(422);
  });
});
