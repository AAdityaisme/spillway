import type { FastifyPluginAsync } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { SpillwayError, createDelegationSchema } from '@spillway/shared';
import type { DatabaseClient } from '../../db/client.js';
import { approverDelegations, orgMembers, orgs } from '../../db/schema.js';
import { orgContext } from '../../org-context.js';
import { withOrg } from '../../db/tenancy.js';
import { requireRole } from '../../auth/rbac.js';
import { resolveEntitlements } from '../../auth/entitlements.js';
import { appendAudit } from '../../services/audit.js';
import { parse } from '../validate.js';

export interface DelegationsDeps {
  db: DatabaseClient;
}

const publicCols = {
  id: approverDelegations.id,
  fromUser: approverDelegations.fromUser,
  toUser: approverDelegations.toUser,
  startsAt: approverDelegations.startsAt,
  endsAt: approverDelegations.endsAt,
  createdAt: approverDelegations.createdAt,
};

async function requireApprovalChains(db: DatabaseClient, orgId: string): Promise<void> {
  const [row] = await db.select({ plan: orgs.plan }).from(orgs).where(eq(orgs.id, orgId)).limit(1);
  if (!resolveEntitlements(row?.plan ?? 'free').has('approval_chains'))
    throw new SpillwayError('tier_required', 'delegations require the Governance plan', {
      httpStatus: 402,
      details: { entitlement: 'approval_chains' },
    });
}

/**
 * Approver-delegation CRUD (18 §2.5). Governance-tier ('approval_chains'). Admin+. Both endpoints of a
 * delegation are re-checked as org members under RLS (drops a borrowed user id). Delegations are read at
 * chain-materialization time, so an edit only affects FUTURE freezes.
 */
export const delegationsRoutes: FastifyPluginAsync<DelegationsDeps> = async (fastify, { db }) => {
  fastify.get('/delegations', async () => {
    const { orgId } = orgContext.require();
    const rows = await withOrg(db, orgId, (tx) => tx.select(publicCols).from(approverDelegations));
    return { delegations: rows };
  });

  fastify.post('/delegations', async (request, reply) => {
    const { orgId, userId } = orgContext.require();
    requireRole('admin');
    await requireApprovalChains(db, orgId);
    const body = parse(createDelegationSchema, request.body);
    // Self-delegation (fromUser===toUser) trips the DB CHECK (23514) and would surface as a raw
    // 500 instead of a clean validation error — reject it up front (expanded-audit L37).
    if (body.fromUser === body.toUser)
      throw new SpillwayError('validation_error', 'cannot delegate to self', {
        httpStatus: 400,
        details: { param: 'toUser' },
      });
    const created = await withOrg(db, orgId, async (tx) => {
      for (const uid of [body.fromUser, body.toUser]) {
        const [m] = await tx
          .select({ userId: orgMembers.userId })
          .from(orgMembers)
          .where(eq(orgMembers.userId, uid))
          .limit(1);
        if (!m)
          throw new SpillwayError('validation_error', `user ${uid} is not a member of this org`, {
            httpStatus: 400,
            details: { param: uid === body.fromUser ? 'fromUser' : 'toUser' },
          });
      }
      const [row] = await tx
        .insert(approverDelegations)
        .values({
          orgId,
          fromUser: body.fromUser,
          toUser: body.toUser,
          startsAt: new Date(body.startsAt),
          endsAt: new Date(body.endsAt),
          createdBy: userId,
        })
        .returning(publicCols);
      if (!row) throw new Error('delegation insert returned no row');
      await appendAudit(tx, {
        action: 'delegation.create',
        target: { type: 'approver_delegation', id: row.id },
        meta: { fromUser: body.fromUser, toUser: body.toUser },
      });
      return row;
    });
    reply.code(201);
    return { delegation: created };
  });

  fastify.delete<{ Params: { id: string } }>('/delegations/:id', async (request, reply) => {
    const { orgId } = orgContext.require();
    requireRole('admin');
    await requireApprovalChains(db, orgId);
    const { id } = request.params;
    await withOrg(db, orgId, async (tx) => {
      const del = await tx
        .delete(approverDelegations)
        .where(and(eq(approverDelegations.id, id), eq(approverDelegations.orgId, orgId)))
        .returning({ id: approverDelegations.id });
      if (del.length === 0)
        throw new SpillwayError('not_found', 'delegation not found', { httpStatus: 404 });
      await appendAudit(tx, {
        action: 'delegation.delete',
        target: { type: 'approver_delegation', id },
      });
    });
    reply.code(204);
  });
};
