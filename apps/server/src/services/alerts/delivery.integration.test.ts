import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { makeTestApp, type TestHarness } from '../../../test/helpers/app.js';
import {
  runAlertDelivery,
  type Channel,
  type DeliverableAlert,
  type ChannelSink,
  type DeliveryResult,
} from './delivery.js';

/**
 * Alert-delivery drain (Part II §20 §5). Multi-tenant by construction: each event delivers to its OWN
 * org's channels (payload.channels for synthetic alert_id=NULL rows, or the joined alerts.channels).
 * warning/critical deliver then stamp; info + no-channels are suppressed; a failure defers by the
 * exponential backoff and re-delivers; the attempt cap dead-letters (no silent drop).
 */
let h: TestHarness;
const orgA = randomUUID();
const orgB = randomUUID();
const WEBHOOK: Channel = { type: 'webhook', url: 'https://hook.test/x', secret: 's' };

interface Sent {
  channel: Channel;
  alert: DeliverableAlert;
}
function recordingSink(failFirst = 0): ChannelSink & { sent: Sent[] } {
  let fails = failFirst;
  const sent: Sent[] = [];
  return {
    sent,
    async deliver(channel, alert) {
      if (fails > 0) {
        fails--;
        throw new Error('sink down');
      }
      sent.push({ channel, alert });
    },
  };
}

async function fireEvent(
  payload: Record<string, unknown>,
  opts: { org?: string; channels?: Channel[]; alertId?: string } = {},
): Promise<string> {
  const id = randomUUID();
  const body =
    opts.alertId !== undefined ? payload : { channels: opts.channels ?? [WEBHOOK], ...payload };
  await h.adminSql`INSERT INTO alert_events (id, org_id, alert_id, fired_at, dedupe_key, payload)
    VALUES (${id}, ${opts.org ?? orgA}, ${opts.alertId ?? null}, now(), ${'k:' + id},
            ${h.adminSql.json(body as never)})`;
  return id;
}

/** Simulate the backoff window elapsing so a deferred row is re-claimable. */
const reclaimable = (): Promise<unknown> =>
  h.adminSql`UPDATE alert_events SET delivery_lease_until = now() - interval '1 hour'`;

const run = (sink: ChannelSink): Promise<DeliveryResult> =>
  runAlertDelivery({ jobsDb: h.jobsDb, db: h.db, sink });

beforeAll(async () => {
  h = await makeTestApp();
  await h.adminSql`INSERT INTO orgs (id, name, slug) VALUES
    (${orgA}, 'A', ${'a-' + orgA.slice(0, 8)}), (${orgB}, 'B', ${'b-' + orgB.slice(0, 8)})`;
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.adminSql`TRUNCATE alert_events, alerts`;
});

describe('alert delivery (§20 §5)', () => {
  it('delivers a warning event to its payload channels then stamps delivered_at', async () => {
    await fireEvent({ event_type: 'anomaly', severity: 'warning' });
    const sink = recordingSink();
    const res = await run(sink);
    expect(res.delivered).toBe(1);
    expect(sink.sent).toHaveLength(1);
    expect(sink.sent[0]!.channel.type).toBe('webhook');
    const [row] = await h.adminSql<{ delivered_at: Date | null }[]>`
      SELECT delivered_at FROM alert_events WHERE org_id = ${orgA}`;
    expect(row!.delivered_at).not.toBeNull();
  });

  it('an alert_id row uses the joined alerts.channels', async () => {
    const alertId = randomUUID();
    await h.adminSql`INSERT INTO alerts (id, org_id, name, kind, config, channels, enabled)
      VALUES (${alertId}, ${orgA}, 'a', 'budget_threshold', ${h.adminSql.json({} as never)},
              ${h.adminSql.json([WEBHOOK] as never)}, true)`;
    await fireEvent({ event_type: 'budget_threshold', severity: 'warning' }, { alertId });
    const sink = recordingSink();
    expect((await run(sink)).delivered).toBe(1);
    expect(sink.sent).toHaveLength(1);
  });

  it('suppresses an info event and a warning with no channels (dashboard-only)', async () => {
    await fireEvent({ event_type: 'anomaly', severity: 'info' });
    await fireEvent({ event_type: 'anomaly', severity: 'warning' }, { channels: [] });
    const sink = recordingSink();
    const res = await run(sink);
    expect(res.suppressed).toBe(2);
    expect(sink.sent).toHaveLength(0);
  });

  it('a failure defers by the backoff, then re-delivers once the window elapses', async () => {
    await fireEvent({ event_type: 'anomaly', severity: 'critical' });
    const sink = recordingSink(1); // first deliver throws
    expect((await run(sink)).failed).toBe(1);
    const [mid] = await h.adminSql<{ delivered_at: Date | null; delivery_attempts: number }[]>`
      SELECT delivered_at, delivery_attempts FROM alert_events WHERE org_id = ${orgA}`;
    expect(mid!.delivered_at).toBeNull();
    expect(Number(mid!.delivery_attempts)).toBe(1);
    await reclaimable();
    expect((await run(sink)).delivered).toBe(1); // retry succeeds
  });

  it('dead-letters after the attempt cap and never re-claims it', async () => {
    await fireEvent({ event_type: 'anomaly', severity: 'critical' });
    const sink = recordingSink(99); // every deliver fails
    let deadLettered = 0;
    for (let i = 0; i < 5; i++) {
      await reclaimable();
      deadLettered += (await run(sink)).deadLettered;
    }
    expect(deadLettered).toBe(1);
    const [row] = await h.adminSql<{ delivery_attempts: number }[]>`
      SELECT delivery_attempts FROM alert_events WHERE org_id = ${orgA}`;
    expect(Number(row!.delivery_attempts)).toBe(5);
    await reclaimable();
    expect((await run(sink)).failed).toBe(0); // capped row is not re-claimed
  });

  it('is multi-tenant: each org’s event delivers to its own channels only', async () => {
    await fireEvent({ event_type: 'anomaly', severity: 'warning' }, { org: orgA });
    await fireEvent({ event_type: 'anomaly', severity: 'critical' }, { org: orgB });
    const sink = recordingSink();
    const res = await run(sink);
    expect(res.delivered).toBe(2);
    expect(new Set(sink.sent.map((s) => s.alert.orgId))).toEqual(new Set([orgA, orgB]));
  });

  it('durably leases an event so overlapping drains send it only once', async () => {
    await fireEvent({ event_type: 'anomaly', severity: 'warning' });
    const sink = recordingSink();
    const [a, b] = await Promise.all([run(sink), run(sink)]);
    expect(a.delivered + b.delivered).toBe(1);
    expect(sink.sent).toHaveLength(1);
  });
});
