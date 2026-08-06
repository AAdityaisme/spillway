import { describe, it, expect, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { authKitRoutes, SESSION_COOKIE, STATE_COOKIE } from './authkit-routes.js';
import type { AuthKit } from './authkit.js';

/** Runs /auth/login and returns the state nonce the server minted, for use on the callback. */
async function beginLogin(app: FastifyInstance): Promise<string> {
  const res = await app.inject({ method: 'GET', url: '/auth/login' });
  const state = res.cookies.find((c) => c.name === STATE_COOKIE)?.value;
  if (!state) throw new Error('no state cookie was issued by /auth/login');
  return state;
}

/**
 * Drives the hosted-login flow with a fake AuthKit — no WorkOS, no network. What matters here
 * is the seam behaviour the SDK does NOT give us for free: cookie flags, refresh-rotation
 * persistence, and that a dead session cannot leave a stale cookie behind.
 */
function fakeAuthKit(over: Partial<AuthKit> = {}): AuthKit {
  return {
    authorizationUrl: ({ screenHint }) => `https://auth.example.com/authorize?hint=${screenHint}`,
    exchangeCode: async (code) => ({
      sealedSession: `sealed(${code})`,
      accessToken: `at(${code})`,
    }),
    loadSession: async (sealed) => ({ accessToken: `at-from(${sealed})`, sessionId: 'sess_1' }),
    logoutUrl: (sessionId) => `https://auth.example.com/logout?session=${sessionId}`,
    ...over,
  };
}

async function build(authKit: AuthKit, nodeEnv = 'test'): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(authKitRoutes, {
    authKit,
    config: { NODE_ENV: nodeEnv, PUBLIC_URL: 'http://localhost:3000' } as never,
  });
  await app.ready();
  return app;
}

