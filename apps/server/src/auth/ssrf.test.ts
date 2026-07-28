import { describe, it, expect } from 'vitest';
import { assertSafeBaseUrl } from './ssrf.js';

describe('assertSafeBaseUrl', () => {
  it('allows a public https host', () => {
    expect(() => assertSafeBaseUrl('https://api.together.xyz/v1')).not.toThrow();
  });

  it('rejects non-https', () => {
    expect(() => assertSafeBaseUrl('http://api.example.com')).toThrow(/https/);
  });

  it('rejects embedded credentials', () => {
    expect(() => assertSafeBaseUrl('https://user:pw@api.example.com')).toThrow(/credentials/);
  });

  it('rejects loopback + internal names', () => {
    expect(() => assertSafeBaseUrl('https://localhost/v1')).toThrow();
    expect(() => assertSafeBaseUrl('https://metadata.google.internal/')).toThrow();
  });

  it('rejects the cloud metadata IP', () => {
    expect(() => assertSafeBaseUrl('https://169.254.169.254/latest/meta-data')).toThrow(
      /private|reserved/,
    );
  });

  it('rejects private + loopback IPv4 ranges', () => {
    for (const h of ['10.0.0.1', '172.16.0.1', '192.168.1.1', '127.0.0.1', '0.0.0.0']) {
      expect(() => assertSafeBaseUrl(`https://${h}`)).toThrow();
    }
  });

  it('rejects obfuscated IPv4 encodings', () => {
    for (const h of ['0x7f000001', '2130706433', '0177.0.0.1', '127.1']) {
      expect(() => assertSafeBaseUrl(`https://${h}`)).toThrow();
    }
  });

  it('rejects IPv4-mapped IPv6 loopback', () => {
    expect(() => assertSafeBaseUrl('https://[::ffff:127.0.0.1]')).toThrow();
  });

  it('honors a trusted-host override', () => {
    expect(() => assertSafeBaseUrl('https://localhost:8443', new Set(['localhost']))).not.toThrow();
  });

  // part-3/03 hardening — reject the query/fragment/encoding smuggling vectors.
  it('rejects a query string or fragment', () => {
    expect(() =>
      assertSafeBaseUrl('https://api.example.com/v1?url=http://169.254.169.254'),
    ).toThrow(/query/);
    expect(() => assertSafeBaseUrl('https://api.example.com/v1#@internal')).toThrow(/fragment/);
  });

  it('rejects control characters in the URL (CRLF / NUL smuggling)', () => {
    expect(() => assertSafeBaseUrl('https://api.example.com/v1\r\nHost: internal')).toThrow(
      /control/,
    );
    expect(() => assertSafeBaseUrl('https://api.example.com/\x00')).toThrow(/control/);
  });

  it('a percent-encoded reserved host is decoded then caught by the IP classifier', () => {
    // URL normalizes %-encoding in the host, so the classifier sees the real target and blocks it —
    // the encoding never smuggles a reserved address past the check.
    expect(() => assertSafeBaseUrl('https://%31%32%37%2e%30%2e%30%2e%31')).toThrow(); // → 127.0.0.1
  });

  it('rejects the newly-covered reserved ranges (CGNAT, TEST-NET, 6to4, NAT64)', () => {
    for (const h of [
      '100.64.0.1',
      '192.0.2.1',
      '198.51.100.9',
      '[2002:7f00:1::]',
      '[64:ff9b::a00:1]',
    ]) {
      expect(() => assertSafeBaseUrl(`https://${h}`), h).toThrow(/private|reserved/);
    }
  });
});
