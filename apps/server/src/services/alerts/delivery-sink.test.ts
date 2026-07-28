import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  makeHttpChannelSink,
  parseChannels,
  deliverTestFire,
  type DeliverableAlert,
  type Channel,
  type ChannelSink,
} from './delivery.js';

const alert: DeliverableAlert = {
  eventId: 'evt-123',
  orgId: 'org-abc',
  severity: 'critical',
  payload: { event_type: 'anomaly', scope_id: 'vk-secret', spend_usd: '9999.99', ratio: 42 },
};

describe('makeHttpChannelSink — payload redaction (expanded-audit CRITICAL)', () => {
  it('slack: never serializes the raw payload (no spend/scope exfil); sends only routing fields', async () => {
    let body = '';
    const sink = makeHttpChannelSink({
      fetch: async (_url, init) => {
        body = String(init.body);
        return { ok: true, status: 200 };
      },
    });
    await sink.deliver({ type: 'slack', webhook_url: 'https://hooks.slack.test/x' }, alert);
    expect(body).not.toContain('9999.99'); // spend figure not leaked
    expect(body).not.toContain('vk-secret'); // scope id not leaked
    expect(body).not.toContain('ratio'); // no raw payload dump
    expect(body).toContain('anomaly'); // event_type (non-sensitive) is fine
    expect(body).toContain('evt-123'); // event-id reference for lookup
    expect(body).toContain('CRITICAL');
  });

  it('webhook: signs the exact body with HMAC-SHA256 and leaks no payload details', async () => {
    let sig = '';
    let body = '';
    const sink = makeHttpChannelSink({
      fetch: async (_url, init) => {
        body = String(init.body);
        sig = String((init.headers as Record<string, string>)['x-spillway-signature']);
        return { ok: true, status: 200 };
      },
    });
    await sink.deliver({ type: 'webhook', url: 'https://hook.test/x', secret: 's3cr3t' }, alert);
    expect(body).not.toContain('9999.99');
    expect(body).not.toContain('vk-secret');
    expect(sig).toBe(createHmac('sha256', 's3cr3t').update(body).digest('hex')); // verifiable signature
  });

  it('webhook: a non-2xx response throws so the drain retries', async () => {
    const sink = makeHttpChannelSink({ fetch: async () => ({ ok: false, status: 503 }) });
    await expect(
      sink.deliver({ type: 'webhook', url: 'https://hook.test/x', secret: 's' }, alert),
    ).rejects.toThrow(/503/);
  });

  it('email: routes to the injected sender with a redacted body', async () => {
    let to = '';
    let text = '';
    const sink = makeHttpChannelSink({
      fetch: async () => ({ ok: true, status: 200 }),
      email: {
        send: async (t, _subject, body) => {
          to = t;
          text = body;
        },
      },
    });
    await sink.deliver({ type: 'email', to: 'ops@acme.test' }, alert);
    expect(to).toBe('ops@acme.test');
    expect(text).not.toContain('9999.99');
    expect(text).toContain('evt-123');
  });
});

describe('parseChannels', () => {
  it('keeps well-formed channels and drops malformed ones', () => {
    const parsed = parseChannels([
      { type: 'slack', webhook_url: 'https://x' },
      { type: 'email', to: 'a@b.c' },
      { type: 'webhook', url: 'https://y', secret: 's' },
      { type: 'slack' }, // missing webhook_url → dropped
      { type: 'unknown' }, // unknown type → dropped
      'garbage',
    ]);
    expect(parsed.map((c) => c.type)).toEqual(['slack', 'email', 'webhook']);
  });
  it('accepts a JSON-string array (raw jsonb from execute)', () => {
    expect(parseChannels('[{"type":"slack","webhook_url":"https://x"}]')).toHaveLength(1);
  });
});

describe('deliverTestFire (§5.6)', () => {
  const slack: Channel = { type: 'slack', webhook_url: 'https://hooks.test/s' };
  const hook: Channel = { type: 'webhook', url: 'https://hook.test/w', secret: 's' };

  /** A sink that records each delivery and optionally rejects/hangs for a chosen channel type. */
  function recordingSink(opts: { failType?: Channel['type']; hangType?: Channel['type'] } = {}): {
    sink: ChannelSink;
    calls: { channel: Channel; alert: DeliverableAlert }[];
  } {
    const calls: { channel: Channel; alert: DeliverableAlert }[] = [];
    return {
      calls,
      sink: {
        async deliver(channel, alert) {
          calls.push({ channel, alert });
          if (opts.hangType === channel.type) await new Promise(() => {}); // never settles
          if (opts.failType === channel.type) throw new Error('boom');
        },
      },
    };
  }

  it('synthesizes a test:true payload with the kind default severity and returns per-channel ok', async () => {
    const { sink, calls } = recordingSink();
    const results = await deliverTestFire(
      { orgId: 'org-1', kind: 'anomaly_confirmed', channels: [slack, hook] },
      sink,
    );
    expect(results).toEqual([
      { channel: 'slack', target: 'https://hooks.test/s', ok: true },
      { channel: 'webhook', target: 'https://hook.test/w', ok: true },
    ]);
    expect(calls[0]!.alert.payload).toMatchObject({
      event_type: 'anomaly_confirmed',
      test: true,
      severity: 'critical', // defaultSeverityForKind(anomaly_confirmed)
    });
    expect(calls[0]!.alert.severity).toBe('critical');
    expect(calls[0]!.alert.eventId).toMatch(/^test-/);
  });

  it('isolates a failing channel — others still deliver', async () => {
    const { sink } = recordingSink({ failType: 'webhook' });
    const results = await deliverTestFire(
      { orgId: 'o', kind: 'budget_threshold', channels: [slack, hook] },
      sink,
    );
    expect(results.find((r) => r.channel === 'slack')!.ok).toBe(true);
    const w = results.find((r) => r.channel === 'webhook')!;
    expect(w.ok).toBe(false);
    expect(w.error).toBe('boom');
  });

  it('bounds a hung channel by the timeout (ok:false, does not hang the endpoint)', async () => {
    const { sink } = recordingSink({ hangType: 'slack' });
    const results = await deliverTestFire(
      { orgId: 'o', kind: 'anomaly', channels: [slack] },
      sink,
      { timeoutMs: 20 },
    );
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.error).toMatch(/timed out/);
  });

  it('no channels → empty result set', async () => {
    const { sink } = recordingSink();
    expect(await deliverTestFire({ orgId: 'o', kind: 'anomaly', channels: [] }, sink)).toEqual([]);
  });
});
