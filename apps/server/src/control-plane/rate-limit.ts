import type { FastifyInstance, FastifyRequest } from 'fastify';
import { SpillwayError } from '@spillway/shared';

/**
 * IP-based rate limiting for the auth-adjacent control plane (10-security §5.4). The control plane is
 * low-volume by nature, so coarse per-IP fixed-window counters (in-process, same spirit as ADR-016's
 * per-instance limiter) are enough — no Redis, no dependency. A shared-store limiter is the same seam
 * as the policy-cache swap if a fleet ever needs it.
 *
 * Loopback (127.0.0.1 / ::1) BYPASSES the limiter: local dev and the test harness (fastify.inject
 * defaults request.ip to 127.0.0.1) must not trip it, and in production behind Fly's proxy the real
 * client IP arrives via x-forwarded-for (trustProxy is on), never loopback. Tests exercise the limits
 * by injecting an `x-forwarded-for` header.
 */

interface FixedWindow {
  count: number;
  resetAt: number;
}

/** One (key → window) counter table for a single limit group. Swept lazily to bound memory. */
export class FixedWindowLimiter {
  private readonly windows = new Map<string, FixedWindow>();
  private lastSweep = 0;

  /** Returns null when allowed; a retry-after (seconds) when the window is exhausted. */
  hit(key: string, limit: number, windowMs: number, now: number): number | null {
    if (now - this.lastSweep > windowMs) this.sweep(now);
    let w = this.windows.get(key);
    if (!w || now >= w.resetAt) {
      w = { count: 0, resetAt: now + windowMs };
      this.windows.set(key, w);
    }
    w.count += 1;
    if (w.count > limit) return Math.max(1, Math.ceil((w.resetAt - now) / 1000));
    return null;
  }

  /** Current count for `key` in its live window (0 if none/expired). Does NOT increment. */
  count(key: string, now: number): number {
    const w = this.windows.get(key);
    return w && now < w.resetAt ? w.count : 0;
  }

  private sweep(now: number): void {
    this.lastSweep = now;
    for (const [k, w] of this.windows) if (now >= w.resetAt) this.windows.delete(k);
  }
}

const HOUR = 3_600_000;
const MIN = 60_000;

export interface ControlPlaneRateConfig {
  orgCreate: { limit: number; windowMs: number };
  invite: { limit: number; windowMs: number };
  general: { limit: number; windowMs: number };
  /** §5.4 row 3: after `limit` invalid-JWT (401) responses in the window, the IP is locked out. */
  jwtFail: { limit: number; windowMs: number };
}

/** §5.4 defaults, overridable via CONTROL_PLANE_RATE_* env vars. */
export function loadRateConfig(): ControlPlaneRateConfig {
  const n = (v: string | undefined, d: number): number => {
    const p = v ? Number.parseInt(v, 10) : NaN;
    return Number.isFinite(p) && p > 0 ? p : d;
  };
  return {
    orgCreate: { limit: n(process.env.CONTROL_PLANE_RATE_ORG_CREATE, 10), windowMs: HOUR },
    invite: { limit: n(process.env.CONTROL_PLANE_RATE_INVITE, 20), windowMs: 10 * MIN },
    general: { limit: n(process.env.CONTROL_PLANE_RATE_GENERAL, 300), windowMs: MIN },
    jwtFail: { limit: n(process.env.CONTROL_PLANE_RATE_JWT_FAIL, 20), windowMs: 5 * MIN },
  };
}

function isLoopback(ip: string): boolean {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

/** Which §5.4 group a request falls into (paths are relative to the /api prefix the plugin strips). */
function groupFor(req: FastifyRequest): keyof ControlPlaneRateConfig {
  const url = req.url.split('?')[0] ?? '';
  if (req.method === 'POST' && /\/orgs\/?$/.test(url)) return 'orgCreate';
  if (req.method === 'POST' && /\/members\/?$/.test(url)) return 'invite';
  return 'general';
}

/**
 * Registers the IP rate-limit onRequest hook on the (already /api-scoped) control-plane instance. Runs
 * BEFORE the auth hook so an unauthenticated flood is throttled too. Emits a clean 429 with Retry-After.
 */
export function registerControlPlaneRateLimit(
  scope: FastifyInstance,
  config: ControlPlaneRateConfig = loadRateConfig(),
  now: () => number = Date.now,
): void {
  const limiters: Record<keyof ControlPlaneRateConfig, FixedWindowLimiter> = {
    orgCreate: new FixedWindowLimiter(),
    invite: new FixedWindowLimiter(),
    general: new FixedWindowLimiter(),
    jwtFail: new FixedWindowLimiter(),
  };
  scope.addHook('onRequest', async (req, reply) => {
    const ip = req.ip;
    if (isLoopback(ip)) return;

    // JWT-failure lockout (§5.4 row 3): once an IP has produced too many invalid-JWT 401s in the
    // window, reject everything from it until the window clears — checked BEFORE the per-group limit.
    if (limiters.jwtFail.count(`jwt:${ip}`, now()) >= config.jwtFail.limit) {
      const retryAfter = Math.ceil(config.jwtFail.windowMs / 1000);
      void reply.header('retry-after', String(retryAfter));
      throw new SpillwayError('rate_limited', 'too many failed authentications', {
        httpStatus: 429,
        details: { retry_after: retryAfter },
      });
    }

    const group = groupFor(req);
    const { limit, windowMs } = config[group];
    const retryAfter = limiters[group].hit(`${group}:${ip}`, limit, windowMs, now());
    if (retryAfter !== null) {
      void reply.header('retry-after', String(retryAfter));
      throw new SpillwayError('rate_limited', 'too many requests', {
        httpStatus: 429,
        details: { retry_after: retryAfter },
      });
    }
  });

  // Count invalid-JWT responses (401) per IP so the lockout above can trip. In the control plane a 401
  // only comes from the auth hook (bad/missing JWT), so any 401 is an auth failure. Loopback is exempt.
  scope.addHook('onResponse', async (req, reply) => {
    if (reply.statusCode === 401 && !isLoopback(req.ip))
      limiters.jwtFail.hit(`jwt:${req.ip}`, config.jwtFail.limit, config.jwtFail.windowMs, now());
  });
}
