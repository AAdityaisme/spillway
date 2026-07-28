import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import { internalBus } from '@spillway/shared';
import { makeTestApp, type TestHarness } from '../../test/helpers/app.js';

/**
 * B1.2 narrowing-write invalidation lint (17 §3.3). EVERY control-plane mutation that changes a
 * PolicyBundle input MUST emit a bundle event (`org:mutated` | `virtual-key:mutated`) post-commit —
 * otherwise a lowered limit / paused key / deleted provider key stays bypassable for the full 30s
 * cache TTL. This test invokes each bundle-mutating route and asserts ≥1 bundle emit.
 *
 * MAINTENANCE: when B6/B7 add budgets/aliases/rules/policies/automation CRUD, add a case here.
 * A new mutation handler that forgets the emit fails this test.
 */
describe('narrowing-write invalidation lint (17 §3.3, B1.2)', () => {
  let h: TestHarness;
  beforeEach(async () => {
    h = await makeTestApp();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await h.close();
  });

  async function seed(): Promise<{ hdr: Record<string, string>; org: string }> {
    const tok = await h.token('user_x');
    const org = (
      await h.app.inject({
        method: 'POST',
        url: '/api/orgs',
        headers: { authorization: `Bearer ${tok}` },
        payload: { name: 'A', slug: 'org-a' },
      })
    ).json<{ org: { id: string } }>().org.id;
    // governance plan so every governance-CRUD mutation is entitled (not 402) in the lint.
    await h.adminSql`UPDATE orgs SET plan = 'governance' WHERE id = ${org}`;
    return { hdr: { authorization: `Bearer ${tok}`, 'x-spillway-org': org }, org };
  }

  const bundleEmits = (spy: MockInstance): number =>
    spy.mock.calls.filter(([e]) => e === 'org:mutated' || e === 'virtual-key:mutated').length;

  it('POST /virtual-keys emits a bundle event', async () => {
    const { hdr } = await seed();
    const spy = vi.spyOn(internalBus, 'emit');
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/virtual-keys',
      headers: hdr,
      payload: { name: 'k' },
    });
    expect(res.statusCode).toBe(201);
    expect(bundleEmits(spy)).toBeGreaterThanOrEqual(1);
  });

  it('PATCH /virtual-keys/:id emits a bundle event', async () => {
    const { hdr } = await seed();
    const id = (
      await h.app.inject({
        method: 'POST',
        url: '/api/virtual-keys',
        headers: hdr,
        payload: { name: 'k' },
      })
    ).json<{ virtualKey: { id: string } }>().virtualKey.id;
    const spy = vi.spyOn(internalBus, 'emit');
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/virtual-keys/${id}`,
      headers: hdr,
      payload: { status: 'paused' },
    });
    expect(res.statusCode).toBe(200);
    expect(bundleEmits(spy)).toBeGreaterThanOrEqual(1);
  });

  it('POST /provider-keys emits a bundle event', async () => {
    const { hdr } = await seed();
    const spy = vi.spyOn(internalBus, 'emit');
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/provider-keys',
      headers: hdr,
      payload: { provider: 'openai', label: 'o', apiKey: 'sk-test-123' },
    });
    expect(res.statusCode).toBe(201);
    expect(bundleEmits(spy)).toBeGreaterThanOrEqual(1);
  });

  it('DELETE /provider-keys/:id emits a bundle event', async () => {
    const { hdr } = await seed();
    const id = (
      await h.app.inject({
        method: 'POST',
        url: '/api/provider-keys',
        headers: hdr,
        payload: { provider: 'openai', label: 'o', apiKey: 'sk-test-123' },
      })
    ).json<{ providerKey: { id: string } }>().providerKey.id;
    const spy = vi.spyOn(internalBus, 'emit');
    const res = await h.app.inject({
      method: 'DELETE',
      url: `/api/provider-keys/${id}`,
      headers: hdr,
    });
    expect(res.statusCode).toBe(204);
    expect(bundleEmits(spy)).toBeGreaterThanOrEqual(1);
  });

  it('POST /budgets emits a bundle event', async () => {
    const { hdr, org } = await seed();
    const spy = vi.spyOn(internalBus, 'emit');
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/budgets',
      headers: hdr,
      payload: { scopeType: 'org', scopeId: org, period: 'day', limitUsd: '100' },
    });
    expect(res.statusCode).toBe(201);
    expect(bundleEmits(spy)).toBeGreaterThanOrEqual(1);
  });

  it('POST /aliases emits a bundle event', async () => {
    const { hdr } = await seed();
    const spy = vi.spyOn(internalBus, 'emit');
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/aliases',
      headers: hdr,
      payload: { alias: 'fast', targets: [{ provider: 'openai', model: 'gpt-4o-mini' }] },
    });
    expect(res.statusCode).toBe(201);
    expect(bundleEmits(spy)).toBeGreaterThanOrEqual(1);
  });

  it('POST /routing-rules emits a bundle event', async () => {
    const { hdr } = await seed();
    const spy = vi.spyOn(internalBus, 'emit');
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/routing-rules',
      headers: hdr,
      payload: {
        priority: 10,
        match: {},
        action: { type: 'rewrite_model', to: { provider: 'openai', model: 'gpt-4o-mini' } },
      },
    });
    expect(res.statusCode).toBe(201);
    expect(bundleEmits(spy)).toBeGreaterThanOrEqual(1);
  });

  it('POST /policies emits a bundle event', async () => {
    const { hdr } = await seed();
    const spy = vi.spyOn(internalBus, 'emit');
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/policies',
      headers: hdr,
      payload: { name: 'p', effect: 'deny', reason: 'r', match: { models: ['gpt-5.5'] } },
    });
    expect(res.statusCode).toBe(201);
    expect(bundleEmits(spy)).toBeGreaterThanOrEqual(1);
  });

  it('PATCH + DELETE /budgets/:id each emit a bundle event', async () => {
    const { hdr, org } = await seed();
    const id = (
      await h.app.inject({
        method: 'POST',
        url: '/api/budgets',
        headers: hdr,
        payload: { scopeType: 'org', scopeId: org, period: 'day', limitUsd: '100' },
      })
    ).json<{ budget: { id: string } }>().budget.id;
    const patchSpy = vi.spyOn(internalBus, 'emit');
    const patch = await h.app.inject({
      method: 'PATCH',
      url: `/api/budgets/${id}`,
      headers: hdr,
      payload: { limitUsd: '10' },
    });
    expect(patch.statusCode).toBe(200);
    expect(bundleEmits(patchSpy)).toBeGreaterThanOrEqual(1);
    patchSpy.mockRestore();
    const delSpy = vi.spyOn(internalBus, 'emit');
    const del = await h.app.inject({ method: 'DELETE', url: `/api/budgets/${id}`, headers: hdr });
    expect(del.statusCode).toBe(204);
    expect(bundleEmits(delSpy)).toBeGreaterThanOrEqual(1);
  });
});
