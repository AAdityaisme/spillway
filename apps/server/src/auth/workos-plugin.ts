import type { FastifyRequest } from 'fastify';
import type { JWTVerifyGetKey } from 'jose';
import { SpillwayError } from '@spillway/shared';
import type { Config } from '../config.js';
import type { DatabaseClient } from '../db/client.js';
import {
  makeWorkosJwks,
  verifyOptionsFromConfig,
  verifyWorkosJwt,
  type AuthenticatedUser,
  type VerifyOptions,
} from './workos-jwt.js';
import { mirrorUser } from './mirror-user.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the auth hook on every control-plane request. */
    user?: AuthenticatedUser;
  }
}

/** Returns the authenticated user or throws 401 — use at the top of handlers. */
export function requireUser(request: FastifyRequest): AuthenticatedUser {
  if (!request.user) {
    throw new SpillwayError('unauthenticated', 'not authenticated', { httpStatus: 401 });
  }
  return request.user;
}

export interface AuthDeps {
  config: Config;
  db: DatabaseClient;
  /** Test seam: inject a local JWKS + verify options instead of WorkOS's remote JWKS. */
  jwks?: JWTVerifyGetKey;
  verifyOpts?: VerifyOptions;
}

/**
 * Builds the control-plane auth hook (onRequest): require a Bearer token, verify
 * it against WorkOS (RS256/JWKS, ADR-023), mirror the user, attach request.user.
 * The JWKS resolver + verify options are built ONCE here (jose caches keys).
 *
 * M25: mirrorUser is fire-and-forget. A transient DB write failure must never
 * 500 an otherwise-valid token — auth availability must not depend on write
 * availability. The upsert is best-effort; failures are logged for observability.
 *
 * L29: warns at startup when WORKOS_JWT_AUD is unset in production. Without it,
 * any token signed by this WorkOS client (for any aud) is accepted — hardening
 * gap, not a cross-tenant break, but operators should set it once the dashboard
 * confirms the stable audience value.
 */
export function makeAuthHook(deps: AuthDeps) {
  const jwks = deps.jwks ?? makeWorkosJwks(deps.config);
  const verifyOpts = deps.verifyOpts ?? verifyOptionsFromConfig(deps.config);

  // Subs whose users row this process has confirmed. The FK race the await below closes only
  // exists on a sub's FIRST request (org_members insert racing the un-awaited users upsert), so
  // only that first sighting pays the round-trip on the auth path; after a confirmed upsert the
  // mirror reverts to M25 fire-and-forget (refreshes email/name, adds no latency). Bounded by
  // active-user count; per-process, so each instance re-confirms once after restart — harmless,
  // the upsert is idempotent.
  const mirroredSubs = new Set<string>();

  // L29: startup warning so operators know aud enforcement is disabled.
  if (deps.config.NODE_ENV === 'production' && !deps.config.WORKOS_JWT_AUD) {
    console.warn(
      '[auth] WORKOS_JWT_AUD is not set — any token issued by this WorkOS client is accepted ' +
        'regardless of audience. Set WORKOS_JWT_AUD (usually the client id) to tighten this.',
    );
  }

  return async function authHook(request: FastifyRequest): Promise<void> {
    const header = request.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      throw new SpillwayError('unauthenticated', 'missing bearer token', { httpStatus: 401 });
    }
    const user = await verifyWorkosJwt(header.slice('Bearer '.length), jwks, verifyOpts);
    request.user = user;
    // M25 kept auth non-fatal on a mirror hiccup, but fire-and-forget opened a first-request
    // race: a brand-new user's org-create could insert org_members(user_id) BEFORE the
    // un-awaited users upsert committed → 23503 FK violation (intermittent 404/500 on the
    // very first action; caught as the PR #1 governance-crud flake). Await the upsert so
    // handler writes are ordered after it; keep the catch so a write hiccup still never
    // fails auth (the FK then surfaces in the handler, which is the honest failure site).
    if (mirroredSubs.has(user.sub)) {
      void mirrorUser(deps.db, user).catch((err) => {
        request.log.error({ err }, 'mirrorUser failed (non-fatal, auth proceeds)');
      });
    } else {
      // Not added to the set on failure — the next request retries the awaited path.
      await mirrorUser(deps.db, user)
        .then(() => mirroredSubs.add(user.sub))
        .catch((err) => {
          request.log.error({ err }, 'mirrorUser failed (non-fatal, auth proceeds)');
        });
    }
  };
}
