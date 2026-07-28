import { Agent, buildConnector, type Dispatcher } from 'undici';
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { isReservedIp } from '../auth/ssrf.js';

/**
 * SSRF-hardened egress dispatcher for provider upstreams (10-security §4; closes M2 red-team CRITICALs).
 *
 * The config-time base_url check (auth/ssrf.ts) only proves the HOSTNAME is public. Two holes remain at
 * egress, which that file explicitly delegates to "the data-plane dispatcher in M2":
 *   1. DNS rebinding — a public name that resolves to 169.254.169.254 / 10.x AT CONNECT TIME.
 *   2. (paired with dispatch.ts redirect:'error') a 3xx to a private host.
 *
 * undici does NOT honour a `connect: { lookup }` option (verified), so we install a custom CONNECTOR:
 * it resolves the host, drops every reserved address, and connects to a surviving PUBLIC IP by pinning
 * that IP as the connect host (preserving the original hostname as the TLS servername) — so there is no
 * TOCTOU window between the check and the connect, and a host that resolves only to reserved space is
 * refused. Applied to every provider dispatch (openai/anthropic/gemini/openai_compat), defense-in-depth.
 */

const baseConnector = buildConnector({});

type ConnectOpts = Parameters<ReturnType<typeof buildConnector>>[0];
type ConnectCb = Parameters<ReturnType<typeof buildConnector>>[1];

/** SSRF-checking undici connector. Exported for unit tests. */
export function ssrfConnector(opts: ConnectOpts, callback: ConnectCb): void {
  const hostname = opts.hostname;
  dnsLookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
    if (err) return callback(err, null);
    const safe = (addresses as LookupAddress[]).filter((a) => !isReservedIp(a.address, a.family));
    if (safe.length === 0) {
      const blocked: NodeJS.ErrnoException = Object.assign(
        new Error(`egress blocked: ${hostname} resolves only to a private/reserved address`),
        { code: 'ESSRFBLOCKED' },
      );
      return callback(blocked, null);
    }
    // Pin the validated IP as the connect host; keep the original hostname as the TLS SNI/servername.
    baseConnector(
      { ...opts, hostname: safe[0]!.address, servername: opts.servername || hostname },
      callback,
    );
  });
}

let shared: Agent | null = null;

/** Process-wide singleton (an Agent is a connection pool; one per process). */
export function ssrfGuardedDispatcher(): Dispatcher {
  shared ??= new Agent({ connect: ssrfConnector });
  return shared;
}
