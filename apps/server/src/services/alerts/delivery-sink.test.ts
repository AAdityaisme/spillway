import { describe, it, expect, afterEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { createServer, type Server, type RequestListener } from 'node:http';
import type * as NodeDns from 'node:dns';
import type { lookup as DnsLookup } from 'node:dns';
import { fetch as undiciFetch, Agent } from 'undici';
import {
  makeHttpChannelSink,
  parseChannels,
  deliverTestFire,
  assertSafeChannel,
  type DeliverableAlert,
  type Channel,
  type ChannelSink,
} from './delivery.js';
import { ssrfGuardedDispatcher, ssrfConnector } from '../../data-plane/egress-guard.js';
import { isReservedIp } from '../../auth/ssrf.js';

/** Mockable `dns.lookup` seam for the nip.io-repro test below. `vi.mock` is hoisted above this file's
 *  imports, so the factory closes over `dnsLookupImpl` by reference — safe because the factory's `lookup`
 *  wrapper is only ever CALLED later, from inside a test body, well after this module has finished
 *  initializing. Default throws so an accidental un-mocked DNS call fails loudly instead of hitting the
 *  network. (`vi.spyOn` can't do this — Node's ESM `node:dns` namespace is non-configurable.) */
let dnsLookupImpl: typeof DnsLookup = (() => {
  throw new Error('dns.lookup not mocked for this test');
}) as unknown as typeof DnsLookup;

vi.mock('node:dns', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeDns>();
  return {
    ...actual,
    lookup: (...args: Parameters<typeof DnsLookup>) =>
      (dnsLookupImpl as (...a: Parameters<typeof DnsLookup>) => void)(...args),
  };
});

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

/**
 * F1 red-team round 2, defects 1 + 3: `assertSafeBaseUrl` ran at alert create/update but never again
 * at delivery, and separately had a trailing-dot FQDN bypass (`localhost.` matches neither the
 * `=== 'localhost'` nor `.endsWith('.localhost')` branch). Together this meant a channel URL that
 * slipped past write-time validation — or one that was simply safe when created and unsafe by the time
 * the alert actually fired — reached the network unchecked. `deliverTestFire` is the sharpest
 * reproduction: it takes `channels` straight from the DB row and hands them to the sink with NO
 * re-validation in between (control-plane/routes/alerts.ts:/alerts/:id/test), so it's the exact
 * "validated once, never again" path the finding describes.
 */
describe('delivery-time SSRF re-validation (F1 defects 1 + 3)', () => {
  it('assertSafeChannel rejects the trailing-dot bypass that assertSafeBaseUrl alone let through', () => {
    // Documents the exact repro from the handoff: new URL('https://localhost./hook').hostname is
    // 'localhost.', which the (pre-fix) create-time check did not reject.
    expect(() =>
      assertSafeChannel({ type: 'webhook', url: 'https://localhost./hook', secret: 's' }),
    ).toThrow(/loopback/);
    expect(() =>
      assertSafeChannel({ type: 'slack', webhook_url: 'https://metadata.google.internal./x' }),
    ).toThrow(/internal/);
  });

  it('deliverTestFire refuses an unsafe channel WITHOUT ever calling the sink — no network reaches it', async () => {
    let sinkCalled = false;
    const spySink: ChannelSink = {
      async deliver() {
        sinkCalled = true; // if this runs, the SSRF guard did not fire before dispatch
      },
    };
    const results = await deliverTestFire(
      {
        orgId: 'org-1',
        kind: 'anomaly',
        // Trailing-dot loopback: exactly the bypass the write-time check missed. A drift/rebind
        // scenario (safe at create, unsafe at send) looks identical from deliverTestFire's PoV — it
        // only ever sees "the channel URL, right now".
        channels: [{ type: 'webhook', url: 'https://localhost./hook', secret: 's' }],
      },
      spySink,
    );
    expect(sinkCalled).toBe(false);
    expect(results).toHaveLength(1);
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.error).toMatch(/loopback|reserved|private/);
  });

  it('a channel that is safe still delivers normally (the guard is not overzealous)', async () => {
    let called = 0;
    const spySink: ChannelSink = {
      async deliver() {
        called++;
      },
    };
    const results = await deliverTestFire(
      {
        orgId: 'org-1',
        kind: 'anomaly',
        channels: [{ type: 'webhook', url: 'https://hook.test/x', secret: 's' }],
      },
      spySink,
    );
    expect(results[0]!.ok).toBe(true);
    expect(called).toBe(1);
  });
});

