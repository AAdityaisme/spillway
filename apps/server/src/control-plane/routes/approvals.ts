import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { SpillwayError, internalBus } from '@spillway/shared';
import type { DatabaseClient } from '../../db/client.js';
import { orgContext } from '../../org-context.js';
import { withOrg } from '../../db/tenancy.js';
import { resolveEntitlements } from '../../auth/entitlements.js';
import { requireRole } from '../../auth/rbac.js';
import { orgs } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { makeEffectRegistry } from '../../services/effects/registry.js';
import { buildMembership } from '../../services/approvals/membership.js';
import { makeDecisionHandlers } from '../../services/approvals/decide.js';
import { createApprovalRequest } from '../../services/approvals/create.js';
import { parse } from '../validate.js';

export interface ApprovalsDeps {
  db: DatabaseClient;
}

const decisionSchema = z.object({
  decision: z.enum(['approve', 'deny']),
  comment: z.string().max(2000).optional(),
});
const cancelSchema = z.object({ comment: z.string().max(2000).optional() });
const MONEY_RE = /^\d+(\.\d{1,6})?$/;
const createSchema = z
  .object({
    kind: z.enum(['budget_increase', 'key_unpause']),
    scopeType: z.enum(['org', 'team', 'virtual_key', 'provider']),
    scopeId: z.string().uuid(),
    currentValue: z.record(z.unknown()).optional(),
    requestedValue: z.record(z.unknown()).default({}),
  })
  .strict()
  // Validate the per-kind payload at INTAKE — the apply effect reads these fields at decision time,
  // and a malformed request that only fails when an approver hits "confirm" is undebuggable for them.
  .superRefine((v, ctx) => {
    if (v.kind === 'budget_increase') {
      const limit = v.requestedValue['new_limit_usd'];
      if (typeof limit !== 'string' || !MONEY_RE.test(limit)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['requestedValue', 'new_limit_usd'],
          message: 'budget_increase requires requestedValue.new_limit_usd as a USD string (≤6 dp)',
        });
      }
    }
  });

/**
 * Approval decision + read API (Part II §18 §2.8). Governance-tier ('approval_chains'). The decision
 * handlers wrap the shared effect registry, so an approved budget_increase/key_unpause final-applies
 * through the SAME path automation uses. Per-step authz + self-approval ban live in the engine
 * (assertCanVote); cancel is requester-or-admin. Any org member may attempt a decision — the engine
 * rejects a non-approver 403.
 */
