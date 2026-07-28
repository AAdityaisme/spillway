import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { makeTestApp, type TestHarness } from '../../test/helpers/app.js';

/**
 * DECISION lock (audit 2026-07-08): GET on tier-gated resources is entitlement-FREE by design.
 * A free-plan org must still see what it configured before a downgrade (and the 402 upsell path
 * needs the list views); only writes are tier-gated. If a future change gates the reads, this
 * suite fails and the decision gets re-made consciously instead of drifting.
 */

describe('reads are entitlement-free on gated resources', () => {
  let h: TestHarness;
  let token: string;
  let orgId: string;

  beforeAll(async () => {
    h = await makeTestApp();
    token = await h.token('user_reader');
    const r = await h.app.inject({
      method: 'POST',
      url: '/api/orgs',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Free Org', slug: 'free-org' },
    });
    // Same hardening as the governance seed (472f37c): surface the real failure status instead of
    // crashing the whole suite on an undefined deref when org-create fails under load.
    expect(r.statusCode, `org create failed: ${r.body}`).toBe(201);
    orgId = r.json<{ org: { id: string } }>().org.id;
    // stays on the free plan — no entitlements at all
  });

  afterAll(async () => {
    await h.close();
  });

  const gatedLists = [
    ['/api/alerts', 'alerts', 0],
    ['/api/automation-rules', 'automationRules', 0],
    // org creation seeds the org-wide default approval policy (§2.10), so this list is never empty.
    ['/api/approval-policies', 'approvalPolicies', 1],
    ['/api/approvals', 'approvals', 0],
  ] as const;

  for (const [url, key, expectedLen] of gatedLists) {
    it(`GET ${url} is entitlement-free on the free plan (200, not 402)`, async () => {
      const res = await h.app.inject({
        method: 'GET',
        url,
        headers: { authorization: `Bearer ${token}`, 'x-spillway-org': orgId },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json<Record<string, unknown[]>>()[key]).toHaveLength(expectedLen);
    });
  }

  it('the matching POST stays tier-gated (402) — the asymmetry is the design', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/alerts',
      headers: { authorization: `Bearer ${token}`, 'x-spillway-org': orgId },
      payload: { name: 'x', kind: 'budget_threshold', config: {}, channels: [] },
    });
    expect(res.statusCode).toBe(402);
  });
});
