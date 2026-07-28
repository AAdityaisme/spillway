import type { FastifyPluginAsync } from 'fastify';
import { and, eq, sql } from 'drizzle-orm';
import {
  SpillwayError,
  internalBus,
  createBudgetSchema,
  updateBudgetSchema,
} from '@spillway/shared';
import type { DatabaseClient } from '../../db/client.js';
import { budgets, orgs, teams, virtualKeys } from '../../db/schema.js';
import { orgContext } from '../../org-context.js';
import { withOrg } from '../../db/tenancy.js';
import { requireRole } from '../../auth/rbac.js';
import { resolveEntitlements, type Entitlement } from '../../auth/entitlements.js';
import { appendAudit } from '../../services/audit.js';
import { parse } from '../validate.js';

export interface BudgetsDeps {
  db: DatabaseClient;
}

const publicCols = {
  id: budgets.id,
  scopeType: budgets.scopeType,
  scopeId: budgets.scopeId,
  period: budgets.period,
  limitUsd: budgets.limitUsd,
  mode: budgets.mode,
  onExceed: budgets.onExceed,
  fallbackAlias: budgets.fallbackAlias,
  createdAt: budgets.createdAt,
};

/** orgs has no RLS (global-ish, keyed by pk) — read the plan directly for the entitlement gate. */
async function orgPlan(db: DatabaseClient, orgId: string): Promise<string> {
  const [row] = await db.select({ plan: orgs.plan }).from(orgs).where(eq(orgs.id, orgId)).limit(1);
  return row?.plan ?? 'free';
}

function requireEntitlement(ent: ReadonlySet<Entitlement>, need: Entitlement, msg: string): void {
  if (!ent.has(need))
    throw new SpillwayError('tier_required', msg, {
      httpStatus: 402,
      details: { entitlement: need },
    });
}

/**
 * Budgets CRUD (17 §1.11/§1.12; ADR-018/039). Admin+. Entitlement gates resolve from the org plan
 * (data, never an ordinal compare): budgets = Pro+; team/vk scope = hierarchical_budgets, provider
 * scope = provider_caps, on_exceed:fallback = budget_fallback (all Governance+). A cross-org scope_id
 * is re-checked under RLS (ADR-032 H1). Every mutation emits org:mutated post-commit (budgets travel
 * in the cached bundle — B1.2 invalidation lint).
 */
