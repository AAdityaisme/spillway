import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { makeTestApp, type TestHarness } from '../../test/helpers/app.js';
import type { DatabaseClient } from '../db/client.js';
import { runInsightsForOrg, runInsightsScan } from './insights.js';

/**
 * B8.5 savings-insights exit gate (§19 §8): the job consumes request_features (floors suppress a
 * downgrade), estimates savings on downgradable models, writes exactly ONE savings_insights row per
 * (org, period) ON CONFLICT, flags heuristic-only mode, and surfaces a forecast-flagged scope. Plus the
 * manual trigger endpoint.
 */
describe('savings insights (B8.5)', () => {
  let h: TestHarness;
  const orgId = randomUUID();

  async function seedReq(
    model: string,
    cost: string,
    features: Record<string, unknown>,
  ): Promise<void> {
    await h.adminSql`INSERT INTO requests (id, org_id, model, requested_model, endpoint, status, cost_usd, request_features, created_at)
      VALUES (${randomUUID()}, ${orgId}, ${model}, ${model}, 'chat_completions', 'ok', ${cost},
              ${h.adminSql.json(features as never)}, now())`;
  }

  beforeEach(async () => {
    h = await makeTestApp();
    await h.adminSql`INSERT INTO orgs (id, name, slug, plan) VALUES (${orgId}, 'A', ${'a-' + orgId.slice(0, 8)}, 'governance')`;
    await h.adminSql`INSERT INTO users (id, email) VALUES ('owner', 'o@t.dev') ON CONFLICT (id) DO NOTHING`;
    await h.adminSql`INSERT INTO org_members (org_id, user_id, role) VALUES (${orgId}, 'owner', 'owner')`;
    await h.adminSql`INSERT INTO model_prices (provider, model, input_usd_per_m, output_usd_per_m, cache_read_usd_per_m, source, synced_at)
      VALUES ('openai', 'gpt-4o', 2.5, 10, 0.25, 'litellm', now()),
             ('openai', 'gpt-4o-mini', 0.15, 0.6, 0.015, 'litellm', now())`;
  });
  afterEach(async () => {
    await h.close();
  });

  const clean = {
    has_tools: false,
    has_response_format: false,
    q_truncated: false,
    finish_reason: 'stop',
  };

  it('classifies downgradable requests, skips floored ones, writes one heuristic row', async () => {
    await seedReq('gpt-4o', '0.020000', clean); // downgrade candidate
    await seedReq('gpt-4o', '0.020000', clean); // candidate
    await seedReq('gpt-4o', '0.020000', { ...clean, has_tools: true }); // floored — keeps the model
    await seedReq('gpt-4o-mini', '0.001000', clean); // already cheap — no sibling

    const r = await runInsightsForOrg(h.db, orgId, new Date());
    expect(r.suggestions).toBe(1); // one gpt-4o → gpt-4o-mini group
    expect(Number(r.estSavingsUsd)).toBeGreaterThan(0);

    const [row] = await h.adminSql<
      { summary: Record<string, unknown>; detail: Record<string, unknown> }[]
    >`
      SELECT summary, detail FROM savings_insights WHERE org_id = ${orgId}`;
    expect(row!.summary.method).toBe('heuristic');
    expect(row!.summary.heuristic_only).toBe(true);
    expect(row!.summary.downgrade_candidates).toBe(1);
    const suggestions = row!.detail.suggestions as { from_model: string; request_count: number }[];
    expect(suggestions[0]!.from_model).toBe('gpt-4o');
    expect(suggestions[0]!.request_count).toBe(2); // the two clean ones, not the tool one
  });

  it('re-running regenerates in place — exactly one row per (org, period)', async () => {
    await seedReq('gpt-4o', '0.020000', clean);
    await runInsightsForOrg(h.db, orgId, new Date());
    await runInsightsForOrg(h.db, orgId, new Date()); // ON CONFLICT DO UPDATE
    const rows = await h.adminSql`SELECT 1 FROM savings_insights WHERE org_id = ${orgId}`;
    expect(rows).toHaveLength(1);
  });

  it('surfaces a forecast-flagged scope in the detail (prioritization, §8)', async () => {
    await seedReq('gpt-4o', '0.020000', clean);
    const period = `${new Date().getUTCFullYear()}-${String(new Date().getUTCMonth() + 1).padStart(2, '0')}`;
    await h.adminSql`INSERT INTO alert_events (org_id, alert_id, fired_at, dedupe_key, payload)
      VALUES (${orgId}, null, now(), 'ff', ${h.adminSql.json({ event_type: 'budget_forecast', scope_id: 'team-x', period_key: period } as never)})`;
    await runInsightsForOrg(h.db, orgId, new Date());
    const [row] = await h.adminSql<{ detail: { forecast_flagged_scope_ids: string[] } }[]>`
      SELECT detail FROM savings_insights WHERE org_id = ${orgId}`;
    expect(row!.detail.forecast_flagged_scope_ids).toContain('team-x');
  });

  it('cross-org scan isolates a per-org failure — one bad org does not abort the rest (M28)', async () => {
    // A second org with a request this period, so the scan visits both.
    const orgBad = randomUUID();
    await h.adminSql`INSERT INTO orgs (id, name, slug, plan) VALUES (${orgBad}, 'B', ${'b-' + orgBad.slice(0, 8)}, 'governance')`;
    await h.adminSql`INSERT INTO requests (id, org_id, model, requested_model, endpoint, status, cost_usd, request_features, created_at)
      VALUES (${randomUUID()}, ${orgBad}, 'gpt-4o', 'gpt-4o', 'chat_completions', 'ok', '0.02',
              ${h.adminSql.json(clean as never)}, now())`;
    await seedReq('gpt-4o', '0.020000', clean); // the good org (orgId)

    // Proxy db that rejects the FIRST org's transaction (a downstream classify/db fault for that org)
    // and delegates the rest to the real db. runInsightsForOrg → withOrg → db.transaction, so this
    // makes exactly one org throw; isolation must let the surviving org still complete + write.
    const realDb = h.db;
    let calls = 0;
    const failingDb = {
      ...realDb,
      transaction: ((cb: unknown, ...rest: unknown[]) => {
        calls += 1;
        if (calls === 1) return Promise.reject(new Error('simulated per-org classify fault'));
        return (realDb.transaction as (...a: unknown[]) => unknown)(cb, ...rest);
      }) as DatabaseClient['transaction'],
    } as DatabaseClient;

    const errors: string[] = [];
    const res = await runInsightsScan(h.jobsDb, failingDb, new Date(), {
      error: (_o, m) => errors.push(m),
    });
    expect(res.orgs).toBe(2);
    expect(res.failed).toBe(1); // exactly one org failed, the run did NOT abort
    expect(errors).toHaveLength(1);
    // the surviving org still got its insight row written
    const written = await h.adminSql`SELECT 1 FROM savings_insights`;
    expect(written).toHaveLength(1);
  });

  it('POST /api/reports/insights/trigger regenerates; GET returns it', async () => {
    await seedReq('gpt-4o', '0.020000', clean);
    const tok = await h.token('owner');
    const hdr = { authorization: `Bearer ${tok}`, 'x-spillway-org': orgId };
    const post = await h.app.inject({
      method: 'POST',
      url: '/api/reports/insights/trigger',
      headers: hdr,
    });
    expect(post.statusCode).toBe(200);
    const get = await h.app.inject({ method: 'GET', url: '/api/reports/insights', headers: hdr });
    expect(get.statusCode).toBe(200);
    expect(get.json<{ insight: unknown }>().insight).not.toBeNull();
  });
});
