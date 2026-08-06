import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import cookie from '@fastify/cookie';
import type { Config } from '../config.js';
import { makeAuthKit, authKitConfigured, type AuthKit } from './authkit.js';

/**
 * AuthKit hosted-login routes (M4-auth, ADR-023).
 *
 * Registered OUTSIDE the control-plane plugin on purpose: /auth/login and /auth/callback are
 * reached by a logged-out browser, so they must not sit behind the Bearer auth hook they exist
 * to bootstrap.
 *
 * The SPA never sees the cookie (httpOnly) and never stores the access token (memory only),
 * so /auth/session is the only way it obtains a token — and every call re-validates against
 * WorkOS, which is also where a silent refresh happens.
 */

export const SESSION_COOKIE = 'spillway_session';
/** Short-lived OAuth nonce, set at /auth/login and consumed once at /auth/callback. */
export const STATE_COOKIE = 'spillway_oauth_state';

export interface AuthKitRoutesDeps {
  /** Optional to match the rest of the plugin tree — buildApp may be driven without a config. */
  config?: Config;
  /** Test seam: inject a fake AuthKit instead of hitting WorkOS. */
  authKit?: AuthKit;
}

/**
 * `secure` is derived from the DEPLOYMENT SCHEME, not from NODE_ENV.
 *
 * Keying it on `NODE_ENV === 'production'` looked equivalent but wasn't: any HTTPS deployment
 * that isn't literally NODE_ENV=production (a staging box, a preview, a debug container behind
 * a TLS load balancer) would ship the session cookie WITHOUT Secure, and a network attacker
 * could then read or shadow it over cleartext to the same host. Reading PUBLIC_URL instead is
 * correct in both directions — behind a TLS-terminating proxy the app sees http:// but the
 * browser sees https://, and Secure is an instruction to the browser.
 *
 * SameSite=lax (not strict) so the cross-site redirect BACK from AuthKit still carries it.
 */
function isHttps(config?: Config): boolean {
  if (!config) return false;
  try {
    return new URL(config.PUBLIC_URL).protocol === 'https:';
  } catch {
    return false;
  }
}

function cookieOptions(config?: Config): Parameters<FastifyReply['setCookie']>[2] {
  return {
    httpOnly: true,
    secure: isHttps(config),
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 7,
  };
}

/** Same flags, but it must not outlive one login round trip. */
function stateCookieOptions(config?: Config): Parameters<FastifyReply['setCookie']>[2] {
  return {
    httpOnly: true,
    secure: isHttps(config),
    sameSite: 'lax',
    path: '/',
    maxAge: 600,
  };
}

