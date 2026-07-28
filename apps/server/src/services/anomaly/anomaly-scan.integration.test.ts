import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { makeTestApp, type TestHarness } from '../../../test/helpers/app.js';
import { withOrg } from '../../db/tenancy.js';
import { runAnomalyScanForScope, evaluateAnomalyForScope } from './scan.js';
import { fetchFlatMeanSamples, evaluateConfirmedGate, type OrgScope } from './queries.js';
import type { AnomalyFireConfig } from './baseline.js';

/**
 * B7.3b anomaly-scan job exit gate (Part II §19 §2/§3): per-scope evaluation over spend_counters →
 * deduped `anomaly` alert_event. Covers fire/no-fire threshold, self-poison sample exclusion, the UTC-
 * midnight skip, and one-fire-per-day dedupe.
 */

let h: TestHarness;
const orgId = randomUUID();
const config: AnomalyFireConfig = { multiplier: 3, minUsdMicro: 5_000_000n }; // 3× / $5 floor
const scope: OrgScope = { orgId, scopeType: 'org', scopeId: orgId };
const NOON = new Date('2026-07-07T09:00:00Z'); // a Tuesday, non-midnight

/** Seed a completed day-counter (past) or today's counter. */
async function seedCounter(periodKey: string, usd: number): Promise<void> {
  await h.adminSql`INSERT INTO spend_counters (org_id, scope_type, scope_id, period_key, spent_usd)
    VALUES (${orgId}, 'org', ${orgId}, ${periodKey}, ${usd})
    ON CONFLICT (scope_type, scope_id, period_key) DO UPDATE SET spent_usd = ${usd}`;
}
const scan = (now = NOON) =>
  withOrg(h.db, orgId, (tx) => runAnomalyScanForScope(tx, scope, now, config));

beforeAll(async () => {
  h = await makeTestApp();
  await h.adminSql`INSERT INTO orgs (id, name, slug) VALUES (${orgId}, 'A', ${'a-' + orgId.slice(0, 8)})`;
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.adminSql`TRUNCATE spend_counters, alert_events`;
  // 10 completed days of low ($10) spend → flat_mean baseline mode (7-27d history).
  for (let d = 20; d <= 29; d++) await seedCounter(`2026-06-${d}`, 10);
});

describe('anomaly scan (§19 §2/§3, B7.3b)', () => {
  it('a today-spike over the threshold fires a deduped anomaly event', async () => {
    await seedCounter('2026-07-07', 100); // 10× baseline; threshold = max(3×10,5)=30
    const ev = await scan();
    expect(ev.fires).toBe(true);
    expect(ev.severity).toBe('warning'); // ratio 10 → 5-10 band
    const events = await h.adminSql<{ dedupe_key: string }[]>`
      SELECT dedupe_key FROM alert_events WHERE org_id = ${orgId} AND payload->>'event_type' = 'anomaly'`;
    expect(events).toHaveLength(1);
    expect(events[0]!.dedupe_key).toBe(`anomaly:org:${orgId}:2026-07-07`);

    await scan(); // re-run same day → dedupe, still one event
    const again =
      await h.adminSql`SELECT 1 FROM alert_events WHERE org_id = ${orgId} AND payload->>'event_type' = 'anomaly'`;
    expect(again).toHaveLength(1);
  });

  it('today under the threshold does not fire', async () => {
    await seedCounter('2026-07-07', 20); // < 30 threshold
    const ev = await scan();
    expect(ev.fires).toBe(false);
    expect(ev.reason).toBe('under_threshold');
    const events = await h.adminSql`SELECT 1 FROM alert_events WHERE org_id = ${orgId}`;
    expect(events).toHaveLength(0);
  });

  it('UTC-midnight hour skips the scan (today counter is near-zero regardless)', async () => {
    await seedCounter('2026-07-07', 100);
    const ev = await withOrg(h.db, orgId, (tx) =>
      evaluateAnomalyForScope(tx, scope, new Date('2026-07-07T00:30:00Z'), config),
    );
    expect(ev.fires).toBe(false);
    expect(ev.reason).toBe('midnight_skip');
  });

  it('self-poison: a day this scope already fired an anomaly for is excluded from the samples', async () => {
    // Spike 2026-06-29 to $1000 AND record a prior `anomaly` event for it → the flat-mean fetch must
    // drop that day (else the $1000 would poison the baseline, §2.5).
    await h.adminSql`UPDATE spend_counters SET spent_usd = 1000 WHERE org_id = ${orgId} AND period_key = '2026-06-29'`;
    await h.adminSql`INSERT INTO alert_events (org_id, alert_id, fired_at, dedupe_key, payload)
      VALUES (${orgId}, null, now(), 'anomaly:seed:2026-06-29',
        ${h.adminSql.json({ event_type: 'anomaly', scope_type: 'org', scope_id: orgId, period_key: '2026-06-29' })})`;
    const samples = await withOrg(h.db, orgId, (tx) => fetchFlatMeanSamples(tx, scope, NOON));
    expect(samples).not.toContain(1_000_000_000n); // the $1000 poisoned day dropped
    expect(samples.every((s) => s === 10_000_000n)).toBe(true); // remaining samples all $10
  });
});

