import type { FastifyPluginAsync } from 'fastify';
import { and, eq, sql } from 'drizzle-orm';
import { SpillwayError, internalBus, createAliasSchema, updateAliasSchema } from '@spillway/shared';
import type { DatabaseClient } from '../../db/client.js';
import { modelAliases } from '../../db/schema.js';
import { orgContext } from '../../org-context.js';
import { withOrg } from '../../db/tenancy.js';
import { isUniqueViolation } from '../../db/pg-error.js';
import { requireRole } from '../../auth/rbac.js';
import { appendAudit } from '../../services/audit.js';
import { parse } from '../validate.js';

export interface AliasesDeps {
  db: DatabaseClient;
}

const publicCols = {
  id: modelAliases.id,
  alias: modelAliases.alias,
  targets: modelAliases.targets,
  createdAt: modelAliases.createdAt,
};

/**
 * Model-alias CRUD (15 §2.1). Routing is gateway-core (all plans, no entitlement gate). Admin+.
 * Every mutation emits org:mutated (aliases travel in the cached bundle — B1.2 invalidation lint).
 * The alias is compiled at bundle-fill; here we only validate + store the target chain.
 */
export const aliasesRoutes: FastifyPluginAsync<AliasesDeps> = async (fastify, { db }) => {
  fastify.get('/aliases', async () => {
    const { orgId } = orgContext.require();
    const rows = await withOrg(db, orgId, (tx) => tx.select(publicCols).from(modelAliases));
    return { aliases: rows };
  });

  fastify.post('/aliases', async (request, reply) => {
    const { orgId } = orgContext.require();
    requireRole('admin');
    const body = parse(createAliasSchema, request.body);
    let created;
    try {
      created = await withOrg(db, orgId, async (tx) => {
        const [row] = await tx
          .insert(modelAliases)
          .values({ orgId, alias: body.alias, targets: body.targets })
          .returning(publicCols);
        if (!row) throw new Error('alias insert returned no row');
        await appendAudit(tx, {
          action: 'alias.create',
          target: { type: 'model_alias', id: row.id },
          meta: { alias: body.alias },
        });
        return row;
      });
    } catch (e) {
      if (isUniqueViolation(e))
        throw new SpillwayError('conflict', `alias '${body.alias}' already exists`, {
          httpStatus: 409,
        });
      throw e;
    }
    internalBus.emit('org:mutated', { orgId });
    reply.code(201);
    return { alias: created };
  });

  fastify.patch<{ Params: { id: string } }>('/aliases/:id', async (request) => {
    const { orgId } = orgContext.require();
    requireRole('admin');
    const { id } = request.params;
    const body = parse(updateAliasSchema, request.body);
    const updated = await withOrg(db, orgId, async (tx) => {
      const [row] = await tx
        .update(modelAliases)
        .set({ targets: body.targets, updatedAt: sql`now()` })
        .where(and(eq(modelAliases.id, id), eq(modelAliases.orgId, orgId)))
        .returning(publicCols);
      if (!row) throw new SpillwayError('not_found', 'alias not found', { httpStatus: 404 });
      await appendAudit(tx, { action: 'alias.update', target: { type: 'model_alias', id } });
      return row;
    });
    internalBus.emit('org:mutated', { orgId });
    return { alias: updated };
  });

  fastify.delete<{ Params: { id: string } }>('/aliases/:id', async (request, reply) => {
    const { orgId } = orgContext.require();
    requireRole('admin');
    const { id } = request.params;
    await withOrg(db, orgId, async (tx) => {
      const del = await tx
        .delete(modelAliases)
        .where(and(eq(modelAliases.id, id), eq(modelAliases.orgId, orgId)))
        .returning({ id: modelAliases.id });
      if (del.length === 0)
        throw new SpillwayError('not_found', 'alias not found', { httpStatus: 404 });
      await appendAudit(tx, { action: 'alias.delete', target: { type: 'model_alias', id } });
    });
    internalBus.emit('org:mutated', { orgId });
    reply.code(204);
  });
};