export const budgetsRoutes: FastifyPluginAsync<BudgetsDeps> = async (fastify, { db }) => {
  fastify.get('/budgets', async () => {
    const { orgId } = orgContext.require();
    const rows = await withOrg(db, orgId, (tx) => tx.select(publicCols).from(budgets));
    return { budgets: rows };
  });

  fastify.post('/budgets', async (request, reply) => {
    const { orgId, userId } = orgContext.require();
    requireRole('admin');
    const body = parse(createBudgetSchema, request.body);

    const ent = resolveEntitlements(await orgPlan(db, orgId));
    requireEntitlement(ent, 'budgets', 'budgets require the Pro plan or higher');
    if (body.scopeType === 'team' || body.scopeType === 'virtual_key') {
      requireEntitlement(
        ent,
        'hierarchical_budgets',
        'team/key budgets require the Governance plan',
      );
    }
    if (body.scopeType === 'provider') {
      requireEntitlement(ent, 'provider_caps', 'provider caps require the Governance plan');
    }
    if (body.onExceed === 'fallback') {
      requireEntitlement(ent, 'budget_fallback', 'budget fallback requires the Governance plan');
    }

    const created = await withOrg(db, orgId, async (tx) => {
      // Cross-org scope_id re-check (ADR-032 H1): the scope must belong to THIS org under RLS —
      // Postgres RI would accept a borrowed uuid; RLS-scoped SELECTs only see same-org rows.
      if (body.scopeType === 'org' && body.scopeId !== orgId) {
        throw new SpillwayError('validation_error', 'org budget scope_id must equal the org id', {
          httpStatus: 400,
          details: { param: 'scopeId' },
        });
      }
      if (body.scopeType === 'team') {
        const [t] = await tx
          .select({ id: teams.id })
          .from(teams)
          .where(eq(teams.id, body.scopeId))
          .limit(1);
        if (!t)
          throw new SpillwayError('validation_error', 'team not found in this org', {
            httpStatus: 400,
            details: { param: 'scopeId' },
          });
      }
      if (body.scopeType === 'virtual_key') {
        const [k] = await tx
          .select({ id: virtualKeys.id })
          .from(virtualKeys)
          .where(eq(virtualKeys.id, body.scopeId))
          .limit(1);
        if (!k)
          throw new SpillwayError('validation_error', 'virtual key not found in this org', {
            httpStatus: 400,
            details: { param: 'scopeId' },
          });
      }
      const [row] = await tx
        .insert(budgets)
        .values({
          orgId,
          scopeType: body.scopeType,
          scopeId: body.scopeId,
          period: body.period,
          limitUsd: body.limitUsd,
          mode: body.mode,
          onExceed: body.onExceed,
          fallbackAlias: body.fallbackAlias ?? null,
          createdBy: userId,
        })
        .returning(publicCols);
      if (!row) throw new Error('budget insert returned no row');
      await appendAudit(tx, {
        action: 'budget.create',
        target: { type: 'budget', id: row.id },
        meta: { scopeType: body.scopeType, period: body.period },
      });
      return row;
    });
    internalBus.emit('org:mutated', { orgId }); // budgets read into the bundle → sweep (B1.2)
    reply.code(201);
    return { budget: created };
  });

  fastify.patch<{ Params: { id: string } }>('/budgets/:id', async (request) => {
    const { orgId } = orgContext.require();
    requireRole('admin');
    const { id } = request.params;
    const body = parse(updateBudgetSchema, request.body);
    if (body.onExceed === 'fallback' || body.fallbackAlias != null) {
      requireEntitlement(
        resolveEntitlements(await orgPlan(db, orgId)),
        'budget_fallback',
        'budget fallback requires the Governance plan',
      );
    }
    const updated = await withOrg(db, orgId, async (tx) => {
      const [row] = await tx
        .update(budgets)
        .set({
          ...(body.limitUsd !== undefined ? { limitUsd: body.limitUsd } : {}),
          ...(body.mode !== undefined ? { mode: body.mode } : {}),
          ...(body.onExceed !== undefined ? { onExceed: body.onExceed } : {}),
          ...(body.fallbackAlias !== undefined ? { fallbackAlias: body.fallbackAlias } : {}),
          updatedAt: sql`now()`,
        })
        .where(and(eq(budgets.id, id), eq(budgets.orgId, orgId)))
        .returning(publicCols);
      if (!row) throw new SpillwayError('not_found', 'budget not found', { httpStatus: 404 });
      await appendAudit(tx, { action: 'budget.update', target: { type: 'budget', id } });
      return row;
    });
    internalBus.emit('org:mutated', { orgId });
    return { budget: updated };
  });

  fastify.delete<{ Params: { id: string } }>('/budgets/:id', async (request, reply) => {
    const { orgId } = orgContext.require();
    requireRole('admin');
    const { id } = request.params;
    await withOrg(db, orgId, async (tx) => {
      const del = await tx
        .delete(budgets)
        .where(and(eq(budgets.id, id), eq(budgets.orgId, orgId)))
        .returning({ id: budgets.id });
      if (del.length === 0)
        throw new SpillwayError('not_found', 'budget not found', { httpStatus: 404 });
      await appendAudit(tx, { action: 'budget.delete', target: { type: 'budget', id } });
      // B7 seam: auto-cancel any pending approval referencing this budget (17 §1.12) — wired with
      // the approval engine.
    });
    internalBus.emit('org:mutated', { orgId });
    reply.code(204);
  });
};
