import type { FastifyPluginAsync } from 'fastify';
import { eq } from 'drizzle-orm';
import { SpillwayError } from '@spillway/shared';
import type { DatabaseClient } from '../../db/client.js';
import { orgs } from '../../db/schema.js';
import { orgContext } from '../../org-context.js';
import { requireRole } from '../../auth/rbac.js';
import { resolveEntitlements } from '../../auth/entitlements.js';
import { assembleTrace } from '../../services/routing-trace.js';

export interface TracesDeps {
  db: DatabaseClient;
}

/**
 * Routing-trace read API (Part II §20 §6). GET /api/traces/:id — the assembled routing/decision/attempt
 * trace for a request. Governance-tier ('audit_api'), admin+. Additive-stable payload.
 */
export const tracesRoutes: FastifyPluginAsync<TracesDeps> = async (fastify, { db }) => {
  fastify.get<{ Params: { id: string } }>(
    '/traces/:id',
    {
      // Reject a non-UUID id with a declared 400 BEFORE any DB round-trip, rather than depending on a
      // Postgres cast error bubbling to the generic handler (a fragile contract a driver/refactor
      // change could turn into a 500) (audit L39).
      schema: {
        params: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
          required: ['id'],
        },
      },
    },
    async (request) => {
      const { orgId } = orgContext.require();
      requireRole('admin');
      const [row] = await db
        .select({ plan: orgs.plan })
        .from(orgs)
        .where(eq(orgs.id, orgId))
        .limit(1);
      if (!resolveEntitlements(row?.plan ?? 'free').has('audit_api'))
        throw new SpillwayError('tier_required', 'the trace API requires the Governance plan', {
          httpStatus: 402,
          details: { entitlement: 'audit_api' },
        });
      const trace = await assembleTrace(db, orgId, request.params.id);
      if (!trace) throw new SpillwayError('not_found', 'request not found', { httpStatus: 404 });
      return { trace };
    },
  );
};