/**
 * F1 red-team round 2, defect 2: index.ts passed the global fetch to makeHttpChannelSink, which
 * defaults to `redirect: 'follow'` — a webhook target that 302s to an internal/link-local address
 * (169.254.169.254, a docker-internal service, …) would be followed automatically, walking straight
 * past `assertSafeBaseUrl`'s one-time check on the ORIGINAL url. Proven here against a REAL local HTTP
 * server and REAL undici fetch (no stubbed FetchLike) — makeHttpChannelSink's `deliver()` is exercised
 * directly, independent of the write/delivery-time URL gate (that gate gets its own coverage above),
 * so this isolates exactly the redirect-following behavior of the fetch call itself.
 *
 * These tests target real loopback test servers (127.0.0.1), which the connect-time SSRF guard
 * (default `dispatcher`, see the DNS-rebind describe block below) would itself refuse to connect to —
 * that guard has its own dedicated coverage. Each sink here is given a plain `undici.Agent` explicitly
 * so these tests stay isolated to the one thing they're proving: redirect handling.
 */
describe('redirect is not followed at delivery (F1 defect 2)', () => {
  const servers: Server[] = [];
  afterEach(() => {
    for (const s of servers.splice(0)) s.close();
  });

  async function listen(handler: RequestListener): Promise<number> {
    const server = createServer(handler);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return (server.address() as { port: number }).port;
  }

  it('a webhook that 302s to a loopback target is not followed — the "internal" server is never hit', async () => {
    let internalHit = false;
    const internalPort = await listen((_req, res) => {
      internalHit = true;
      res.end('PWNED');
    });
    const originPort = await listen((_req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${internalPort}/steal` });
      res.end();
    });

    const sink = makeHttpChannelSink({
      fetch: undiciFetch as unknown as (
        url: string,
        init: Record<string, unknown>,
      ) => Promise<{ ok: boolean; status: number }>,
      dispatcher: new Agent(), // plain dispatcher — this test targets loopback, see block doc comment
    });

    await expect(
      sink.deliver(
        { type: 'webhook', url: `http://127.0.0.1:${originPort}/hook`, secret: 's' },
        {
          eventId: 'evt-1',
          orgId: 'org-1',
          severity: 'critical',
          payload: { event_type: 'anomaly' },
        },
      ),
    ).rejects.toThrow(/redirected \(302\)/);
    expect(internalHit).toBe(false); // the proof: the redirect target was never reached
  });

  it('the same 302 IS followed with the vulnerable redirect:"follow" default — confirms the origin server actually redirects', async () => {
    let internalHit = false;
    const internalPort = await listen((_req, res) => {
      internalHit = true;
      res.end('PWNED');
    });
    const originPort = await listen((_req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${internalPort}/steal` });
      res.end();
    });

    // Bare fetch with no redirect override — undici's (and the global fetch's) actual default —
    // reproduces the pre-fix vulnerability directly, proving the test servers are wired correctly and
    // that 'manual' above is doing real work, not passing vacuously.
    const res = await undiciFetch(`http://127.0.0.1:${originPort}/hook`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(internalHit).toBe(true);
  });

  it('slack channels get the same redirect protection', async () => {
    let internalHit = false;
    const internalPort = await listen((_req, res) => {
      internalHit = true;
      res.end('PWNED');
    });
    const originPort = await listen((_req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${internalPort}/steal` });
      res.end();
    });

    const sink = makeHttpChannelSink({
      fetch: undiciFetch as unknown as (
        url: string,
        init: Record<string, unknown>,
      ) => Promise<{ ok: boolean; status: number }>,
      dispatcher: new Agent(), // plain dispatcher — this test targets loopback, see block doc comment
    });

    await expect(
      sink.deliver(
        { type: 'slack', webhook_url: `http://127.0.0.1:${originPort}/hook` },
        {
          eventId: 'evt-1',
          orgId: 'org-1',
          severity: 'critical',
          payload: { event_type: 'anomaly' },
        },
      ),
    ).rejects.toThrow(/redirected \(302\)/);
    expect(internalHit).toBe(false);
  });
});

/**
 * P0 red-team fix: alert webhook egress did not resolve DNS through the SSRF connector, so a
 * syntactically-public `nip.io`-style hostname (e.g. `169.254.169.254.nip.io`, which really does resolve
 * to the literal cloud-metadata IP) sailed past `assertSafeChannel` — a hostname check that never
 * resolves DNS — and reached the metadata service. The fix pins alert delivery to the SAME connect-time
 * guard provider egress already uses (`ssrfGuardedDispatcher` / `ssrfConnector`, data-plane/egress-guard.ts)
 * instead of a second, parallel implementation.
 */
describe('connect-time DNS-rebind guard is wired into alert webhook delivery (P0: nip.io fix)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    dnsLookupImpl = (() => {
      throw new Error('dns.lookup not mocked for this test');
    }) as unknown as typeof DnsLookup;
  });

  it('makeHttpChannelSink defaults to the SAME guarded dispatcher provider egress uses (no parallel implementation)', async () => {
    let capturedDispatcher: unknown;
    const sink = makeHttpChannelSink({
      fetch: async (_url, init) => {
        capturedDispatcher = init.dispatcher;
        return { ok: true, status: 200 };
      },
    });
    await sink.deliver({ type: 'webhook', url: 'https://hook.test/x', secret: 's' }, alert);
    // Reference-equal to the process-wide singleton (data-plane/egress-guard.ts) — proves this is the
    // exact same guard object provider egress dispatches through, not a lookalike.
    expect(capturedDispatcher).toBe(ssrfGuardedDispatcher());
  });

  it('a literal private-range IP webhook URL is rejected before any network call', () => {
    expect(() =>
      assertSafeChannel({ type: 'webhook', url: 'https://10.0.0.5/hook', secret: 's' }),
    ).toThrow(/private|reserved/);
    expect(() =>
      assertSafeChannel({ type: 'slack', webhook_url: 'https://169.254.169.254/x' }),
    ).toThrow(/private|reserved/);
  });

  it('a hostname that RESOLVES to the cloud-metadata IP is refused at connect time — the nip.io repro', async () => {
    // `assertSafeChannel` is a hostname check; it would happily pass `169.254.169.254.nip.io` (looks
    // like any other public DNS name). The connect-time guard is what actually has to catch this, so
    // this test drives the SAME connector `makeHttpChannelSink` now wires in (ssrfConnector), with the
    // resolver mocked to reproduce exactly what nip.io really does: resolve that hostname straight to
    // the literal metadata IP.
    dnsLookupImpl = ((
      _hostname: string,
      _opts: unknown,
      cb: (err: NodeJS.ErrnoException | null, addrs?: unknown) => void,
    ) => {
      cb(null, [{ address: '169.254.169.254', family: 4 }]);
    }) as unknown as typeof DnsLookup;

    const { err } = await new Promise<{ err: NodeJS.ErrnoException | null }>((resolve) => {
      ssrfConnector(
        {
          hostname: '169.254.169.254.nip.io',
          host: '169.254.169.254.nip.io',
          protocol: 'https:',
          port: '443',
        } as Parameters<typeof ssrfConnector>[0],
        (connErr, socket) => {
          const s = socket as { destroy?: () => void } | null;
          if (s?.destroy) s.destroy();
          resolve({ err: connErr ?? null });
        },
      );
    });
    expect(err).toBeTruthy();
    expect(err?.code).toBe('ESSRFBLOCKED');
    expect(err?.message).toMatch(/private|reserved/);
  });

  it('a hostname that resolves only to a public address is not blocked by the guard', () => {
    // The connector's block decision is exactly `isReservedIp(resolvedAddress, family)` (egress-guard.ts);
    // asserting the real predicate is false for a public unicast address proves the guard lets legitimate
    // webhook targets through. (A full live socket connect isn't exercised here — same reasoning delivery.ts
    // documents: there's no way to stand up a hermetic "public" origin server, since any locally-bindable
    // address is loopback/private and would be correctly rejected by this same guard.)
    expect(isReservedIp('93.184.216.34', 4)).toBe(false); // example.com — public unicast
  });
});
