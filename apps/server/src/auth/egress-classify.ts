import ipaddr from 'ipaddr.js';

/**
 * SSRF IP classifier (10-security §4 / part-3/03 egress-ssrf) — the SINGLE source of truth for
 * "is this resolved address safe to connect to". Shared by the onboarding guard (auth/ssrf.ts, config
 * time) and the runtime connector (data-plane/egress-guard.ts, connect time) so the two can never
 * disagree. Only globally-routable UNICAST addresses are allowed; everything else — loopback,
 * link-local (incl. 169.254.169.254 metadata), private, CGNAT, multicast, reserved, ULA, IPv4-mapped,
 * 6to4, NAT64 (rfc6145/6052), teredo — is blocked. IPv4-mapped IPv6 is blocked outright (a `::ffff:`
 * host is an encoding-bypass vector, never a legitimate provider endpoint).
 */

/**
 * Extra deny CIDRs that ipaddr.js `.range()` reports as `unicast` but which are NOT public: the
 * documentation/benchmarking/protocol-assignment blocks. A legitimate upstream provider never lives
 * here, so denying them is pure hardening with no false-positive cost.
 */
const EXTRA_DENY = [
  '192.0.0.0/24', // IETF protocol assignments
  '192.0.2.0/24', // TEST-NET-1 (documentation)
  '198.51.100.0/24', // TEST-NET-2
  '203.0.113.0/24', // TEST-NET-3
  '198.18.0.0/15', // benchmarking
  '2001:db8::/32', // IPv6 documentation
  '2001:20::/28', // ORCHIDv2
  '100::/64', // IPv6 discard-only
].map((c) => ipaddr.parseCIDR(c));

export interface IpVerdict {
  blocked: boolean;
  reason: string;
}

/** Classify a resolved IP literal. `blocked:true` ⇒ MUST NOT connect (with a machine reason for logs). */
export function classifyIp(ip: string): IpVerdict {
  let addr: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    addr = ipaddr.parse(ip);
  } catch {
    return { blocked: true, reason: 'unparseable_ip' }; // fail closed on anything we can't reason about
  }
  const range = addr.range();
  if (range !== 'unicast') return { blocked: true, reason: range }; // loopback/linkLocal/private/…/ipv4Mapped
  for (const cidr of EXTRA_DENY) {
    // match() throws on a v4-vs-v6 mismatch — only test the same-kind CIDRs.
    if (addr.kind() === cidr[0].kind() && addr.match(cidr)) {
      return { blocked: true, reason: 'reserved_special' };
    }
  }
  return { blocked: false, reason: 'public' };
}

/** True iff the resolved address is unsafe to connect to. Convenience wrapper for existing callers. */
export function isBlockedIp(ip: string): boolean {
  return classifyIp(ip).blocked;
}
