import type { FastifyPluginAsync } from 'fastify';
import { and, eq, sql } from 'drizzle-orm';
import {
  SpillwayError,
  createApprovalPolicySchema,
  updateApprovalPolicySchema,
} from '@spillway/shared';
import type { DatabaseClient } from '../../db/client.js';
import { approvalPolicies, orgs } from '../../db/schema.js';
import { orgContext } from '../../org-context.js';
import { withOrg } from '../../db/tenancy.js';
import { requireRole } from '../../auth/rbac.js';
import { resolveEntitlements } from '../../auth/entitlements.js';
import { appendAudit } from '../../services/audit.js';
import { parse } from '../validate.js';

export interface ApprovalPoliciesDeps {
  db: DatabaseClient;
}

const publicCols = {
  id: approvalPolicies.id,
  name: approvalPolicies.name,
  kind: approvalPolicies.kind,
  scopeType: approvalPolicies.scopeType,
  scopeId: approvalPolicies.scopeId,
  definition: approvalPolicies.definition,
  version: approvalPolicies.version,
  enabled: approvalPolicies.enabled,
  createdAt: approvalPolicies.createdAt,
};

async function requireApprovalChains(db: DatabaseClient, orgId: string): Promise<void> {
  const [row] = await db.select({ plan: orgs.plan }).from(orgs).where(eq(orgs.id, orgId)).limit(1);
  if (!resolveEntitlements(row?.plan ?? 'free').has('approval_chains'))
    throw new SpillwayError('tier_required', 'approval policies require the Governance plan', {
      httpStatus: 402,
      details: { entitlement: 'approval_chains' },
    });
}

/**
 * Approval-policy CRUD (18 §2.1). Governance-tier ('approval_chains'). Admin+. The frozen chain is
 * materialized from `definition` at request creation (freeze-at-creation), so an edit here only affects
 * FUTURE approvals — `version` bumps on update so a materialized chain records which version froze it.
 */
export const approvalPoliciesRoutes: FastifyPluginAsync<ApprovalPoliciesDeps> = async (
  fastify,
  { db },
) => {
  // Reads entitlement-free by design — see alerts.ts DECISION note + reads-free.integration.test.ts.
  fastify.get('/approval-policies', async () => {
    const { orgId } = orgContext.require();
    const rows = await withOrg(db, orgId, (tx) => tx.select(publicCols).from(approvalPolicies));
    return { approvalPolicies: rows };
  });

  fastify.post('/approval-policies', async (request, reply) => {
    const { orgId, userId } = orgContext.require();
    requireRole('admin');
    await requireApprovalChains(db, orgId);
    const body = parse(createApprovalPolicySchema, request.body);
    const created = await withOrg(db, orgId, async (tx) => {
      const [row] = await tx
        .insert(approvalPolicies)
        .values({
          orgId,
          name: body.name,
          kind: body.kind,
          scopeType: body.scopeType ?? null,
          scopeId: body.scopeId ?? null,
          definition: body.definition,
          enabled: body.enabled,
          createdBy: userId,
        })
        .returning(publicCols);
      if (!row) throw new Error('approval policy insert returned no row');
      await appendAudit(tx, {
        action: 'approval_policy.create',
        target: { type: 'approval_policy', id: row.id },
        meta: { kind: body.kind },
      });
      return row;
    });
    reply.code(201);
    return { approvalPolicy: created };
  });

  fastify.patch<{ Params: { id: string } }>('/approval-policies/:id', async (request) => {
    const { orgId } = orgContext.require();
    requireRole('admin');
    await requireApprovalChains(db, orgId);
    const { id } = request.params;
    const body = parse(updateApprovalPolicySchema, request.body);
    const updated = await withOrg(db, orgId, async (tx) => {
      const [row] = await tx
        .update(approvalPolicies)
        .set({
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.definition !== undefined ? { definition: body.definition } : {}),
          ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
          version: sql`${approvalPolicies.version} + 1`,
          updatedAt: sql`now()`,
        })
        .where(and(eq(approvalPolicies.id, id), eq(approvalPolicies.orgId, orgId)))
        .returning(publicCols);
      if (!row)
        throw new SpillwayError('not_found', 'approval policy not found', { httpStatus: 404 });
      await appendAudit(tx, {
        action: 'approval_policy.update',
        target: { type: 'approval_policy', id },
      });
      return row;
    });
    return { approvalPolicy: updated };
  });

  fastify.delete<{ Params: { id: string } }>('/approval-policies/:id', async (request, reply) => {
    const { orgId } = orgContext.require();
    requireRole('admin');
    await requireApprovalChains(db, orgId);
    const { id } = request.params;
    await withOrg(db, orgId, async (tx) => {
      const del = await tx
        .delete(approvalPolicies)
        .where(and(eq(approvalPolicies.id, id), eq(approvalPolicies.orgId, orgId)))
        .returning({ id: approvalPolicies.id });
      if (del.length === 0)
        throw new SpillwayError('not_found', 'approval policy not found', { httpStatus: 404 });
      await appendAudit(tx, {
        action: 'approval_policy.delete',
        target: { type: 'approval_policy', id },
      });
    });
    reply.code(204);
  });
};
