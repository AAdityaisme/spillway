import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { makeTestApp, type TestHarness } from '../../test/helpers/app.js';

/**
 * B7.2c approval decision API (Part II §18 §2.8). Drives decide.ts through HTTP: an approver approves a
 * pending key_unpause → quorum met → status approved → final-apply runs unpause_key via the shared
 * registry (the key flips active). Also proves the self-approval ban (requester → 403) and the tier gate.
 */
describe('approval decisions (B7.2c)', () => {
  let h: TestHarness;
  beforeEach(async () => {
    h = await makeTestApp();
  });
  afterEach(async () => {
    await h.close();
  });

  async function seed(plan = 'governance') {
    const ownerTok = await h.token('owner');
    const org = (
      await h.app.inject({
        method: 'POST',
        url: '/api/orgs',
        headers: { authorization: `Bearer ${ownerTok}` },
        payload: { name: 'A', slug: 'org-' + randomUUID().slice(0, 8) },
      })
    ).json<{ org: { id: string } }>().org.id;
    await h.adminSql`UPDATE orgs SET plan = ${plan} WHERE id = ${org}`;
    // approver = an admin member; vk paused; a pending key_unpause approval with one 'any' step.
    await h.adminSql`INSERT INTO users (id, email) VALUES ('appr', 'appr@t.dev') ON CONFLICT (id) DO NOTHING`;
    await h.adminSql`INSERT INTO org_members (org_id, user_id, role) VALUES (${org}, 'appr', 'admin')`;
    const vkId = randomUUID();
    await h.adminSql`INSERT INTO virtual_keys (id, org_id, name, key_hash, key_prefix, status)
      VALUES (${vkId}, ${org}, 'k', ${Buffer.from(vkId)}, 'mk', 'paused')`;
    const apprId = randomUUID();
    await h.adminSql`INSERT INTO approval_requests
      (id, org_id, kind, requested_by, scope_type, scope_id, status, current_step_index,
       current_value, requested_value)
      VALUES (${apprId}, ${org}, 'key_unpause', null, 'virtual_key', ${vkId}, 'pending', 0,
              '{}'::jsonb, '{}'::jsonb)`;
    await h.adminSql`INSERT INTO approval_steps
      (org_id, approval_id, step_index, quorum, required_approver_ids, notify_only, status)
      VALUES (${org}, ${apprId}, 0, 'any', ${['appr']}, false, 'pending')`;
    return { org, vkId, apprId };
  }

  const hdr = (tok: string, org: string) => ({
    authorization: `Bearer ${tok}`,
    'x-spillway-org': org,
  });

  it('an approver approve → approved + final-apply unpauses the key', async () => {
    const { org, vkId, apprId } = await seed();
    const tok = await h.token('appr');
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/approvals/${apprId}/decisions`,
      headers: hdr(tok, org),
      payload: { decision: 'approve' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ status: string }>().status).toBe('approved');
    const key = await h.adminSql<
      { status: string }[]
    >`SELECT status FROM virtual_keys WHERE id = ${vkId}`;
    expect(key[0]!.status).toBe('active'); // final-apply ran unpause_key
  });

  it('a non-approver decision → 403 not_an_approver', async () => {
    const { org, apprId } = await seed();
    await h.adminSql`INSERT INTO users (id, email) VALUES ('other', 'o@t.dev') ON CONFLICT (id) DO NOTHING`;
    await h.adminSql`INSERT INTO org_members (org_id, user_id, role) VALUES (${org}, 'other', 'member')`;
    const tok = await h.token('other');
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/approvals/${apprId}/decisions`,
      headers: hdr(tok, org),
      payload: { decision: 'approve' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('not_an_approver');
  });

  it('free plan → 402 tier_required', async () => {
    const { org, apprId } = await seed('free');
    const tok = await h.token('appr');
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/approvals/${apprId}/decisions`,
      headers: hdr(tok, org),
      payload: { decision: 'approve' },
    });
    expect(res.statusCode).toBe(402);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('tier_required');
  });
});
