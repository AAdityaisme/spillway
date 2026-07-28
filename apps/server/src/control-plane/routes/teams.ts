import type { FastifyPluginAsync } from 'fastify';
import { and, eq, sql } from 'drizzle-orm';
import { SpillwayError, createTeamSchema, updateTeamSchema } from '@spillway/shared';
import type { DatabaseClient } from '../../db/client.js';
import { teams } from '../../db/schema.js';
import { orgContext } from '../../org-context.js';
import { withOrg } from '../../db/tenancy.js';
import { requireRole } from '../../auth/rbac.js';
import { appendAudit } from '../../services/audit.js';
import { parse } from '../validate.js';

export interface TeamsDeps {
  db: DatabaseClient;
}

export const teamsRoutes: FastifyPluginAsync<TeamsDeps> = async (fastify, { db }) => {
  fastify.get('/teams', async () => {
    const { orgId } = orgContext.require();
    const rows = await withOrg(db, orgId, (tx) => tx.select().from(teams));
    return { teams: rows };
  });

  fastify.post('/teams', async (request, reply) => {
    requireRole('admin');
    const body = parse(createTeamSchema, request.body);
    const { orgId } = orgContext.require();
    const team = await withOrg(db, orgId, async (tx) => {
      const [created] = await tx
        .insert(teams)
        .values({ orgId, name: body.name, slug: body.slug })
        .returning();
      if (!created) throw new Error('team insert returned no row');
      await appendAudit(tx, { action: 'team.create', target: { type: 'team', id: created.id } });
      return created;
    });
    reply.code(201);
    return { team };
  });

  fastify.patch<{ Params: { id: string } }>('/teams/:id', async (request) => {
    requireRole('admin');
    const body = parse(updateTeamSchema, request.body);
    const { orgId } = orgContext.require();
    const { id } = request.params;
    const team = await withOrg(db, orgId, async (tx) => {
      const [updated] = await tx
        .update(teams)
        .set({ ...body, updatedAt: sql`now()` })
        .where(and(eq(teams.id, id), eq(teams.orgId, orgId)))
        .returning();
      if (!updated) throw new SpillwayError('not_found', 'team not found', { httpStatus: 404 });
      await appendAudit(tx, {
        action: 'team.update',
        target: { type: 'team', id },
        fieldDiff: body,
      });
      return updated;
    });
    return { team };
  });

  fastify.delete<{ Params: { id: string } }>('/teams/:id', async (request, reply) => {
    requireRole('admin');
    const { orgId } = orgContext.require();
    const { id } = request.params;
    await withOrg(db, orgId, async (tx) => {
      const deleted = await tx
        .delete(teams)
        .where(and(eq(teams.id, id), eq(teams.orgId, orgId)))
        .returning({ id: teams.id });
      if (deleted.length === 0) {
        throw new SpillwayError('not_found', 'team not found', { httpStatus: 404 });
      }
      await appendAudit(tx, { action: 'team.delete', target: { type: 'team', id } });
    });
    reply.code(204);
  });
};
