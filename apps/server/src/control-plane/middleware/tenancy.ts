import type { FastifyRequest, FastifyReply, HookHandlerDoneFunction } from 'fastify';
import { SpillwayError } from '@spillway/shared';
import type { DatabaseClient } from '../../db/client.js';
import { lookupMembership } from '../../db/tenancy.js';
import { orgContext } from '../../org-context.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Builds the org-scoped tenancy hook (preHandler, runs after auth). Resolves the
 * target org from the `X-Spillway-Org` header, confirms the authenticated user is
 * a member (ADR-025 bootstrap lookup), and arms the request's org context.
 *
 * Uses the callback (`done`) hook form so the org context can be established with
 * `orgContext.run(ctx, done)`: this is the ONLY reliable way to make an
 * AsyncLocalStorage value survive into Fastify's route handler — `enterWith()` in
 * an async hook does not propagate, because the handler runs in a different async
 * context than the hook. Org-scoped DB access still goes through withOrg() inside
 * handlers; this only establishes WHICH org + the caller's role for RBAC/audit.
 */
export function makeTenancyHook(db: DatabaseClient) {
  return function tenancyHook(
    request: FastifyRequest,
    _reply: FastifyReply,
    done: HookHandlerDoneFunction,
  ): void {
    const raw = request.headers['x-spillway-org'];
    const orgId = Array.isArray(raw) ? raw[0] : raw;
    if (!orgId || !UUID_RE.test(orgId)) {
      done(
        new SpillwayError('org_required', 'missing or invalid X-Spillway-Org header', {
          httpStatus: 400,
        }),
      );
      return;
    }
    const user = request.user;
    if (!user) {
      done(new SpillwayError('unauthenticated', 'not authenticated', { httpStatus: 401 }));
      return;
    }
    lookupMembership(db, orgId, user.sub)
      .then((membership) => {
        if (!membership) {
          done(
            new SpillwayError('forbidden', 'not a member of this organization', {
              httpStatus: 403,
            }),
          );
          return;
        }
        orgContext.run(
          { orgId, userId: user.sub, role: membership.role, email: user.email, name: user.name },
          done,
        );
      })
      .catch((err: unknown) => done(err as Error));
  };
}
