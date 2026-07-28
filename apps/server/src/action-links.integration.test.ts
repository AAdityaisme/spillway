import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { makeTestApp, type TestHarness } from '../test/helpers/app.js';
import { signActionToken } from './services/alerts/action-token.js';

/**
 * B7.4b signed action links (Part II §18 §6): a valid HMAC token pauses the key (idempotent, source=
 * action_token); a tampered/expired token is rejected 401 without touching state.
 */
describe('signed action links (B7.4b)', () => {
  let h: TestHarness;
  const orgId = randomUUID();
  let vkId: string;

  beforeEach(async () => {
    h = await makeTestApp();
    await h.adminSql`INSERT INTO orgs (id, name, slug) VALUES (${orgId}, 'A', ${'a-' + orgId.slice(0, 8)})`;
    vkId = randomUUID();
    await h.adminSql`INSERT INTO virtual_keys (id, org_id, name, key_hash, key_prefix, status)
      VALUES (${vkId}, ${orgId}, 'k', ${Buffer.from(vkId)}, 'mk', 'active')`;
  });
  afterEach(async () => {
    await h.close();
  });

  const mint = (over: Record<string, unknown> = {}) =>
    signActionToken(
      { action: 'pause_key', orgId, refId: vkId, exp: Date.now() + 3_600_000, ...over },
      h.config.SPILLWAY_ACTION_TOKEN_SECRET!,
    );

  it('a valid token pauses the key', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/action-links/approval/${mint()}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ status: string }>().status).toBe('paused');
    const key = await h.adminSql<
      { status: string }[]
    >`SELECT status FROM virtual_keys WHERE id = ${vkId}`;
    expect(key[0]!.status).toBe('paused');
  });

  it('a tampered token → 401, key untouched', async () => {
    const token = mint();
    const tampered = token.slice(0, -3) + 'xyz';
    const res = await h.app.inject({
      method: 'GET',
      url: `/action-links/approval/${tampered}`,
    });
    expect(res.statusCode).toBe(401);
    const key = await h.adminSql<
      { status: string }[]
    >`SELECT status FROM virtual_keys WHERE id = ${vkId}`;
    expect(key[0]!.status).toBe('active'); // unchanged
  });

  it('an expired token → 401', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/action-links/approval/${mint({ exp: Date.now() - 1000 })}`,
    });
    expect(res.statusCode).toBe(401);
  });
});
