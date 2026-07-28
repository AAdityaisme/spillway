import { isIP } from 'node:net';
import { SpillwayError } from '@spillway/shared';
import { isBlockedIp } from './egress-classify.js';

/**
 * Validates a user-supplied `base_url` for an openai_compat provider key
 * (10-security §4). A gateway that forwards to arbitrary URLs is an SSRF cannon:
 * an attacker could point it at cloud metadata (169.254.169.254), internal
 * services, or localhost. We allow only https:// to a public host, with no
 * embedded credentials, no query/fragment, no encoded host, and reject
 * private/reserved IPs and the obfuscated IPv4 encodings (hex/octal/decimal/
 * short-form) commonly used to bypass naive checks.
 *
 * DNS rebinding (a public name resolving to a private IP at request time) is NOT
 * covered here — that is handled at egress by the data-plane connector
 * (egress-guard.ts), which re-classifies the RESOLVED address via the same
 * classifyIp table (egress-classify.ts) this file delegates to.
 */
export function assertSafeBaseUrl(
  raw: string,
  trustedHosts: ReadonlySet<string> = new Set(),
): void {
  // Control chars anywhere are a smuggling vector (CRLF header injection, embedded NUL). Check the raw
  // input before URL parsing normalizes them away. charCode scan avoids a control-char regex.
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) throw invalid('base_url contains control characters');
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalid('base_url is not a valid URL');
  }

  if (url.protocol !== 'https:') throw invalid('base_url must use https');
  if (url.username || url.password) throw invalid('base_url must not contain credentials');
  // A base_url is an origin (+ optional path prefix); a query/fragment is never legitimate and is a
  // classic smuggling vector (a `#@internal` fragment, a `?url=` re-target). Reject both. (part-3/03)
  if (url.hash) throw invalid('base_url must not contain a fragment');
  if (url.search) throw invalid('base_url must not contain a query string');
  // Encoding bypass: percent-encoding or non-ASCII surviving in the IDNA-normalized host is hostile
  // (a punycode/percent trick that resolves differently than it reads).
  if (url.hostname.includes('%') || [...url.hostname].some((ch) => ch.charCodeAt(0) > 0x7e))
    throw invalid('base_url host contains percent-encoding or non-ASCII');

  const host = url.hostname.toLowerCase();
  if (trustedHosts.has(host)) return;

  if (host === 'localhost' || host.endsWith('.localhost'))
    throw invalid('base_url host is loopback');
  if (host === 'metadata.google.internal' || host.endsWith('.internal')) {
    throw invalid('base_url host is an internal metadata host');
  }

  const bare = host.replace(/^\[|\]$/g, ''); // strip IPv6 literal brackets
  const ipVersion = isIP(bare); // 0 if not a canonical IP literal
  if (ipVersion === 4 || ipVersion === 6) {
    if (isReservedIp(bare, ipVersion)) throw invalid('base_url resolves to a private/reserved IP');
    return;
  }

  // Looks numeric but isn't a canonical IP → an obfuscated-IP bypass attempt
  // (e.g. 0x7f000001, 0177.0.0.1, 2130706433, 127.1). Reject outright.
  if (looksNumericHost(host)) throw invalid('base_url host is a malformed IP literal');
}

function invalid(message: string): SpillwayError {
  return new SpillwayError('invalid_request', message, { httpStatus: 422 });
}

function looksNumericHost(host: string): boolean {
  if (host.startsWith('0x') || host.startsWith('[')) return true;
  return /^[0-9.]+$/.test(host) || /^[0-9]+$/.test(host);
}

/**
 * True when `host` (a canonical IP literal) is private/reserved/loopback/link-local/CGNAT/multicast/…
 * Delegates to the shared classifyIp table (egress-classify.ts) so the config-time onboarding gate and
 * the runtime egress connector (egress-guard.ts) enforce ONE definition of "unsafe address". The
 * `version` arg is retained for the existing call sites; ipaddr.js infers it from the literal.
 */
export function isReservedIp(host: string, _version: number): boolean {
  return isBlockedIp(host);
}
