import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { makeTestApp, type TestHarness } from '../../../test/helpers/app.js';
import { withOrg } from '../../db/tenancy.js';
import { evaluateAndFireBudgetForecast } from './forecast-scan.js';

/**
 * Budget-forecast producer (19 §4). NOW is fixed at 2026-07-07T12:00 UTC (day 7 of 31, half-elapsed) so
 * days_remaining ≈ 24.5 is deterministic. A $10/day trailing run rate projects EOM ≈ mtd + $245.
 */
describe('budget forecast producer (19 §4)', () => {
  let h: TestHarness;
  let orgId: string;
  const NOW = new Date('2026-07-07T12:00:00Z');

  beforeEach(async () => {
    h = await makeTestApp();
    orgId = randomUUID();
    await h.adminSql`INSERT INTO orgs (id, name, slug) VALUES (${orgId}, 'Acme', ${'a-' + orgId.slice(0, 8)})`;
  });
  afterEach(async () => {
    await h.close();
  });

  async function seedMonthBudget(limit: string, mode = 'enforce'): Promise<void> {
    await h.adminSql`INSERT INTO budgets (org_id, scope_type, scope_id, period, limit_usd, mode)
      VALUES (${orgId}, 'org', ${orgId}, 'month', ${limit}, ${mode})`;
  }
  /** Seed the month-to-date counter + `days` completed prior day-rows each spending `perDay`. */
  async function seedCounters(mtd: string, perDay: string, days: number): Promise<void> {
    await h.adminSql`INSERT INTO spend_counters (org_id, scope_type, scope_id, period_key, spent_usd)
      VALUES (${orgId}, 'org', ${orgId}, '2026-07', ${mtd})`;
    for (let d = 0; d < days; d++) {
      const day = `2026-07-0${d + 1}`; // 07-01..07-0N, all < today (07-07)
      await h.adminSql`INSERT INTO spend_counters (org_id, scope_type, scope_id, period_key, spent_usd)
        VALUES (${orgId}, 'org', ${orgId}, ${day}, ${perDay})`;
    }
  }
  const fire = (): Promise<number> =>
    withOrg(h.db, orgId, (tx) => evaluateAndFireBudgetForecast(tx, { orgId, now: NOW }));
  async function events(): Promise<Record<string, unknown>[]> {
    const rows = (await h.adminSql`
      SELECT payload FROM alert_events WHERE org_id = ${orgId}
        AND payload->>'event_type' = 'budget_forecast'`) as unknown as {
      payload: Record<string, unknown>;
    }[];
    return rows.map((r) => r.payload);
  }

  it('fires when the trailing run rate projects an overshoot, then dedupes for the month', async () => {
    await seedMonthBudget('100.000000'); // $100/mo
    await seedCounters('30.000000', '10.000000', 3); // mtd $30, 3 days @ $10 → rate $10/day

    expect(await fire()).toBe(1);
    const ev = await events();
    expect(ev).toHaveLength(1);
    expect(ev[0]!.period_key).toBe('2026-07');
    expect(ev[0]!.daily_run_rate_usd).toBe('10.000000');
    expect(Number(ev[0]!.projected_eom_usd)).toBeGreaterThan(100);
    expect(ev[0]!.overshoot_day).toBeGreaterThan(7); // crosses later this month
    expect(ev[0]!.overshoot_day).toBeLessThanOrEqual(31);

    // Same month → deduped, no second event even on a re-scan.
    expect(await fire()).toBe(0);
    expect((await events()).length).toBe(1);
  });

  it('cold-start: fewer than 3 completed day-rows → no forecast', async () => {
    await seedMonthBudget('100.000000');
    await seedCounters('30.000000', '10.000000', 2); // only 2 samples
    expect(await fire()).toBe(0);
  });

  it('silent once month-to-date already reached the limit (budget_threshold owns that state)', async () => {
    await seedMonthBudget('100.000000');
    await seedCounters('120.000000', '40.000000', 3); // mtd $120 ≥ $100 → forecast stays silent
    expect(await fire()).toBe(0);
  });

  it('does not fire when the run rate keeps projected spend under the limit', async () => {
    await seedMonthBudget('1000.000000'); // high limit
    await seedCounters('30.000000', '10.000000', 3); // projected ≈ $275 < $1000
    expect(await fire()).toBe(0);
  });

  it('a monitor-mode budget never forecasts', async () => {
    await seedMonthBudget('100.000000', 'monitor');
    await seedCounters('30.000000', '10.000000', 3);
    expect(await fire()).toBe(0);
  });
});