describe('AuthKit hosted-login routes (M4-auth)', () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    app = await build(fakeAuthKit());
  });

  it('GET /auth/login redirects to AuthKit with the sign-in screen hint', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/login' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('https://auth.example.com/authorize?hint=sign-in');
  });

  it('GET /auth/signup asks AuthKit for the sign-up screen', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/signup' });
    expect(res.headers.location).toBe('https://auth.example.com/authorize?hint=sign-up');
  });

  it('callback exchanges the code and sets an httpOnly session cookie', async () => {
    const state = await beginLogin(app);
    const res = await app.inject({
      method: 'GET',
      url: `/auth/callback?code=abc123&state=${state}`,
      cookies: { [STATE_COOKIE]: state },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/app');

    const set = res.cookies.find((c) => c.name === SESSION_COOKIE);
    expect(set?.value).toBe('sealed(abc123)');
    expect(set?.httpOnly).toBe(true);
    expect(set?.sameSite?.toLowerCase()).toBe('lax');
  });

  it('derives the Secure flag from the deployment scheme, not NODE_ENV', async () => {
    // Regression guard: keying Secure on NODE_ENV shipped a non-Secure session cookie from any
    // HTTPS deployment that was not literally NODE_ENV=production (staging, preview, debug box).
    const state = await beginLogin(app);
    const dev = await app.inject({
      method: 'GET',
      url: `/auth/callback?code=x&state=${state}`,
      cookies: { [STATE_COOKIE]: state },
    });
    expect(dev.cookies.find((c) => c.name === SESSION_COOKIE)?.secure).toBeFalsy();

    // NODE_ENV stays 'test' — only the URL scheme changes, and that alone must set Secure.
    const httpsApp = Fastify();
    await httpsApp.register(authKitRoutes, {
      authKit: fakeAuthKit(),
      config: { NODE_ENV: 'test', PUBLIC_URL: 'https://spillway.cloud' } as never,
    });
    await httpsApp.ready();
    const s2 = await beginLogin(httpsApp);
    const https = await httpsApp.inject({
      method: 'GET',
      url: `/auth/callback?code=x&state=${s2}`,
      cookies: { [STATE_COOKIE]: s2 },
    });
    expect(https.cookies.find((c) => c.name === SESSION_COOKIE)?.secure).toBe(true);
  });

  it('never issues a session cookie when AuthKit rejects the code', async () => {
    const failing = await build(
      fakeAuthKit({
        exchangeCode: async () => {
          throw new Error('invalid_grant');
        },
      }),
    );
    const state = await beginLogin(failing);
    const res = await failing.inject({
      method: 'GET',
      url: `/auth/callback?code=stale&state=${state}`,
      cookies: { [STATE_COOKIE]: state },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('auth_error=exchange_failed');
    expect(res.cookies.find((c) => c.name === SESSION_COOKIE)?.value).toBeFalsy();
  });

  it('passes an AuthKit error through to the landing page instead of throwing', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/callback?error=access_denied' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/?auth_error=access_denied');
  });

  it('GET /auth/session 401s with no cookie and never leaks a token', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/session' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ authenticated: false });
    expect(res.body).not.toContain('access_token');
  });

  it('GET /auth/session returns the access token for a live session', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/auth/session',
      cookies: { [SESSION_COOKIE]: 'sealed-abc' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ authenticated: true, access_token: 'at-from(sealed-abc)' });
  });

  it('persists the rotated cookie when WorkOS refreshes the session', async () => {
    // The refresh is worthless if the rotated cookie is dropped — the next request would
    // present the old sealed value and the user would be bounced early.
    const rotating = await build(
      fakeAuthKit({
        loadSession: async () => ({
          accessToken: 'fresh-at',
          sealedSession: 'rotated-sealed',
          sessionId: 'sess_2',
        }),
      }),
    );
    const res = await rotating.inject({
      method: 'GET',
      url: '/auth/session',
      cookies: { [SESSION_COOKIE]: 'old-sealed' },
    });
    expect(res.json().access_token).toBe('fresh-at');
    expect(res.cookies.find((c) => c.name === SESSION_COOKIE)?.value).toBe('rotated-sealed');
  });

  it('clears the cookie when the session is dead so the browser stops replaying it', async () => {
    const dead = await build(fakeAuthKit({ loadSession: async () => null }));
    const res = await dead.inject({
      method: 'GET',
      url: '/auth/session',
      cookies: { [SESSION_COOKIE]: 'expired' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.cookies.find((c) => c.name === SESSION_COOKIE)?.value).toBe('');
  });

  it('logout clears the cookie and returns the WorkOS revocation URL', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      cookies: { [SESSION_COOKIE]: 'sealed-abc' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().logout_url).toBe('https://auth.example.com/logout?session=sess_1');
    expect(res.cookies.find((c) => c.name === SESSION_COOKIE)?.value).toBe('');
  });

  it('logout still clears the cookie when WorkOS lookup fails', async () => {
    const broken = await build(
      fakeAuthKit({
        loadSession: async () => {
          throw new Error('workos down');
        },
      }),
    );
    const res = await broken.inject({
      method: 'POST',
      url: '/auth/logout',
      cookies: { [SESSION_COOKIE]: 'sealed-abc' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.cookies.find((c) => c.name === SESSION_COOKIE)?.value).toBe('');
  });

  // ── H1 regression: login CSRF / session fixation ────────────────────────────────────────
  // Without the state nonce, an attacker hands a victim /auth/callback?code=<their own code>
  // and the server seals the ATTACKER's session into the VICTIM's browser. The victim then
  // types real provider API keys into the attacker's org.
  describe('state nonce (login CSRF / session fixation)', () => {
    it('issues a one-time state cookie and echoes it to AuthKit', async () => {
      const res = await app.inject({ method: 'GET', url: '/auth/login' });
      const c = res.cookies.find((x) => x.name === STATE_COOKIE);
      expect(c?.value).toMatch(/^[0-9a-f-]{36}$/);
      expect(c?.httpOnly).toBe(true);
      expect(c?.maxAge).toBe(600);
    });

    it('signup issues a state cookie too', async () => {
      const res = await app.inject({ method: 'GET', url: '/auth/signup' });
      expect(res.cookies.find((x) => x.name === STATE_COOKIE)?.value).toBeTruthy();
    });

    it('REJECTS a callback carrying no state at all (the bare attack)', async () => {
      const res = await app.inject({ method: 'GET', url: '/auth/callback?code=attacker_code' });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/?auth_error=bad_state');
      expect(res.cookies.find((c) => c.name === SESSION_COOKIE)?.value).toBeFalsy();
    });

    it('REJECTS a state param that does not match the cookie', async () => {
      const state = await beginLogin(app);
      const res = await app.inject({
        method: 'GET',
        url: '/auth/callback?code=attacker_code&state=not-the-one',
        cookies: { [STATE_COOKIE]: state },
      });
      expect(res.headers.location).toBe('/?auth_error=bad_state');
      expect(res.cookies.find((c) => c.name === SESSION_COOKIE)?.value).toBeFalsy();
    });

    it('REJECTS a forged state when the victim has no state cookie', async () => {
      // The attacker controls the query string but cannot set a cookie on the victim's browser.
      const res = await app.inject({
        method: 'GET',
        url: '/auth/callback?code=attacker_code&state=attacker-chosen',
      });
      expect(res.headers.location).toBe('/?auth_error=bad_state');
      expect(res.cookies.find((c) => c.name === SESSION_COOKIE)?.value).toBeFalsy();
    });

    it('never spends the code when state validation fails', async () => {
      let exchanged = 0;
      const counting = await build(
        fakeAuthKit({
          exchangeCode: async (code) => {
            exchanged++;
            return { sealedSession: `sealed(${code})`, accessToken: 'at' };
          },
        }),
      );
      await counting.inject({ method: 'GET', url: '/auth/callback?code=attacker_code' });
      expect(exchanged).toBe(0);
    });

    it('burns the state cookie so a replayed callback cannot reuse it', async () => {
      const state = await beginLogin(app);
      const res = await app.inject({
        method: 'GET',
        url: `/auth/callback?code=abc&state=${state}`,
        cookies: { [STATE_COOKIE]: state },
      });
      expect(res.cookies.find((c) => c.name === STATE_COOKIE)?.value).toBe('');
    });
  });

  // ── M2 regression: an inconclusive check must not destroy a live session ─────────────────
  it('401s WITHOUT clearing the cookie when session validation is inconclusive', async () => {
    // A concurrent tab already rotated the refresh token, or WorkOS blipped. Clearing here
    // would log the user out of every tab despite a perfectly valid WorkOS session.
    const flaky = await build(
      fakeAuthKit({
        loadSession: async () => {
          throw new Error('workos 500');
        },
      }),
    );
    const res = await flaky.inject({
      method: 'GET',
      url: '/auth/session',
      cookies: { [SESSION_COOKIE]: 'still-good' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.cookies.find((c) => c.name === SESSION_COOKIE)).toBeUndefined();
  });

  // ── L1 regression: the session response carries a bearer token ───────────────────────────
  it('marks /auth/session no-store so no proxy retains the token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/auth/session',
      cookies: { [SESSION_COOKIE]: 'sealed-abc' },
    });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('503s rather than crashing when AuthKit is not configured', async () => {
    const bare = Fastify();
    await bare.register(authKitRoutes, { config: { NODE_ENV: 'test' } as never });
    await bare.ready();
    const res = await bare.inject({ method: 'GET', url: '/auth/login' });
    expect(res.statusCode).toBe(503);
  });
});
