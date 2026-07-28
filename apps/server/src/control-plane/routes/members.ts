import type { FastifyPluginAsync } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { SpillwayError, inviteMemberSchema, updateMemberSchema } from '@spillway/shared';
import type { DatabaseClient } from '../../db/client.js';
import { orgMembers, users } from '../../db/schema.js';
import { orgContext } from '../../org-context.js';
import { withOrg } from '../../db/tenancy.js';
import {
  requireRole,
  canManageMemberRole,
  assertOwnerRemains,
  type Role,
} from '../../auth/rbac.js';
import { appendAudit } from '../../services/audit.js';
import { parse } from '../validate.js';

export interface MembersDeps {
  db: DatabaseClient;
}

const forbidden = () =>
  new SpillwayError('forbidden', 'cannot manage a member at this role', { httpStatus: 403 });

export const membersRoutes: FastifyPluginAsync<MembersDeps> = async (fastify, { db }) => {
  fastify.get('/members', async () => {
    const { orgId } = orgContext.require();
    const rows = await withOrg(db, orgId, (tx) =>
      tx
        .select({
          userId: orgMembers.userId,
          role: orgMembers.role,
          email: users.email,
          name: users.name,
          createdAt: orgMembers.createdAt,
        })
        .from(orgMembers)
        .innerJoin(users, eq(users.id, orgMembers.userId)),
    );
    return { members: rows };
  });

  fastify.post('/members', async (request, reply) => {
    const actor = orgContext.require();
    requireRole('admin');
    const body = parse(inviteMemberSchema, request.body);
    if (!canManageMemberRole(actor.role, body.role)) throw forbidden();
    const member = await withOrg(db, actor.orgId, async (tx) => {
      // M24: pre-check user existence — the FK on org_members.user_id → users.id would produce
      // a 23503 that the error handler maps to 404 "referenced entity does not exist", which
      // misleads callers into thinking the org/route is missing. Return a clear 422 instead.
      const [userRow] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, body.userId))
        .limit(1);
      if (!userRow) {
        throw new SpillwayError(
          'validation_error',
          'user has not signed in yet — they must log in at least once before being invited',
          { httpStatus: 422, details: { param: 'userId' } },
        );
      }
      const [m] = await tx
        .insert(orgMembers)
        .values({ orgId: actor.orgId, userId: body.userId, role: body.role })
        .returning();
      await appendAudit(tx, {
        action: 'member.invite',
        target: { type: 'member', id: body.userId },
        meta: { role: body.role },
      });
      return m;
    });
    reply.code(201);
    return { member };
  });

  fastify.patch<{ Params: { userId: string } }>('/members/:userId', async (request) => {
    const actor = orgContext.require();
    requireRole('admin');
    const { userId } = request.params;
    const body = parse(updateMemberSchema, request.body);
    const member = await withOrg(db, actor.orgId, async (tx) => {
      const [current] = await tx
        .select({ role: orgMembers.role })
        .from(orgMembers)
        .where(and(eq(orgMembers.orgId, actor.orgId), eq(orgMembers.userId, userId)));
      if (!current) throw new SpillwayError('not_found', 'member not found', { httpStatus: 404 });
      if (
        !canManageMemberRole(actor.role, current.role as Role) ||
        !canManageMemberRole(actor.role, body.role)
      ) {
        throw forbidden();
      }
      if (current.role === 'owner' && body.role !== 'owner') {
        await assertOwnerRemains(tx, actor.orgId, userId);
      }
      const [updated] = await tx
        .update(orgMembers)
        .set({ role: body.role })
        .where(and(eq(orgMembers.orgId, actor.orgId), eq(orgMembers.userId, userId)))
        .returning();
      await appendAudit(tx, {
        action: 'member.role_change',
        target: { type: 'member', id: userId },
        fieldDiff: { from: current.role, to: body.role },
      });
      return updated;
    });
    return { member };
  });

  fastify.delete<{ Params: { userId: string } }>('/members/:userId', async (request, reply) => {
    const actor = orgContext.require();
    requireRole('admin');
    const { userId } = request.params;
    await withOrg(db, actor.orgId, async (tx) => {
      const [current] = await tx
        .select({ role: orgMembers.role })
        .from(orgMembers)
        .where(and(eq(orgMembers.orgId, actor.orgId), eq(orgMembers.userId, userId)));
      if (!current) throw new SpillwayError('not_found', 'member not found', { httpStatus: 404 });
      if (!canManageMemberRole(actor.role, current.role as Role)) throw forbidden();
      if (current.role === 'owner') await assertOwnerRemains(tx, actor.orgId, userId);
      await tx
        .delete(orgMembers)
        .where(and(eq(orgMembers.orgId, actor.orgId), eq(orgMembers.userId, userId)));
      await appendAudit(tx, { action: 'member.remove', target: { type: 'member', id: userId } });
    });
    reply.code(204);
  });
};
