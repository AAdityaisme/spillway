import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { makeTestApp, type TestHarness } from '../../../test/helpers/app.js';
import { withOrg } from '../../db/tenancy.js';
import { fireBurstEvent, type BurstEval } from './burst.js';

/**
 * 19 §3.1 burst event write — drives fireBurstEvent against real RLS Postgres. Proves it (a) writes a
 * synthetic alert_id-NULL `burst` event, (b) enriches it with the vk name/prefix, (c) routes it to the
 * org's `anomaly` alert channels via payload.channels, and (d) dedupes on (alert_id, dedupe_key) so a
 * second fire in the same UTC minute is a no-op.
 */
describe('fireBurstEvent (19 §3.1)', () => {
  let h: TestHarness;
  let orgId: string;
  let vkId: string;

  const ev: BurstEval = { fire: true, currentRpm: 120, trailingHourAvgRpm: 8, thresholdRpm: 40 };

  beforeEach(async () => {
    h = await makeTestApp();
    orgId = randomUUID();
    vkId = randomUUID();
    await h.adminSql`INSERT INTO orgs (id, name, slug) VALUES (${orgId}, 'Acme', ${'a-' + orgId.slice(0, 8)})`;
    await h.adminSql`INSERT INTO virtual_keys (id, org_id, name, key_hash, key_prefix, status)
      VALUES (${vkId}, ${orgId}, 'prod-key', ${Buffer.from(vkId)}, 'mk-prod', 'active')`;
  });
  afterEach(async () => {
    await h.close();
  });

  async function events(): Promise<
    { alert_id: string | null; dedupe_key: string; payload: Record<string, unknown> }[]
  > {
    return (await h.adminSql`
      SELECT alert_id, dedupe_key, payload FROM alert_events WHERE org_id = ${orgId}`) as unknown as {
      alert_id: string | null;
      dedupe_key: string;
      payload: Record<string, unknown>;
    }[];
  }

  it('writes a synthetic burst event enriched with the vk identity, routed to anomaly channels', async () => {
    const chans = [{ type: 'slack', target: 'https://hooks.example/x' }];
    await h.adminSql`
      INSERT INTO alerts (id, org_id, name, kind, scope_type, scope_id, config, channels, enabled)
      VALUES (${randomUUID()}, ${orgId}, 'anom', 'anomaly', NULL, NULL,
              ${h.adminSql.json({})}, ${h.adminSql.json(chans)}, true)`;
    const now = new Date('2026-07-16T09:15:30Z');

    const fired = await withOrg(h.db, orgId, (tx) =>
      fireBurstEvent(tx, { orgId, virtualKeyId: vkId, ev, now }),
    );
    expect(fired).toBe(true);

    const rows = await events();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.alert_id).toBeNull(); // synthetic
    expect(rows[0]!.dedupe_key).toBe(`burst:${vkId}:2026-07-16T09:15`);
    const p = rows[0]!.payload;
    expect(p.event_type).toBe('burst');
    expect(p.virtual_key_name).toBe('prod-key');
    expect(p.key_prefix).toBe('mk-prod');
    expect(p.current_rpm).toBe(120);
    expect(p.severity).toBe('warning');
    expect(p.channels).toEqual(chans); // routed to the org's anomaly channels
  });

  it('dedupes a second fire in the same UTC minute, then fires again the next minute', async () => {
    const now = new Date('2026-07-16T09:15:30Z');
    const first = await withOrg(h.db, orgId, (tx) =>
      fireBurstEvent(tx, { orgId, virtualKeyId: vkId, ev, now }),
    );
    const second = await withOrg(h.db, orgId, (tx) =>
      fireBurstEvent(tx, { orgId, virtualKeyId: vkId, ev, now: new Date('2026-07-16T09:15:59Z') }),
    );
    const nextMin = await withOrg(h.db, orgId, (tx) =>
      fireBurstEvent(tx, { orgId, virtualKeyId: vkId, ev, now: new Date('2026-07-16T09:16:02Z') }),
    );
    expect([first, second, nextMin]).toEqual([true, false, true]);
    expect(await events()).toHaveLength(2);
  });

  it('with no anomaly alert configured, still writes the event with empty channels', async () => {
    const fired = await withOrg(h.db, orgId, (tx) =>
      fireBurstEvent(tx, { orgId, virtualKeyId: vkId, ev, now: new Date('2026-07-16T09:15:30Z') }),
    );
    expect(fired).toBe(true);
    const rows = await events();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload.channels).toEqual([]);
  });
});
