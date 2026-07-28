import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { makeTestApp, type TestHarness } from '../../test/helpers/app.js';

/**
 * Dashboard KPI read API (04-api-contracts §3.15; 09-frontend §3.4). Overview tiles (spend from the
 * org-scope counter, error-rate + top-models from requests, budget utilization), spend timeseries
 * (flat + grouped), and model mix. Money is exact; percentages 2dp. Seeds via adminSql (bypasses RLS).
 */
describe('KPI read API (M4 §3.15)', () => {
  let h: TestHarness;
  beforeEach(async () => {
    h = await makeTestApp();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await h.close();
  });

  async function seedOrg(name = 'Acme') {
    const tok = await h.token('owner_u');
    const org = (
      await h.app.inject({
        method: 'POST',
        url: '/api/orgs',
        headers: { authorization: `Bearer ${tok}` },
        payload: { name, slug: 'org-a' },
      })
    ).json<{ org: { id: string } }>().org.id;
    return { org, hdr: { authorization: `Bearer ${tok}`, 'x-spillway-org': org } };
  }

  async function insertReq(
    org: string,
    o: {
      createdAt: string;
      status?: string;
      provider?: string;
      model?: string | null;
      costUsd?: string | null;
      inputTokens?: number;
      outputTokens?: number;
    },
  ): Promise<void> {
    await h.adminSql`
      INSERT INTO requests (id, org_id, provider, model, endpoint, status, cost_usd, input_tokens, output_tokens, created_at)
      VALUES (${randomUUID()}, ${org}, ${o.provider ?? 'openai'}, ${o.model ?? 'gpt-4o'},
              'chat_completions', ${o.status ?? 'ok'}, ${o.costUsd ?? null},
              ${o.inputTokens ?? null}, ${o.outputTokens ?? null}, ${o.createdAt}::timestamptz)`;
  }

  async function insertCounter(
    org: string,
    scopeType: string,
    scopeId: string,
    periodKey: string,
    spent: string,
    requestCount = 0,
    blockedCount = 0,
  ): Promise<void> {
    await h.adminSql`
      INSERT INTO spend_counters (org_id, scope_type, scope_id, period_key, spent_usd, request_count, blocked_count)
      VALUES (${org}, ${scopeType}, ${scopeId}, ${periodKey}, ${spent}, ${requestCount}, ${blockedCount})`;
  }

  // ── overview ──────────────────────────────────────────────────────────────

  it('overview: tiles from counter, error-rate + top-models from requests, budget utilization', async () => {
    const { org, hdr } = await seedOrg('Acme');
    // org-scope counters: current + previous month
    await insertCounter(org, 'org', org, '2026-06', '10.000000', 8, 2);
    await insertCounter(org, 'org', org, '2026-05', '4.000000', 3, 0);
    // requests in June: 7 ok (5 gpt @1, 2 claude @2.5) + 1 error → sum cost 10, error-rate 1/8
    for (let i = 0; i < 5; i++)
      await insertReq(org, {
        createdAt: '2026-06-15T12:00:00Z',
        model: 'gpt-4o',
        costUsd: '1.000000',
      });
    for (let i = 0; i < 2; i++)
      await insertReq(org, {
        createdAt: '2026-06-15T12:00:00Z',
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        costUsd: '2.500000',
      });
    await insertReq(org, {
      createdAt: '2026-06-15T12:00:00Z',
      status: 'error',
      model: 'gpt-4o',
      costUsd: null,
    });
    // an org budget (month, enforce) — seeded directly (API create needs governance plan)
    await h.adminSql`
      INSERT INTO budgets (id, org_id, scope_type, scope_id, period, limit_usd, mode)
      VALUES (${randomUUID()}, ${org}, 'org', ${org}, 'month', '100.000000', 'enforce')`;

    const res = await h.app.inject({
      method: 'GET',
      url: '/api/kpi/overview?period=2026-06',
      headers: hdr,
    });
    expect(res.statusCode).toBe(200);
    const o = res.json<{
      period: string;
      spendUsd: string;
      spendUsdPrevPeriod: string;
      requestCount: number;
      blockedCount: number;
      errorRatePct: number;
      topModels: Array<{
        model: string;
        spendUsd: string;
        requestCount: number;
        pctOfTotal: number;
      }>;
      budgetUtilization: Array<{
        scopeName: string;
        pct: number;
        limitUsd: string;
        spentUsd: string;
      }>;
    }>();
    expect(o.spendUsd).toBe('10.000000');
    expect(o.spendUsdPrevPeriod).toBe('4.000000');
    expect(o.requestCount).toBe(8);
    expect(o.blockedCount).toBe(2);
    expect(o.errorRatePct).toBe(12.5); // 1 error / (7 ok + 1 error)
    // top models: gpt (5×1=5, 6 requests incl the error) + claude (2×2.5=5), total 10 → 50% each
    const gpt = o.topModels.find((m) => m.model === 'gpt-4o')!;
    const claude = o.topModels.find((m) => m.model === 'claude-sonnet-5')!;
    expect(gpt.spendUsd).toBe('5.000000');
    expect(gpt.requestCount).toBe(6);
    expect(gpt.pctOfTotal).toBe(50);
    expect(claude.pctOfTotal).toBe(50);
    // budget utilization: org budget, spent 10 (from month counter) / limit 100 = 10%
    expect(o.budgetUtilization).toHaveLength(1);
    expect(o.budgetUtilization[0]!.scopeName).toBe('Acme');
    expect(o.budgetUtilization[0]!.pct).toBe(10);
    expect(o.budgetUtilization[0]!.limitUsd).toBe('100.000000');
    expect(o.budgetUtilization[0]!.spentUsd).toBe('10.000000');
  });

  it('overview: fresh org → zeros, defaults to current month', async () => {
    const { hdr } = await seedOrg();
    const res = await h.app.inject({ method: 'GET', url: '/api/kpi/overview', headers: hdr });
    expect(res.statusCode).toBe(200);
    const o = res.json<{
      period: string;
      spendUsd: string;
      requestCount: number;
      topModels: unknown[];
    }>();
    expect(o.period).toMatch(/^\d{4}-\d{2}$/);
    expect(o.spendUsd).toBe('0.000000');
    expect(o.requestCount).toBe(0);
    expect(o.topModels).toHaveLength(0);
  });

  it('overview: malformed period → 400', async () => {
    const { hdr } = await seedOrg();
    for (const period of ['2026-6', '2026-13', '2026-00']) {
      const res = await h.app.inject({
        method: 'GET',
        url: `/api/kpi/overview?period=${period}`,
        headers: hdr,
      });
      expect(res.statusCode, `period=${period}`).toBe(400);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('validation_error');
    }
  });

  // ── spend timeseries ────────────────────────────────────────────────────────

  it('spend-timeseries (none): daily points, in date order, exact sums', async () => {
    const { org, hdr } = await seedOrg();
    await insertReq(org, { createdAt: '2026-06-01T04:00:00Z', costUsd: '1.000000' });
    await insertReq(org, { createdAt: '2026-06-01T20:00:00Z', costUsd: '1.000000' });
    await insertReq(org, { createdAt: '2026-06-02T10:00:00Z', costUsd: '3.000000' });

    const res = await h.app.inject({
      method: 'GET',
      url: '/api/kpi/spend-timeseries?start=2026-06-01&end=2026-06-03',
      headers: hdr,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      points: Array<{ date: string; spendUsd: string; requestCount: number }>;
    }>();
    expect(body.points).toEqual([
      { date: '2026-06-01', spendUsd: '2.000000', requestCount: 2 },
      { date: '2026-06-02', spendUsd: '3.000000', requestCount: 1 },
    ]);
  });

  it('spend-timeseries (group_by=model): one series per model', async () => {
    const { org, hdr } = await seedOrg();
    await insertReq(org, {
      createdAt: '2026-06-01T10:00:00Z',
      model: 'gpt-4o',
      costUsd: '1.000000',
    });
    await insertReq(org, {
      createdAt: '2026-06-01T10:00:00Z',
      model: 'claude-sonnet-5',
      costUsd: '2.000000',
    });
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/kpi/spend-timeseries?start=2026-06-01&end=2026-06-01&group_by=model',
      headers: hdr,
    });
    const body = res.json<{ series: Array<{ groupKey: string; points: unknown[] }> }>();
    expect(body.series).toHaveLength(2);
    expect(body.series.map((s) => s.groupKey).sort()).toEqual(['claude-sonnet-5', 'gpt-4o']);
  });

  it('spend-timeseries: missing start → 400, range > 90 days → 400', async () => {
    const { hdr } = await seedOrg();
    const noStart = await h.app.inject({
      method: 'GET',
      url: '/api/kpi/spend-timeseries?end=2026-06-03',
      headers: hdr,
    });
    expect(noStart.statusCode).toBe(400);
    const tooWide = await h.app.inject({
      method: 'GET',
      url: '/api/kpi/spend-timeseries?start=2026-01-01&end=2026-06-01',
      headers: hdr,
    });
    expect(tooWide.statusCode).toBe(400);
  });

  // ── model mix ─────────────────────────────────────────────────────────────

  it('model-mix: sorted by spend, exact pct + token sums', async () => {
    const { org, hdr } = await seedOrg();
    await insertReq(org, {
      createdAt: '2026-06-10T10:00:00Z',
      model: 'gpt-4o',
      costUsd: '5.000000',
      inputTokens: 1000,
      outputTokens: 500,
    });
    await insertReq(org, {
      createdAt: '2026-06-10T11:00:00Z',
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      costUsd: '3.000000',
      inputTokens: 200,
      outputTokens: 100,
    });
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/kpi/model-mix?period=2026-06',
      headers: hdr,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      totalSpendUsd: string;
      models: Array<{ model: string; spendUsd: string; pctOfSpend: number; inputTokens: number }>;
    }>();
    expect(body.totalSpendUsd).toBe('8.000000');
    expect(body.models.map((m) => m.model)).toEqual(['gpt-4o', 'claude-sonnet-5']); // spend desc
    expect(body.models[0]!.pctOfSpend).toBe(62.5); // 5/8
    expect(body.models[0]!.inputTokens).toBe(1000);
    expect(body.models[1]!.pctOfSpend).toBe(37.5); // 3/8
  });
});
