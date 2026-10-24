import type { FastifyPluginAsync } from 'fastify';
import { SpillwayError, controlPlaneErrorBody } from '@spillway/shared';
import type { Config } from './config.js';
import type { DatabaseClient } from './db/client.js';
import { withOrg } from './db/tenancy.js';
import { makeEffectRegistry, runEffect } from './services/effects/registry.js';
import { verifyActionToken } from './services/alerts/action-token.js';
import { FixedWindowLimiter, isLoopback } from './control-plane/rate-limit.js';

export interface ActionLinksDeps {
  db: DatabaseClient;
  config?: Config;
}

/**
 * Signed action links (Part II §18 §6) — the one-click "pause this key" button in an alert. UNAUTH by
 * design: authorization IS the HMAC token (fail-closed verify → 401). Runs the SAME pause_key effect
 * automation/approvals use (source='action_token', idempotent → a re-clicked link is a safe no-op).
 * Disabled (404) when no signing secret is configured. Encapsulated error handler so a bad token never
 * escapes as a 500.
 */
export const actionLinksPlugin: FastifyPluginAsync<ActionLinksDeps> = async (
  fastify,
  { db, config },
) => {
  const secret = config?.SPILLWAY_ACTION_TOKEN_SECRET;
  const registry = makeEffectRegistry({
    membershipFor: () => ({ byRoles: () => [], isMember: () => false }),
  });

  // Per-IP limiter. This route is UNAUTHENTICATED by design and every request runs an HMAC verify
  // and, on success, a DB transaction — so without a bound it is a free amplifier: token guessing
  // at line rate, and a DB-work loop that costs the attacker nothing. The HMAC itself is not
  // brute-forceable, but "the crypto is strong" is not a reason to leave an unauthenticated
  // endpoint unmetered (found by CodeQL js/missing-rate-limiting, 2026-08-08). Same fixed-window
  // limiter and loopback bypass as /auth/* — fastify.inject() and local dev must not trip it.
  const limiter = new FixedWindowLimiter();
  const ACTION_LINK_LIMIT = 20;
  const ACTION_LINK_WINDOW_MS = 10 * 60_000;
  fastify.addHook('onRequest', async (req, reply) => {
    if (isLoopback(req.ip)) return;
    const retryAfter = limiter.hit(
      `action-link:${req.ip}`,
      ACTION_LINK_LIMIT,
      ACTION_LINK_WINDOW_MS,
      Date.now(),
    );
    if (retryAfter === null) return;
    // Reply rather than throw: the error handler below maps SpillwayError, but replying directly
    // keeps the 429 shape identical to /auth/* and skips the handler entirely.
    void reply
      .code(429)
      .header('retry-after', String(Math.ceil(retryAfter / 1000)))
      .send({ error: { code: 'rate_limited', message: 'too many action-link requests' } });
  });

  fastify.setErrorHandler((err, _req, reply) => {
    if (err instanceof SpillwayError) {
      void reply.code(err.httpStatus).send(controlPlaneErrorBody(err));
      return;
    }
    void reply.code(500).send({ error: { code: 'internal_error', message: 'internal error' } });
  });

  // Wildcard capture: the HMAC token contains a '.' separator that a `:param` won't match as one
  // segment in find-my-way; `*` captures the full remainder verbatim.
  fastify.get<{ Params: { '*': string } }>('/action-links/approval/*', async (request, reply) => {
    if (!secret) {
      void reply.code(404);
      return { error: { code: 'not_found', message: 'action links are not enabled' } };
    }
    const payload = verifyActionToken(request.params['*'], secret); // throws 401 on any failure
    await withOrg(db, payload.orgId, (tx) =>
      runEffect(
        registry,
        {
          tx,
          orgId: payload.orgId,
          actor: { type: 'system', id: null },
          source: 'action_token',
          now: new Date(),
        },
        `action_token:${payload.refId}`,
        { type: payload.action, virtual_key_id: payload.refId },
      ),
    );
    return { status: 'paused', virtual_key_id: payload.refId };
  });
};
