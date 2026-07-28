import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeTestApp, type TestHarness } from '../test/helpers/app.js';

/**
 * Security response headers (10-security §7.1). Every response carries the baseline hardening headers;
 * JSON/CSV API responses additionally get a lock-everything-down CSP, while HTML gets only the
 * clickjacking guard (so the founder's inline-script landing page is not broken).
 */
describe('security headers (10-security §7)', () => {
  let h: TestHarness;
  beforeEach(async () => {
    h = await makeTestApp();
  });
  afterEach(async () => {
    await h.close();
  });

  it('sets the baseline hardening headers on every response', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/healthz' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(String(res.headers['permissions-policy'])).toContain('geolocation=()');
    expect(String(res.headers['content-security-policy'])).toContain("frame-ancestors 'none'");
  });

  it('locks JSON API responses down to default-src none', async () => {
    // Unauthenticated /api call → JSON error, but the strict CSP still applies.
    const res = await h.app.inject({ method: 'GET', url: '/api/orgs' });
    expect(String(res.headers['content-type'])).toContain('application/json');
    expect(String(res.headers['content-security-policy'])).toContain("default-src 'none'");
  });
});
