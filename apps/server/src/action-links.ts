import type { FastifyPluginAsync } from 'fastify';
import { SpillwayError, controlPlaneErrorBody } from '@spillway/shared';
import type { Config } from './config.js';
import type { DatabaseClient } from './db/client.js';
import { withOrg } from './db/tenancy.js';
import { makeEffectRegistry, runEffect } from './services/effects/registry.js';
import { verifyActionToken } from './services/alerts/action-token.js';

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
