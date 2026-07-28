import type { FastifyPluginAsync } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import { SpillwayError, updateOrgSchema } from '@spillway/shared';
import type { DatabaseClient } from '../../db/client.js';
import { orgs } from '../../db/schema.js';
import { orgContext } from '../../org-context.js';
import { withOrg } from '../../db/tenancy.js';
import { requireRole } from '../../auth/rbac.js';
import { appendAudit } from '../../services/audit.js';
import { parse } from '../validate.js';

export interface OrgSettingsDeps {
  db: DatabaseClient;
}

/** Current-org detail + settings (org-scoped, via X-Spillway-Org). */
export const orgSettingsRoutes: FastifyPluginAsync<OrgSettingsDeps> = async (fastify, { db }) => {
  fastify.get('/org', async () => {
    const { orgId } = orgContext.require();
    const [org] = await db.select().from(orgs).where(eq(orgs.id, orgId));
    if (!org) throw new SpillwayError('not_found', 'organization not found', { httpStatus: 404 });
    return { org };
  });

  fastify.patch('/org', async (request) => {
    requireRole('admin');
    const body = parse(updateOrgSchema, request.body);
    const { orgId } = orgContext.require();
    const org = await withOrg(db, orgId, async (tx) => {
      const [updated] = await tx
        .update(orgs)
        .set({ ...body, updatedAt: sql`now()` })
        .where(eq(orgs.id, orgId))
        .returning();
      if (!updated)
        throw new SpillwayError('not_found', 'organization not found', { httpStatus: 404 });
      await appendAudit(tx, {
        action: 'org.update',
        target: { type: 'org', id: orgId },
        fieldDiff: body,
      });
      return updated;
    });
    return { org };
  });
};