/**
 * §3.2 anomaly_confirmed AND-gate integration (M35): evaluateConfirmedGate reads `burst` events
 * from alert_events and gateB checks projected EOD. runAnomalyScanForScope fires
 * `anomaly_confirmed` when both gates pass (virtual_key scope only).
 */
describe('anomaly_confirmed gate (§3.2, M35)', () => {
  const vkId = randomUUID();
  const vkScope: OrgScope = { orgId, scopeType: 'virtual_key', scopeId: vkId };

  beforeEach(async () => {
    await h.adminSql`TRUNCATE spend_counters, alert_events`;
    // 10 completed days of low ($10) spend → flat_mean baseline, threshold = max(3×10,$5) = $30
    for (let d = 20; d <= 29; d++) {
      await h.adminSql`INSERT INTO spend_counters (org_id, scope_type, scope_id, period_key, spent_usd)
        VALUES (${orgId}, 'virtual_key', ${vkId}, ${'2026-06-' + d}, 10)
        ON CONFLICT DO NOTHING`;
    }
  });

  it('gateA absent (no burst today) → confirmed does not fire even when anomaly fires', async () => {
    // Spike today to $100 — anomaly fires, but no `burst` event → confirmed gate stays closed
    await h.adminSql`INSERT INTO spend_counters (org_id, scope_type, scope_id, period_key, spent_usd)
      VALUES (${orgId}, 'virtual_key', ${vkId}, '2026-07-07', 100) ON CONFLICT DO NOTHING`;
    await withOrg(h.db, orgId, (tx) => runAnomalyScanForScope(tx, vkScope, NOON, config));
    const confirmed = await h.adminSql`
      SELECT 1 FROM alert_events WHERE org_id = ${orgId} AND payload->>'event_type' = 'anomaly_confirmed'`;
    expect(confirmed).toHaveLength(0); // no burst event → confirmed not fired
  });

  it('both gates pass → anomaly_confirmed fires exactly once (dedupe prevents re-fire)', async () => {
    // Spike today to $100 ($90 at NOON → projected $200 EOD, well over $30 threshold).
    await h.adminSql`INSERT INTO spend_counters (org_id, scope_type, scope_id, period_key, spent_usd)
      VALUES (${orgId}, 'virtual_key', ${vkId}, '2026-07-07', 90) ON CONFLICT DO NOTHING`;
    // Seed a `burst` alert_event for today → gateA passes
    await h.adminSql`INSERT INTO alert_events (org_id, alert_id, fired_at, dedupe_key, payload)
      VALUES (${orgId}, null, now(), ${'burst:' + vkId + ':2026-07-07'},
              ${h.adminSql.json({ event_type: 'burst', virtual_key_id: vkId })})`;

    await withOrg(h.db, orgId, (tx) => runAnomalyScanForScope(tx, vkScope, NOON, config));
    const rows = await h.adminSql<{ payload: Record<string, unknown> }[]>`
      SELECT payload FROM alert_events
      WHERE org_id = ${orgId} AND payload->>'event_type' = 'anomaly_confirmed'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload['scope_id']).toBe(vkId);
    expect(rows[0]!.payload['period_key']).toBe('2026-07-07');
    expect(rows[0]!.payload['severity']).toBe('critical'); // 19 §3: confirmed is always critical

    // Second scan same day → dedupe prevents re-fire
    await withOrg(h.db, orgId, (tx) => runAnomalyScanForScope(tx, vkScope, NOON, config));
    const again = await h.adminSql`
      SELECT 1 FROM alert_events WHERE org_id = ${orgId} AND payload->>'event_type' = 'anomaly_confirmed'`;
    expect(again).toHaveLength(1);
  });

  it('evaluateConfirmedGate returns gateA=false when no burst fired today', async () => {
    // gateA: fetchBurstFiredToday should return false when no burst event exists
    const todayMicro = 90_000_000n; // $90
    const threshold = 30_000_000n; // $30
    const result = await withOrg(h.db, orgId, (tx) =>
      evaluateConfirmedGate(tx, orgId, vkId, NOON, todayMicro, threshold),
    );
    expect(result.gateA).toBe(false);
    expect(result.fireConfirmed).toBe(false);
    // gateB still computable independently
    expect(result.gateB).toBe(true); // projected $90*(24/9)=$240 > $30
  });
});
