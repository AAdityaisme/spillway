import type { FastifyPluginAsync } from 'fastify';
import { and, eq, sql } from 'drizzle-orm';
import {
  SpillwayError,
  internalBus,
  createRoutingRuleSchema,
  updateRoutingRuleSchema,
} from '@spillway/shared';
import type { DatabaseClient } from '../../db/client.js';
import { routingRules } from '../../db/schema.js';
import { orgContext } from '../../org-context.js';
import { withOrg } from '../../db/tenancy.js';
import { isUniqueViolation } from '../../db/pg-error.js';
import { requireRole } from '../../auth/rbac.js';
import { appendAudit } from '../../services/audit.js';
import { parse } from '../validate.js';

export interface RoutingRulesDeps {
  db: DatabaseClient;
}

const publicCols = {
  id: routingRules.id,
  priority: routingRules.priority,
  description: routingRules.description,
  match: routingRules.match,
  action: routingRules.action,
  enabled: routingRules.enabled,
  createdAt: routingRules.createdAt,
};

/**
 * Routing-rule CRUD (15 §4.7). Gateway-core (all plans). Admin+. `deny` is rejected by the schema
 * (migrated to guardrail policies, ADR-034). UNIQUE(org, priority) is DEFERRABLE (0018) so a bulk
 * reorder can swap priorities in one tx; a single-insert dup priority → 409. Emits org:mutated.
 */
export const routingRulesRoutes: FastifyPluginAsync<RoutingRulesDeps> = async (fastify, { db }) => {
  fastify.get('/routing-rules', async () => {
    const { orgId } = orgContext.require();
    const rows = await withOrg(db, orgId, (tx) =>
      tx.select(publicCols).from(routingRules).orderBy(routingRules.priority),
    );
    return { routingRules: rows };
  });

  fastify.post('/routing-rules', async (request, reply) => {
    const { orgId } = orgContext.require();
    requireRole('admin');
    const body = parse(createRoutingRuleSchema, request.body);
    let created;
    try {
      created = await withOrg(db, orgId, async (tx) => {
        const [row] = await tx
          .insert(routingRules)
          .values({
            orgId,
            priority: body.priority,
            description: body.description ?? null,
            match: body.match,
            action: body.action,
            enabled: body.enabled,
          })
          .returning(publicCols);
        if (!row) throw new Error('routing rule insert returned no row');
        await appendAudit(tx, {
          action: 'routing_rule.create',
          target: { type: 'routing_rule', id: row.id },
          meta: { priority: body.priority },
        });
        return row;
      });
    } catch (e) {
      if (isUniqueViolation(e))
        throw new SpillwayError('conflict', `priority ${body.priority} already in use`, {
          httpStatus: 409,
        });
      throw e;
    }
    internalBus.emit('org:mutated', { orgId });
    reply.code(201);
    return { routingRule: created };
  });

  fastify.patch<{ Params: { id: string } }>('/routing-rules/:id', async (request) => {
    const { orgId } = orgContext.require();
    requireRole('admin');
    const { id } = request.params;
    const body = parse(updateRoutingRuleSchema, request.body);
    const updated = await withOrg(db, orgId, async (tx) => {
      const [row] = await tx
        .update(routingRules)
        .set({
          ...(body.priority !== undefined ? { priority: body.priority } : {}),
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.match !== undefined ? { match: body.match } : {}),
          ...(body.action !== undefined ? { action: body.action } : {}),
          ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
          updatedAt: sql`now()`,
        })
        .where(and(eq(routingRules.id, id), eq(routingRules.orgId, orgId)))
        .returning(publicCols);
      if (!row) throw new SpillwayError('not_found', 'routing rule not found', { httpStatus: 404 });
      await appendAudit(tx, {
        action: 'routing_rule.update',
        target: { type: 'routing_rule', id },
      });
      return row;
    });
    internalBus.emit('org:mutated', { orgId });
    return { routingRule: updated };
  });

  fastify.delete<{ Params: { id: string } }>('/routing-rules/:id', async (request, reply) => {
    const { orgId } = orgContext.require();
    requireRole('admin');
    const { id } = request.params;
    await withOrg(db, orgId, async (tx) => {
      const del = await tx
        .delete(routingRules)
        .where(and(eq(routingRules.id, id), eq(routingRules.orgId, orgId)))
        .returning({ id: routingRules.id });
      if (del.length === 0)
        throw new SpillwayError('not_found', 'routing rule not found', { httpStatus: 404 });
      await appendAudit(tx, {
        action: 'routing_rule.delete',
        target: { type: 'routing_rule', id },
      });
    });
    internalBus.emit('org:mutated', { orgId });
    reply.code(204);
  });
};
