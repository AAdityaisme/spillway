import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeTestApp, type TestHarness } from '../../test/helpers/app.js';

/**
 * Control-plane IP rate limiting (10-security §5.4). Runs before auth, so unauthenticated floods are
 * throttled; loopback bypasses so the test harness/local dev is unaffected. The limiter fires before
 * auth, so an unauthenticated POST is enough to exercise it (429 arrives instead of the usual 401).
 */
describe('control-plane IP rate limiting (10-security §5.4)', () => {
  let h: TestHarness;
  beforeEach(async () => {
    h = await makeTestApp();
  });
  afterEach(async () => {
    await h.close();
  });

  it('loopback bypasses the limiter (dev/test never throttled)', async () => {
    for (let i = 0; i < 15; i++) {
      const res = await h.app.inject({
        method: 'POST',
        url: '/api/orgs',
        payload: { name: 'x', slug: 'x' },
      });
      expect(res.statusCode).not.toBe(429);
    }
  });

  it('a real client IP is throttled on POST /api/orgs (10/hr) with Retry-After', async () => {
    const headers = { 'x-forwarded-for': '9.9.9.9' };
    let limited = false;
    for (let i = 0; i < 12; i++) {
      const res = await h.app.inject({
        method: 'POST',
        url: '/api/orgs',
        headers,
        payload: { name: 'x', slug: 'x' },
      });
      if (res.statusCode === 429) {
        limited = true;
        expect(res.headers['retry-after']).toBeDefined();
        expect(res.json<{ error: { code: string } }>().error.code).toBe('rate_limited');
        break;
      }
    }
    expect(limited).toBe(true);
  });

  it('locks out an IP after too many invalid-JWT 401s (§5.4 row 3)', async () => {
    const headers = { 'x-forwarded-for': '8.8.8.8', authorization: 'Bearer not-a-real-jwt' };
    let lockedOut = false;
    for (let i = 0; i < 25; i++) {
      const res = await h.app.inject({ method: 'GET', url: '/api/orgs', headers });
      if (res.statusCode === 429) {
        lockedOut = true;
        expect(res.json<{ error: { message: string } }>().error.message).toMatch(
          /failed authentication/i,
        );
        break;
      }
      expect(res.statusCode).toBe(401); // invalid JWT, before the lockout trips
    }
    expect(lockedOut).toBe(true);
  });
});