export const approvalsRoutes: FastifyPluginAsync<ApprovalsDeps> = async (fastify, { db }) => {
  const registry = makeEffectRegistry({ membershipFor: (o, tx) => buildMembership(tx, o) });
  const handlers = makeDecisionHandlers({ db, registry });

  async function requireApprovals(orgId: string): Promise<void> {
    const [row] = await db
      .select({ plan: orgs.plan })
      .from(orgs)
      .where(eq(orgs.id, orgId))
      .limit(1);
    if (!resolveEntitlements(row?.plan ?? 'free').has('approval_chains'))
      throw new SpillwayError('tier_required', 'approvals require the Governance plan', {
        httpStatus: 402,
        details: { entitlement: 'approval_chains' },
      });
  }

  // §2.3 scope access: admin/owner may request for any scope; a member may request only for a virtual
  // key they created. (Team-membership scoping — "a team they belong to" — is not modelled in V2, so
  // members are restricted to their own keys; the approval still requires admin/owner sign-off, so this
  // is defence-in-depth, not the security boundary.)
  async function assertScopeAccess(
    orgId: string,
    userId: string,
    role: string,
    scopeType: string,
    scopeId: string,
  ): Promise<void> {
    if (role === 'admin' || role === 'owner') return;
    if (scopeType !== 'virtual_key') {
      throw new SpillwayError(
        'forbidden',
        'members may request approvals only for their own keys',
        {
          httpStatus: 403,
        },
      );
    }
    const rows = (await withOrg(db, orgId, (tx) =>
      tx.execute(sql`select created_by from virtual_keys where id = ${scopeId}`),
    )) as unknown as { created_by: string | null }[];
    if (rows[0]?.created_by !== userId) {
      throw new SpillwayError(
        'forbidden',
        'members may request approvals only for keys they created',
        {
          httpStatus: 403,
        },
      );
    }
  }

  fastify.post('/approvals', async (request, reply) => {
    const { orgId, userId, role } = orgContext.require();
    requireRole('member'); // viewer → 403 (§2.3)
    await requireApprovals(orgId); // tier gate
    const body = parse(createSchema, request.body);
    await assertScopeAccess(orgId, userId, role, body.scopeType, body.scopeId);
    const result = await createApprovalRequest(
      { db, registry },
      {
        orgId,
        userId,
        kind: body.kind,
        scopeType: body.scopeType,
        scopeId: body.scopeId,
        currentValue: body.currentValue,
        requestedValue: body.requestedValue ?? {},
        now: new Date(),
      },
    );
    // An auto-approve tier applied a budget/key change now → invalidate the org's cached bundle.
    if (result.status === 'approved') internalBus.emit('org:mutated', { orgId });
    reply.code(201);
    return { approval: result };
  });

  // Reads entitlement-free by design — see alerts.ts DECISION note + reads-free.integration.test.ts.
  fastify.get('/approvals', async (request) => {
    const { orgId } = orgContext.require();
    const status = (request.query as { status?: string } | undefined)?.status;
    const rows = await withOrg(db, orgId, (tx) =>
      status
        ? tx.execute(sql`select id, kind, status, scope_type, scope_id, amount_usd, current_step_index,
             requested_by, created_at from approval_requests where status = ${status}
             order by created_at desc limit 200`)
        : tx.execute(sql`select id, kind, status, scope_type, scope_id, amount_usd, current_step_index,
             requested_by, created_at from approval_requests order by created_at desc limit 200`),
    );
    return { approvals: rows };
  });

  fastify.get<{ Params: { id: string } }>('/approvals/:id', async (request) => {
    const { orgId } = orgContext.require();
    const { id } = request.params;
    return withOrg(db, orgId, async (tx) => {
      const req = (await tx.execute(sql`
        select id, kind, status, scope_type, scope_id, amount_usd, current_step_index, requested_by,
               decided_by, decided_at, expires_at, created_at
          from approval_requests where id = ${id}`)) as unknown as unknown[];
      if (req.length === 0)
        throw new SpillwayError('not_found', 'approval not found', { httpStatus: 404 });
      const steps = await tx.execute(sql`
        select step_index, quorum, required_approver_ids, notify_only, status
          from approval_steps where approval_id = ${id} order by step_index`);
      return { approval: req[0], steps };
    });
  });

  fastify.post<{ Params: { id: string } }>('/approvals/:id/decisions', async (request) => {
    const { orgId, userId, role } = orgContext.require();
    await requireApprovals(orgId);
    const { id } = request.params;
    const body = parse(decisionSchema, request.body);
    // A viewer is never an effective approver even if named in a frozen approver set (L35).
    if (body.decision === 'approve') {
      const outcome = await handlers.approveRequest(orgId, id, userId, role, body.comment);
      return { status: outcome };
    }
    await handlers.denyRequest(orgId, id, userId, role, body.comment);
    return { status: 'denied' };
  });

  fastify.post<{ Params: { id: string } }>('/approvals/:id/cancel', async (request, reply) => {
    const { orgId, userId, role } = orgContext.require();
    await requireApprovals(orgId);
    const { id } = request.params;
    const body = parse(cancelSchema, request.body ?? {}); // bare POST (no body) is a valid cancel
    const admin = role === 'admin' || role === 'owner';
    await handlers.cancelRequest(orgId, id, userId, { admin, comment: body.comment });
    reply.code(200);
    return { status: 'cancelled' };
  });
};
