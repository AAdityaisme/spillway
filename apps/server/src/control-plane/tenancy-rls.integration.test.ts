import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeTestApp, type TestHarness } from '../../test/helpers/app.js';
import { providerKeys } from '../db/schema.js';
import { withOrg } from '../db/tenancy.js';

describe('M1 tenancy + RLS isolation', () => {
  let h: TestHarness;
  beforeEach(async () => {
    h = await makeTestApp();
  });
  afterEach(async () => {
    await h.close();
  });

  async function createOrg(token: string, name: string, slug: string): Promise<string> {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/orgs',
      headers: { authorization: `Bearer ${token}` },
      payload: { name, slug },
    });
    expect(res.statusCode).toBe(201);
    return res.json<{ org: { id: string } }>().org.id;
  }

  function makeProviderKey(token: string, orgId: string) {
    return h.app.inject({
      method: 'POST',
      url: '/api/provider-keys',
      headers: { authorization: `Bearer ${token}`, 'x-spillway-org': orgId },
      payload: { provider: 'openai', label: 'k', apiKey: 'sk-abc123' },
    });
  }

  it('rejects unauthenticated + malformed-token requests with 401', async () => {
    expect((await h.app.inject({ method: 'GET', url: '/api/orgs' })).statusCode).toBe(401);
    const bad = await h.app.inject({
      method: 'GET',
      url: '/api/orgs',
      headers: { authorization: 'Bearer not.a.jwt' },
    });
    expect(bad.statusCode).toBe(401);
  });

  it('creates an org with the caller as owner', async () => {
    const tok = await h.token('user_x');
    await createOrg(tok, 'Acme', 'acme');
    const list = await h.app.inject({
      method: 'GET',
      url: '/api/orgs',
      headers: { authorization: `Bearer ${tok}` },
    });
    const orgs = list.json<{ orgs: Array<{ role: string }> }>().orgs;
    expect(orgs).toHaveLength(1);
    expect(orgs[0]?.role).toBe('owner');
  });

  it('isolates data across tenants and 403s cross-org access', async () => {
    const tokX = await h.token('user_x');
    const tokY = await h.token('user_y');
    const orgA = await createOrg(tokX, 'A', 'org-a');
    const orgB = await createOrg(tokY, 'B', 'org-b');

    expect((await makeProviderKey(tokX, orgA)).statusCode).toBe(201);
    expect((await makeProviderKey(tokY, orgB)).statusCode).toBe(201);

    const xList = await h.app.inject({
      method: 'GET',
      url: '/api/provider-keys',
      headers: { authorization: `Bearer ${tokX}`, 'x-spillway-org': orgA },
    });
    expect(xList.json<{ providerKeys: unknown[] }>().providerKeys).toHaveLength(1);

    const cross = await h.app.inject({
      method: 'GET',
      url: '/api/provider-keys',
      headers: { authorization: `Bearer ${tokX}`, 'x-spillway-org': orgB },
    });
    expect(cross.statusCode).toBe(403);

    const all = await h.adminSql<{ c: number }[]>`select count(*)::int c from provider_keys`;
    expect(all[0]?.c).toBe(2); // both keys really exist; RLS just hid B's from X
  });

  it('denies org-scoped reads outside withOrg (GUC deny-by-default)', async () => {
    const tok = await h.token('user_x');
    const orgA = await createOrg(tok, 'A', 'org-a');
    await makeProviderKey(tok, orgA);

    const leaked = await h.db.select().from(providerKeys); // no GUC armed
    expect(leaked).toHaveLength(0);

    const scoped = await withOrg(h.db, orgA, (tx) => tx.select().from(providerKeys));
    expect(scoped).toHaveLength(1);
  });

  it('400s a scoped route when the org header is missing', async () => {
    const tok = await h.token('user_x');
    await createOrg(tok, 'A', 'org-a');
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/provider-keys',
      headers: { authorization: `Bearer ${tok}` },
    });
    expect(res.statusCode).toBe(400);
  });
});
