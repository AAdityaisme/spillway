import type { FastifyInstance, FastifyRequest } from 'fastify';
import { SpillwayError, controlPlaneErrorBody } from '@spillway/shared';
import { FixedWindowLimiter, isLoopback } from '../control-plane/rate-limit.js';

/**
 * Per-IP rate limiting for /auth/* (10-security §5.4, extended).
 *
 * These routes were the one authenticated-adjacent surface with NO limiter: they sit outside the
 * control plane on purpose (a logged-out browser must reach them), and so they sat outside its
 * limiter too. Every one of them calls WorkOS — `/auth/session` loads and may rotate a sealed
 * session, `/auth/callback` spends an authorization code — so an unauthenticated loop is a free
 * amplifier: it burns the WorkOS API quota and takes login down for every real user, at no cost
 * to the attacker and without ever holding a credential.
 *
 * Two groups, because the traffic shapes are nothing alike:
 *   - `session`  — the SPA polls this on every page load and after a refresh, and a whole office
 *     can share one NAT address. Limit generously; the goal is to bound a loop, not to break
 *     twenty colleagues who opened the dashboard at 9am.
 *   - `login`    — /auth/login, /auth/signup, /auth/callback. A human logs in a handful of times a
 *     day. A tight limit here also throttles authorization-code guessing.
 *
 * Loopback bypasses, exactly as in the control plane: `fastify.inject()` and local dev must not trip
 * it, and behind Fly the real client IP arrives via x-forwarded-for (see `TRUST_PROXY_HOPS` in
 * app.ts — with `trustProxy: true` this limiter would have been trivially defeated by a forged header).
 */

const MIN = 60_000;

export interface AuthRateConfig {
  session: { limit: number; windowMs: number };
  login: { limit: number; windowMs: number };
}

/** Defaults, overridable via AUTH_RATE_* env vars. */
export function loadAuthRateConfig(): AuthRateConfig {
  const n = (v: string | undefined, d: number): number => {
    const p = v ? Number.parseInt(v, 10) : NaN;
    return Number.isFinite(p) && p > 0 ? p : d;
  };
  return {
    session: { limit: n(process.env.AUTH_RATE_SESSION, 120), windowMs: MIN },
    login: { limit: n(process.env.AUTH_RATE_LOGIN, 30), windowMs: 10 * MIN },
  };
}

function groupFor(req: FastifyRequest): keyof AuthRateConfig {
  return (req.url.split('?')[0] ?? '').endsWith('/auth/session') ? 'session' : 'login';
}

/** Registers the onRequest limiter on the (encapsulated) AuthKit route scope. */
export function registerAuthRateLimit(
  scope: FastifyInstance,
  config: AuthRateConfig = loadAuthRateConfig(),
  now: () => number = Date.now,
): void {
  const limiters: Record<keyof AuthRateConfig, FixedWindowLimiter> = {
    session: new FixedWindowLimiter(),
    login: new FixedWindowLimiter(),
  };
  scope.addHook('onRequest', async (req, reply) => {
    const ip = req.ip;
    if (isLoopback(ip)) return;

    const group = groupFor(req);
    const { limit, windowMs } = config[group];
    const retryAfter = limiters[group].hit(`${group}:${ip}`, limit, windowMs, now());
    if (retryAfter === null) return;

    // REPLY, do not throw. The control-plane limiter throws because its scope owns an error handler
    // that maps SpillwayError → its http status; /auth/* deliberately sits outside that scope, so a
    // thrown SpillwayError here surfaces to the client as a 500 and the limit reads as a server bug.
    const err = new SpillwayError('rate_limited', 'too many requests', {
      httpStatus: 429,
      details: { retry_after: retryAfter },
    });
    return reply
      .code(429)
      .header('retry-after', String(retryAfter))
      .send(controlPlaneErrorBody(err));
  });
}
