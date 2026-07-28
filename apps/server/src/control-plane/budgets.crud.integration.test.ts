import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { internalBus } from '@spillway/shared';
import { makeTestApp, type TestHarness } from '../../test/helpers/app.js';

/**
 * B6.1 budgets CRUD (17 §1; ADR-018/039). Entitlement gate (free → 402 tier_required), cross-org
 * scope_id re-check (ADR-032 H1), and post-commit org:mutated invalidation on every mutation.
 */
describe('budgets CRUD (B6.1)', () => {
  let h: TestHarness;
  beforeEach(async () => {
    h = await makeTestApp();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await h.close();
  });

  async function seed(plan = 'governance'): Promise<{ org: string; hdr: Record<string, string> }> {
    const tok = await h.token('user_x');
    const org = (
      await h.app.inject({
        method: 'POST',
        url: '/api/orgs',
        headers: { authorization: `Bearer ${tok}` },
        payload: { name: 'A', slug: 'org-a' },
      })
    ).json<{ org: { id: string } }>().org.id;
    await h.adminSql`UPDATE orgs SET plan = ${plan} WHERE id = ${org}`;
    return { org, hdr: { authorization: `Bearer ${tok}`, 'x-spillway-org': org } };
  }

  it('creates an org budget (governance) + lists it', async () => {
    const { org, hdr } = await seed();
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/budgets',
      headers: hdr,
      payload: { scopeType: 'org', scopeId: org, period: 'day', limitUsd: '100' },
    });
    expect(res.statusCode).toBe(201);
    const list = await h.app.inject({ method: 'GET', url: '/api/budgets', headers: hdr });
    expect(list.json<{ budgets: unknown[] }>().budgets).toHaveLength(1);
  });

  it('free plan → 402 tier_required', async () => {
    const { org, hdr } = await seed('free');
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/budgets',
      headers: hdr,
      payload: { scopeType: 'org', scopeId: org, period: 'day', limitUsd: '100' },
    });
    expect(res.statusCode).toBe(402);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('tier_required');
  });

  it('drops a cross-org team scope_id (ADR-032 H1)', async () => {
    const { hdr } = await seed();
    const otherOrg = randomUUID();
    const otherTeam = randomUUID();
    await h.adminSql`INSERT INTO orgs (id, name, slug) VALUES (${otherOrg}, 'B', ${'b-' + otherOrg.slice(0, 8)})`;
    await h.adminSql`INSERT INTO teams (id, org_id, name, slug) VALUES (${otherTeam}, ${otherOrg}, 't', 't')`;
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/budgets',
      headers: hdr,
      payload: { scopeType: 'team', scopeId: otherTeam, period: 'day', limitUsd: '100' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('validation_error');
  });

  it('a lowered limit emits org:mutated (invalidation)', async () => {
    const { org, hdr } = await seed();
    const id = (
      await h.app.inject({
        method: 'POST',
        url: '/api/budgets',
        headers: hdr,
        payload: { scopeType: 'org', scopeId: org, period: 'day', limitUsd: '100' },
      })
    ).json<{ budget: { id: string } }>().budget.id;
    const spy = vi.spyOn(internalBus, 'emit');
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/budgets/${id}`,
      headers: hdr,
      payload: { limitUsd: '10' },
    });
    expect(res.statusCode).toBe(200);
    expect(spy.mock.calls.some(([e]) => e === 'org:mutated')).toBe(true);
  });
});
