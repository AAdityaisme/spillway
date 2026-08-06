import { WorkOS } from '@workos-inc/node';
import { SpillwayError } from '@spillway/shared';
import type { Config } from '../config.js';

/**
 * WorkOS AuthKit hosted-login flow (M4-auth, ADR-023).
 *
 * WHY THE SPLIT: the server already verifies `Authorization: Bearer <AuthKit access token>`
 * against WorkOS's JWKS (auth/workos-jwt.ts). That path is untouched. This module only adds
 * the half that was missing — *issuing* a session — so the two compose:
 *
 *   cookie  → httpOnly, sealed by WorkOS, holds the long-lived refreshable session.
 *   access  → short-lived JWT handed to the SPA and held IN MEMORY only, sent as Bearer.
 *
 * The access token deliberately never reaches localStorage, which defeats anything that can read
 * storage but not run script here. It does NOT defeat XSS — script on this origin can call
 * /auth/session itself and mint tokens, because the cookie is attached automatically. httpOnly
 * hides the cookie's value, not its authority; a script-src CSP is what covers that threat.
 */

export interface AuthKit {
  /** Hosted AuthKit URL to redirect the browser to. */
  authorizationUrl(opts: { screenHint?: 'sign-in' | 'sign-up'; state?: string }): string;
  /** Exchanges the `?code=` from the callback for a sealed session + access token. */
  exchangeCode(code: string): Promise<{ sealedSession: string; accessToken: string }>;
  /**
   * Validates the sealed cookie. Returns a rotated cookie when WorkOS refreshed the
   * session — the caller MUST write it back or the refresh is lost and the user is
   * bounced to login early.
   *
   * `null` means AUTHORITATIVELY dead (revoked/expired) — safe to clear the cookie.
   * Throwing means we could not reach a verdict; the caller must 401 WITHOUT clearing,
   * or a transient WorkOS blip logs out every user whose token happened to be stale.
   */
  loadSession(
    sealed: string,
  ): Promise<{ accessToken: string; sealedSession?: string; sessionId?: string } | null>;
  /** Hosted logout URL that also revokes the session server-side at WorkOS. */
  logoutUrl(sessionId: string): string;
}

/** Redirect URI must byte-match one registered in the WorkOS dashboard or the callback 400s. */
export function redirectUri(config: Config): string {
  return config.WORKOS_REDIRECT_URI ?? new URL('/auth/callback', config.PUBLIC_URL).toString();
}

/** True when every value the hosted-login flow needs is configured. */
export function authKitConfigured(config: Config): boolean {
  return Boolean(config.WORKOS_API_KEY && config.WORKOS_CLIENT_ID && config.WORKOS_COOKIE_PASSWORD);
}

export function makeAuthKit(config: Config): AuthKit {
  if (!authKitConfigured(config)) {
    throw new Error('makeAuthKit called without WorkOS credentials — guard with authKitConfigured');
  }
  const clientId = config.WORKOS_CLIENT_ID as string;
  const cookiePassword = config.WORKOS_COOKIE_PASSWORD as string;
  const workos = new WorkOS(config.WORKOS_API_KEY as string, { clientId });
  const uri = redirectUri(config);

  return {
    authorizationUrl({ screenHint, state }) {
      return workos.userManagement.getAuthorizationUrl({
        clientId,
        redirectUri: uri,
        provider: 'authkit',
        ...(screenHint ? { screenHint } : {}),
        ...(state ? { state } : {}),
      });
    },

    async exchangeCode(code) {
      const res = await workos.userManagement.authenticateWithCode({
        code,
        clientId,
        session: { sealSession: true, cookiePassword },
      });
      if (!res.sealedSession) {
        // Only happens if sealSession silently failed; without a cookie there is no session
        // to hand back, and returning a bare access token would create a login that dies in
        // minutes with no refresh path. Fail loudly instead.
        throw new SpillwayError('internal_error', 'WorkOS returned no sealed session', {
          httpStatus: 502,
        });
      }
      return { sealedSession: res.sealedSession, accessToken: res.accessToken };
    },

    async loadSession(sealed) {
      const session = workos.userManagement.loadSealedSession({
        sessionData: sealed,
        cookiePassword,
      });
      const result = await session.authenticate();
      if (result.authenticated) {
        return { accessToken: result.accessToken, sessionId: result.sessionId };
      }
      // Not authenticated can simply mean the access token aged out — the refresh token in
      // the sealed cookie may still be good, so try once before declaring the session dead.
      //
      // A THROW here is not a verdict. Two ways it fires with a perfectly live session:
      //   1. Two tabs refresh concurrently. One rotates the refresh token; the other presents
      //      the now-consumed one and is rejected. Treating that as "dead" would clear the
      //      cookie the first tab just rotated in, logging BOTH tabs out.
      //   2. WorkOS 500s or the socket resets.
      // So propagate it and let the route 401 without destroying the cookie.
      const refreshed = await session.refresh();
      if (!refreshed.authenticated) return null;
      const accessToken = refreshed.session?.accessToken;
      if (!accessToken) return null;
      return {
        accessToken,
        sealedSession: refreshed.sealedSession,
        sessionId: refreshed.sessionId,
      };
    },

    logoutUrl(sessionId) {
      // returnTo lands the browser back on the marketing page after WorkOS revokes the session.
      return workos.userManagement.getLogoutUrl({ sessionId, returnTo: config.PUBLIC_URL });
    },
  };
}
