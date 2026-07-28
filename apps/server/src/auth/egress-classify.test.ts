import { describe, it, expect } from 'vitest';
import { classifyIp, isBlockedIp } from './egress-classify.js';

/**
 * 10-security §4 / part-3/03 — the SSRF IP classifier's malicious-input matrix. Only globally-routable
 * unicast is allowed; every reserved/private/embedded-v4 form is blocked (defense-in-depth against a
 * DNS-rebind or an obfuscated-literal bypass).
 */
describe('classifyIp — blocked (unsafe) addresses', () => {
  const blocked: Array<[string, string]> = [
    ['127.0.0.1', 'loopback'],
    ['0.0.0.0', 'unspecified/broadcast'],
    ['10.0.0.1', 'private'],
    ['172.16.0.1', 'private'],
    ['192.168.1.1', 'private'],
    ['169.254.169.254', 'AWS/GCP metadata (link-local)'],
    ['100.64.0.1', 'CGNAT'],
    ['224.0.0.1', 'multicast'],
    ['240.0.0.1', 'reserved'],
    ['192.0.2.1', 'TEST-NET-1'],
    ['198.51.100.1', 'TEST-NET-2'],
    ['203.0.113.1', 'TEST-NET-3'],
    ['198.18.0.1', 'benchmarking'],
    ['::1', 'v6 loopback'],
    ['fe80::1', 'v6 link-local'],
    ['fc00::1', 'v6 ULA'],
    ['fd00::1', 'v6 ULA'],
    ['::ffff:10.0.0.1', 'v4-mapped private'],
    ['::ffff:169.254.169.254', 'v4-mapped metadata'],
    ['2002:7f00:1::', '6to4 embedding 127.0.0.1'],
    ['64:ff9b::a00:1', 'NAT64 embedding 10.0.0.1'],
    ['2001:db8::1', 'v6 documentation'],
    ['not-an-ip', 'unparseable → fail closed'],
  ];
  it.each(blocked)('blocks %s (%s)', (ip) => {
    expect(classifyIp(ip).blocked).toBe(true);
    expect(isBlockedIp(ip)).toBe(true);
  });
});

describe('classifyIp — allowed (public unicast)', () => {
  const allowed = ['8.8.8.8', '1.1.1.1', '140.82.113.4', '2001:4860:4860::8888', '2606:4700::1111'];
  it.each(allowed)('allows %s', (ip) => {
    expect(classifyIp(ip)).toEqual({ blocked: false, reason: 'public' });
  });
});
