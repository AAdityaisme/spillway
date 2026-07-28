import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeTestApp, type TestHarness } from '../../test/helpers/app.js';

/** Regression tests for the confirmed red-team findings on M1/M2-Phase-A. */
describe('red-team fixes', () => {
  let h: TestHarness;
  beforeEach(async () => {
    h = await makeTestApp();
  });
  afterEach(async () => {
    await h.close();
  });

  async function setup(): Promise<{ owner: string; orgId: string }> {
    const owner = await h.token('user_owner');
    const r = await h.app.inject({
      method: 'POST',
      url: '/api/orgs',
      headers: { authorization: `Bearer ${owner}` },
      payload: { name: 'A', slug: 'acme' },
    });
    return { owner, orgId: r.json<{ org: { id: string } }>().org.id };
  }
  async function addViewer(owner: string, orgId: string): Promise<string> {
    const tok = await h.token('user_viewer');
    await h.app.inject({
      method: 'GET',
      url: '/api/orgs',
      headers: { authorization: `Bearer ${tok}` },
    });
    await h.app.inject({
      method: 'POST',
      url: '/api/members',
      headers: { authorization: `Bearer ${owner}`, 'x-spillway-org': orgId },
      payload: { userId: 'user_viewer', role: 'viewer' },
    });
    return tok;
  }
  const auth = (t: string, o: string) => ({ authorization: `Bearer ${t}`, 'x-spillway-org': o });

  it('GET /provider-keys is admin-gated — viewer gets 403', async () => {
    const { owner, orgId } = await setup();
    const viewer = await addViewer(owner, orgId);
    await h.app.inject({
      method: 'POST',
      url: '/api/provider-keys',
      headers: auth(owner, orgId),
      payload: { provider: 'openai', label: 'k', apiKey: 'sk-test' },
    });
    expect(
      (
        await h.app.inject({
          method: 'GET',
          url: '/api/provider-keys',
          headers: auth(owner, orgId),
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await h.app.inject({
          method: 'GET',
          url: '/api/provider-keys',
          headers: auth(viewer, orgId),
        })
      ).statusCode,
    ).toBe(403);
  });

  it('rejects base_url on a non-compat provider (SSRF surface closed at the schema)', async () => {
    const { owner, orgId } = await setup();
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/provider-keys',
      headers: auth(owner, orgId),
      payload: {
        provider: 'openai',
        label: 'evil',
        apiKey: 'sk-x',
        baseUrl: 'https://169.254.169.254/latest',
      },
    });
    expect(res.statusCode).toBe(422);
  });

  it('malformed uuid path param → 422, not 500', async () => {
    const { owner, orgId } = await setup();
    const res = await h.app.inject({
      method: 'DELETE',
      url: '/api/provider-keys/not-a-uuid',
      headers: auth(owner, orgId),
    });
    expect(res.statusCode).toBe(422);
  });
});
