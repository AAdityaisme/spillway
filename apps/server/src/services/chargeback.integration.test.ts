import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { formatUsd } from '@spillway/pricing';
import { makeTestApp, type TestHarness } from '../../test/helpers/app.js';

/**
 * B8.3 chargeback statement + CSV (Part II §20 §2): per-scope spend with the ledger-reconciliation
 * invariant (Σrequests == Σattempts to 6dp), CSV export, tier gate, and the null-price warning.
 */
describe('chargeback report (B8.3)', () => {
  let h: TestHarness;
  const orgId = randomUUID();
  const vkId = randomUUID();

  async function seedRequest(
    cost: string | null,
    attemptCost: string | null,
    status = 'ok',
    createdAt?: string,
  ): Promise<void> {
    const id = randomUUID();
    if (createdAt)
      await h.adminSql`INSERT INTO requests (id, org_id, virtual_key_id, requested_model, endpoint, status, cost_usd, created_at)
        VALUES (${id}, ${orgId}, ${vkId}, 'gpt-4o', 'chat_completions', ${status}, ${cost}, ${createdAt})`;
    else
      await h.adminSql`INSERT INTO requests (id, org_id, virtual_key_id, requested_model, endpoint, status, cost_usd)
        VALUES (${id}, ${orgId}, ${vkId}, 'gpt-4o', 'chat_completions', ${status}, ${cost})`;
    if (attemptCost !== null)
      await h.adminSql`INSERT INTO request_attempts (request_id, attempt_number, org_id, outcome, cost_usd)
        VALUES (${id}, 0, ${orgId}, 'ok', ${attemptCost})`;
  }

  async function seed(plan = 'governance'): Promise<{ hdr: Record<string, string> }> {
    const tok = await h.token('owner');
    await h.adminSql`INSERT INTO orgs (id, name, slug) VALUES (${orgId}, 'A', ${'a-' + orgId.slice(0, 8)})`;
    // make the caller a member/owner of THIS fixed org
    await h.adminSql`INSERT INTO users (id, email) VALUES ('owner', 'owner@t.dev') ON CONFLICT (id) DO NOTHING`;
    await h.adminSql`INSERT INTO org_members (org_id, user_id, role) VALUES (${orgId}, 'owner', 'owner')`;
    await h.adminSql`UPDATE orgs SET plan = ${plan} WHERE id = ${orgId}`;
    await h.adminSql`INSERT INTO virtual_keys (id, org_id, name, key_hash, key_prefix, status)
      VALUES (${vkId}, ${orgId}, 'k', ${Buffer.from(vkId)}, 'mk', 'active')`;
    return { hdr: { authorization: `Bearer ${tok}`, 'x-spillway-org': orgId } };
  }

  beforeEach(async () => {
    h = await makeTestApp();
  });
  afterEach(async () => {
    await h.close();
  });

  it('reconciled statement: Σrequests == Σattempts, grouped by key', async () => {
    const { hdr } = await seed();
    await seedRequest('0.010000', '0.010000');
    await seedRequest('0.020000', '0.020000');
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/reports/chargeback?group_by=virtual_key',
      headers: hdr,
    });
    expect(res.statusCode).toBe(200);
    const { statement } = res.json<{ statement: Record<string, unknown> }>();
    expect(statement.totalCostUsd).toBe('0.030000');
    expect((statement.reconciliation as { consistent: boolean }).consistent).toBe(true);
    expect((statement.lines as unknown[]).length).toBe(1); // both requests → same key
  });

  // M5 exit gate (13-build-order §M5): statement total reconciles to the sum of request rows to the
  // cent, over a RANDOMIZED request set (not just hand-picked fixtures). Seeded LCG → reproducible.
  it('property: statement total == Σ request costs to the cent (randomized)', async () => {
    const { hdr } = await seed();
    let s = 2246822519; // fixed seed
    const rng = (): number => {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      return s / 0x7fffffff;
    };
    let totalMicro = 0n;
    for (let i = 0; i < 40; i++) {
      const micro = 1 + Math.floor(rng() * 500_000); // 1..500000 micro-USD
      const cost = formatUsd(BigInt(micro)); // canonical 6dp string, same formatter as the service
      totalMicro += BigInt(micro);
      await seedRequest(cost, cost); // request cost == attempt cost → ledger reconciles
    }
    const res = await h.app.inject({ method: 'GET', url: '/api/reports/chargeback', headers: hdr });
    expect(res.statusCode).toBe(200);
    const { statement } = res.json<{
      statement: { totalCostUsd: string; reconciliation: { consistent: boolean } };
    }>();
    expect(statement.totalCostUsd).toBe(formatUsd(totalMicro)); // to the cent (6dp)
    expect(statement.reconciliation.consistent).toBe(true);
  });

  it('CSV export has a stable header + total row', async () => {
    const { hdr } = await seed();
    await seedRequest('0.010000', '0.010000');
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/reports/chargeback?group_by=virtual_key&format=csv',
      headers: hdr,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    const lines = res.body.trim().split('\n');
    expect(lines[0]).toBe('scope_type,scope_id,request_count,success_count,blocked_count,cost_usd');
    expect(lines[lines.length - 1]).toBe('total,,1,1,0,0.010000');
  });

  it('a null-price request flags a reconciliation warning', async () => {
    const { hdr } = await seed();
    await seedRequest('0.010000', '0.010000');
    await seedRequest(null, null); // unknown price
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/reports/chargeback',
      headers: hdr,
    });
    const { statement } = res.json<{
      statement: { reconciliation: { consistent: boolean; warning?: string } };
    }>();
    expect(statement.reconciliation.consistent).toBe(false);
    expect(statement.reconciliation.warning).toMatch(/unknown price/i);
  });

  it('free plan → 402 tier_required', async () => {
    const { hdr } = await seed('free');
    const res = await h.app.inject({ method: 'GET', url: '/api/reports/chargeback', headers: hdr });
    expect(res.statusCode).toBe(402);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('tier_required');
  });

  // audit M40: a budget-blocked request carries no spend; requestCount must include it but blockedCount
  // must expose it so a finance consumer isn't misled into attributing billable volume to that scope.
  it('blocked requests are counted separately from billable volume (M40)', async () => {
    const { hdr } = await seed();
    await seedRequest('0.010000', '0.010000', 'ok');
    await seedRequest(null, null, 'blocked'); // budget-blocked, no spend
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/reports/chargeback?group_by=virtual_key',
      headers: hdr,
    });
    const { statement } = res.json<{
      statement: {
        lines: { requestCount: number; successCount: number; blockedCount: number }[];
        totalCostUsd: string;
        reconciliation: { consistent: boolean };
      };
    }>();
    const line = statement.lines[0]!;
    expect(line.requestCount).toBe(2);
    expect(line.successCount).toBe(1);
    expect(line.blockedCount).toBe(1);
    expect(statement.totalCostUsd).toBe('0.010000'); // blocked adds no cost
    // A blocked request has no attempt row and no cost → the requests==attempts invariant still holds.
    expect(statement.reconciliation.consistent).toBe(true);
  });

  // audit M16/M42: the enforcement-counter arm only fires on a whole-UTC-month window. Seed an
  // org-scope monthly spend_counters row matching the ledger and assert counterConsistent=true; then
  // inject drift and assert the warning fires. Sub-month window → arm skipped (null), never a false drift.
  it('counter arm: whole-month window cross-checks spend_counters (M16/M42)', async () => {
    const { hdr } = await seed();
    // A request billed inside June 2026.
    await seedRequest('0.030000', '0.030000', 'ok', '2026-06-15T00:00:00.000Z');
    // Matching enforcement counter for the org over the June month key.
    await h.adminSql`INSERT INTO spend_counters (org_id, scope_type, scope_id, period_key, spent_usd, request_count)
      VALUES (${orgId}, 'org', ${orgId}, '2026-06', '0.030000', 1)`;

    const monthUrl =
      '/api/reports/chargeback?start=2026-06-01T00:00:00.000Z&end=2026-07-01T00:00:00.000Z';
    const ok = await h.app.inject({ method: 'GET', url: monthUrl, headers: hdr });
    const okRecon = ok.json<{ statement: { reconciliation: Record<string, unknown> } }>().statement
      .reconciliation;
    expect(okRecon.countersUsd).toBe('0.030000');
    expect(okRecon.counterConsistent).toBe(true);
    expect(okRecon.counterWarning).toBeUndefined();

    // Inject drift: bump the counter so it no longer equals the ledger.
    await h.adminSql`UPDATE spend_counters SET spent_usd = '0.050000'
      WHERE org_id = ${orgId} AND scope_type = 'org' AND period_key = '2026-06'`;
    const drift = await h.app.inject({ method: 'GET', url: monthUrl, headers: hdr });
    const driftRecon = drift.json<{ statement: { reconciliation: Record<string, unknown> } }>()
      .statement.reconciliation;
    expect(driftRecon.counterConsistent).toBe(false);
    expect(driftRecon.counterWarning).toMatch(/drift/i);
  });

  // audit M18/L26: an over-wide window forces a full-history scan; the route must reject it before the DB.
  it('rejects a window wider than 366 days with a 400 (M18/L26)', async () => {
    const { hdr } = await seed();
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/reports/chargeback?start=2000-01-01T00:00:00.000Z&end=2100-01-01T00:00:00.000Z',
      headers: hdr,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('validation_error');
  });

  // audit L41: an inverted or malformed window is a clean 400, not a silent empty/500.
  it('inverted and NaN windows → 400 (L41)', async () => {
    const { hdr } = await seed();
    const inverted = await h.app.inject({
      method: 'GET',
      url: '/api/reports/chargeback?start=2026-07-01T00:00:00.000Z&end=2026-06-01T00:00:00.000Z',
      headers: hdr,
    });
    expect(inverted.statusCode).toBe(400);
    const nan = await h.app.inject({
      method: 'GET',
      url: '/api/reports/chargeback?start=not-a-date',
      headers: hdr,
    });
    expect(nan.statusCode).toBe(400);
  });

  it('counter arm: sub-month window skips the arm (null, no false drift) (M42)', async () => {
    const { hdr } = await seed();
    await seedRequest('0.030000', '0.030000', 'ok', '2026-06-15T00:00:00.000Z');
    await h.adminSql`INSERT INTO spend_counters (org_id, scope_type, scope_id, period_key, spent_usd, request_count)
      VALUES (${orgId}, 'org', ${orgId}, '2026-06', '0.999999', 1)`; // deliberately wrong
    // A window that is NOT month-aligned must never consult the counter → no false drift.
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/reports/chargeback?start=2026-06-10T00:00:00.000Z&end=2026-06-20T00:00:00.000Z',
      headers: hdr,
    });
    const recon = res.json<{ statement: { reconciliation: Record<string, unknown> } }>().statement
      .reconciliation;
    expect(recon.countersUsd).toBeNull();
    expect(recon.counterConsistent).toBeNull();
    expect(recon.counterWarning).toBeUndefined();
  });
});
