import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { makeTestApp, type TestHarness } from '../../../test/helpers/app.js';
import { withOrg } from '../../db/tenancy.js';
import {
  evaluateErrorRate,
  evaluateAndFireErrorRate,
  errorRateConfig,
  type ErrorRateAlert,
} from './error-rate.js';

/** Error-rate alert producer (13-build-order §M5.3). Windowed error rate → deduped alert_events. */
describe('error-rate alert producer (M5.3)', () => {
  let h: TestHarness;
  let orgId: string;

  beforeEach(async () => {
    h = await makeTestApp();
    orgId = randomUUID();
    await h.adminSql`INSERT INTO orgs (id, name, slug) VALUES (${orgId}, 'A', ${'a-' + orgId.slice(0, 8)})`;
  });
  afterEach(async () => {
    await h.close();
  });

  async function seedRequests(ok: number, err: number): Promise<void> {
    const at = new Date(Date.now() - 60_000).toISOString(); // 1 min ago (inside any window)
    for (let i = 0; i < ok; i++)
      await h.adminSql`INSERT INTO requests (id, org_id, endpoint, status, created_at) VALUES (${randomUUID()}, ${orgId}, 'chat_completions', 'ok', ${at})`;
    for (let i = 0; i < err; i++)
      await h.adminSql`INSERT INTO requests (id, org_id, endpoint, status, created_at) VALUES (${randomUUID()}, ${orgId}, 'chat_completions', 'error', ${at})`;
  }

  async function seedAlert(config: Record<string, number>): Promise<ErrorRateAlert> {
    const id = randomUUID();
    await h.adminSql`
      INSERT INTO alerts (id, org_id, name, kind, config, channels, enabled)
      VALUES (${id}, ${orgId}, 'er', 'error_rate', ${h.adminSql.json(config)}, ${h.adminSql.json([])}, true)`;
    return { id, orgId, config };
  }

  it('fires when the window error rate crosses the threshold, then dedupes', async () => {
    await seedRequests(80, 20); // 20% over 100
    const alert = await seedAlert({ threshold_pct: 10, window_minutes: 60, min_requests: 20 });
    const now = new Date();

    const fired = await withOrg(h.db, orgId, (tx) => evaluateAndFireErrorRate(tx, alert, now));
    expect(fired).toBe(true);

    const events = (await h.adminSql`
      SELECT payload FROM alert_events WHERE org_id = ${orgId} AND alert_id = ${alert.id}`) as unknown as {
      payload: { event_type: string; error_rate_pct: number; severity: string };
    }[];
    expect(events).toHaveLength(1);
    expect(events[0]!.payload.event_type).toBe('error_rate');
    expect(events[0]!.payload.error_rate_pct).toBe(20);

    // Same window → deduped, no second event.
    const again = await withOrg(h.db, orgId, (tx) => evaluateAndFireErrorRate(tx, alert, now));
    expect(again).toBe(false);
  });

  it('does not fire below the threshold', async () => {
    await seedRequests(98, 2); // 2%
    const cfg = errorRateConfig({ threshold_pct: 10, window_minutes: 60, min_requests: 20 });
    const ev = await withOrg(h.db, orgId, (tx) => evaluateErrorRate(tx, orgId, cfg, new Date()));
    expect(ev.errorRatePct).toBe(2);
    expect(ev.fires).toBe(false);
  });

  it('does not fire below the sample floor even at 100% error', async () => {
    await seedRequests(0, 5); // 100% error, but only 5 requests
    const cfg = errorRateConfig({ threshold_pct: 10, window_minutes: 60, min_requests: 20 });
    const ev = await withOrg(h.db, orgId, (tx) => evaluateErrorRate(tx, orgId, cfg, new Date()));
    expect(ev.errorRatePct).toBe(100);
    expect(ev.fires).toBe(false); // 5 < min_requests 20
  });
});