export const authKitRoutes: FastifyPluginAsync<AuthKitRoutesDeps> = async (
  fastify,
  { config, authKit },
) => {
  const kit = authKit ?? (config && authKitConfigured(config) ? makeAuthKit(config) : null);

  if (!fastify.hasReplyDecorator('setCookie')) {
    await fastify.register(cookie);
  }

  // Where to land the browser after login/logout. The SPA is served from the same origin by
  // staticPlugin, so a relative path is correct and avoids an open-redirect surface entirely.
  const appPath = '/app';

  /**
   * Every route below 503s rather than 500s when AuthKit is unconfigured. A deploy missing
   * WORKOS_COOKIE_PASSWORD should read as "login is not wired up here", not as a crash.
   */
  function requireKit(): AuthKit {
    if (!kit) {
      const err = new Error('AuthKit is not configured on this deployment');
      (err as Error & { statusCode?: number }).statusCode = 503;
      throw err;
    }
    return kit;
  }

  /**
   * Starts hosted login. Mints a one-time `state` nonce into a short-lived cookie and echoes it
   * through AuthKit — see the callback for why this is load-bearing, not ceremony.
   */
  function beginLogin(reply: FastifyReply, screenHint: 'sign-in' | 'sign-up') {
    const k = requireKit();
    const state = randomUUID();
    reply.setCookie(STATE_COOKIE, state, stateCookieOptions(config));
    return reply.redirect(k.authorizationUrl({ screenHint, state }), 302);
  }

  fastify.get<{ Querystring: { screen_hint?: string } }>('/auth/login', async (request, reply) =>
    beginLogin(reply, request.query.screen_hint === 'sign-up' ? 'sign-up' : 'sign-in'),
  );

  /** Convenience alias so the marketing site can link straight at the sign-up screen. */
  fastify.get('/auth/signup', async (_request, reply) => beginLogin(reply, 'sign-up'));

  fastify.get<{
    Querystring: { code?: string; state?: string; error?: string; error_description?: string };
  }>('/auth/callback', async (request, reply) => {
    const k = requireKit();
    const { code, state, error, error_description: description } = request.query;

    // The user cancelled at AuthKit, or WorkOS rejected the request. Not an exception —
    // send them back to the marketing page rather than showing a stack trace.
    if (error) {
      request.log.warn({ error, description }, 'AuthKit returned an error to the callback');
      return reply.redirect(`/?auth_error=${encodeURIComponent(error)}`, 302);
    }

    /**
     * LOGIN CSRF / SESSION FIXATION GUARD — do not remove.
     *
     * Without this, anyone can hand a victim `/auth/callback?code=<attacker's unconsumed code>`.
     * The server would exchange it and seal the ATTACKER's session into the VICTIM's browser;
     * the victim then lands on a working dashboard inside the attacker's org and types real
     * provider API keys into it. SameSite offers nothing here — the inbound callback is a
     * top-level GET that needs no cookie to reach us.
     *
     * The nonce must be checked BEFORE exchangeCode, so a forged code is never even spent.
     */
    const expected = request.cookies[STATE_COOKIE];
    reply.clearCookie(STATE_COOKIE, { path: '/' }); // one-time use, whatever the outcome
    if (!expected || !state || state !== expected) {
      request.log.warn(
        { hasCookie: Boolean(expected), hasParam: Boolean(state) },
        'rejected an AuthKit callback with a missing or mismatched state nonce',
      );
      return reply.redirect('/?auth_error=bad_state', 302);
    }

    if (!code) return reply.redirect('/?auth_error=missing_code', 302);

    try {
      const { sealedSession } = await k.exchangeCode(code);
      reply.setCookie(SESSION_COOKIE, sealedSession, cookieOptions(config));
      return reply.redirect(appPath, 302);
    } catch (err) {
      // A stale or replayed ?code lands here. Bounce to login instead of 500ing — the
      // common cause is a refreshed callback URL, and a retry just works.
      // Log the message only: the SDK error's rawData can echo the submitted code.
      request.log.warn(
        { err: err instanceof Error ? err.message : 'unknown' },
        'AuthKit code exchange failed',
      );
      return reply.redirect('/?auth_error=exchange_failed', 302);
    }
  });

  /**
   * The SPA's only source of an access token. Returns 401 (not an error body) when there is no
   * valid session, which is the signal to show the logged-out state.
   */
  fastify.get('/auth/session', async (request, reply) => {
    const k = requireKit();
    // This response carries a bearer token; never let a proxy or CDN retain it.
    reply.header('Cache-Control', 'no-store');
    const sealed = request.cookies[SESSION_COOKIE];
    if (!sealed) return reply.code(401).send({ authenticated: false });

    let session: Awaited<ReturnType<AuthKit['loadSession']>>;
    try {
      session = await k.loadSession(sealed);
    } catch (err) {
      // Could not reach a verdict (WorkOS unreachable, or a concurrent tab already rotated
      // this refresh token). 401 so the SPA retries, but do NOT clear the cookie — doing so
      // would turn a blip, or a two-tab race, into a real logout.
      request.log.warn(
        { err: err instanceof Error ? err.message : 'unknown' },
        'session validation was inconclusive; leaving the cookie intact',
      );
      return reply.code(401).send({ authenticated: false });
    }

    if (!session) {
      // Authoritatively dead — clear the cookie so the browser stops sending a value that can
      // never succeed, otherwise every page load pays a pointless WorkOS round trip.
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
      return reply.code(401).send({ authenticated: false });
    }

    // WorkOS rotated the session during refresh; persist it or the refresh is thrown away.
    if (session.sealedSession) {
      reply.setCookie(SESSION_COOKIE, session.sealedSession, cookieOptions(config));
    }
    return reply.send({ authenticated: true, access_token: session.accessToken });
  });

  fastify.post('/auth/logout', async (request, reply) => {
    const k = requireKit();
    const sealed = request.cookies[SESSION_COOKIE];
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    if (!sealed) return reply.send({ ok: true, logout_url: null });

    // Revoke at WorkOS too. Clearing our cookie only ends the session in THIS browser;
    // without this the WorkOS session stays alive and re-login is a silent no-prompt bounce.
    try {
      const session = await k.loadSession(sealed);
      if (session?.sessionId) {
        return reply.send({ ok: true, logout_url: k.logoutUrl(session.sessionId) });
      }
    } catch (err) {
      request.log.warn({ err }, 'could not resolve session id for WorkOS logout');
    }
    return reply.send({ ok: true, logout_url: null });
  });
};
