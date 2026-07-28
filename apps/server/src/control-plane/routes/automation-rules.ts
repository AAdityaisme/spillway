import type { FastifyPluginAsync } from 'fastify';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  SpillwayError,
  createAutomationRuleSchema,
  updateAutomationRuleSchema,
} from '@spillway/shared';
import type { DatabaseClient } from '../../db/client.js';
import { automationRules, orgs } from '../../db/schema.js';
import { orgContext } from '../../org-context.js';
import { withOrg } from '../../db/tenancy.js';
import { requireRole } from '../../auth/rbac.js';
import { resolveEntitlements } from '../../auth/entitlements.js';
import { appendAudit } from '../../services/audit.js';
import { validateRuleCondition } from '../../services/automation/safety.js';
import { defaultNextCronFire } from '../../services/automation/timers.js';
import { parse } from '../validate.js';

export interface AutomationRulesDeps {
  db: DatabaseClient;
}

const publicCols = {
  id: automationRules.id,
  name: automationRules.name,
  priority: automationRules.priority,
  triggerType: automationRules.triggerType,
  condition: automationRules.condition,
  action: automationRules.action,
  state: automationRules.state,
  stopOnMatch: automationRules.stopOnMatch,
  rateCapPerHour: automationRules.rateCapPerHour,
  scheduleCron: automationRules.scheduleCron,
  createdAt: automationRules.createdAt,
};

/** Bulk priority reorder body: a full list of {id, priority} applied in one tx (L38). */
const reorderSchema = z.object({
  order: z
    .array(z.object({ id: z.string().uuid(), priority: z.number().int().min(0).max(100_000) }))
    .min(1)
    .max(1000),
});

async function requireAutomation(db: DatabaseClient, orgId: string): Promise<void> {
  const [row] = await db.select({ plan: orgs.plan }).from(orgs).where(eq(orgs.id, orgId)).limit(1);
  if (!resolveEntitlements(row?.plan ?? 'free').has('automation'))
    throw new SpillwayError('tier_required', 'automation requires the Governance plan', {
      httpStatus: 402,
      details: { entitlement: 'automation' },
    });
}

/**
 * Automation-rules CRUD (18 §3.2). Governance-tier ('automation'). Admin+. The condition is
 * threshold-isolation validated (validateRuleCondition → 422) so a fired rule stays explainable. Rules
 * are read by the poller job (not the routing bundle) → no bundle-invalidation emit.
 */
export const automationRulesRoutes: FastifyPluginAsync<AutomationRulesDeps> = async (
  fastify,
  { db },
) => {
  // Reads entitlement-free by design — see alerts.ts DECISION note + reads-free.integration.test.ts.
  fastify.get('/automation-rules', async () => {
    const { orgId } = orgContext.require();
    const rows = await withOrg(db, orgId, (tx) =>
      tx.select(publicCols).from(automationRules).orderBy(automationRules.priority),
    );
    return { automationRules: rows };
  });

  fastify.post('/automation-rules', async (request, reply) => {
    const { orgId, userId } = orgContext.require();
    requireRole('admin');
    await requireAutomation(db, orgId);
    const body = parse(createAutomationRuleSchema, request.body);
    const condition = body.condition ?? {};
    validateRuleCondition(condition);
    const created = await withOrg(db, orgId, async (tx) => {
      const [row] = await tx
        .insert(automationRules)
        .values({
          orgId,
          name: body.name,
          priority: body.priority,
          triggerType: body.triggerType,
          condition,
          action: body.action,
          state: body.state,
          stopOnMatch: body.stopOnMatch,
          rateCapPerHour: body.rateCapPerHour,
          scheduleCron: body.scheduleCron ?? null,
          notifyOnlyUntil: body.notifyOnlyUntil ? new Date(body.notifyOnlyUntil) : null,
          createdBy: userId,
        })
        .returning(publicCols);
      if (!row) throw new Error('automation rule insert returned no row');
      // Arm the FIRST rule_schedule timer so a schedule_cron rule actually fires (expanded-audit M37 —
      // the dispatch branch existed but nothing seeded the initial timer, so scheduled automation was
      // dead). The sweep re-arms each subsequent fire; @every-style crons are honored by
      // defaultNextCronFire (anything it can't parse → no timer, same as the sweep).
      const cron = body.scheduleCron ?? null;
      if (cron !== null) {
        const firstFire = defaultNextCronFire(cron, new Date());
        if (firstFire)
          await tx.execute(sql`
            insert into workflow_timers (org_id, kind, ref_id, fire_at)
            values (${orgId}, 'rule_schedule', ${row.id}, ${firstFire.toISOString()})
            on conflict (ref_id, kind, fire_at) do nothing`);
      }
      await appendAudit(tx, {
        action: 'automation_rule.create',
        target: { type: 'automation_rule', id: row.id },
        meta: { triggerType: body.triggerType, state: body.state },
      });
      return row;
    });
    reply.code(201);
    return { automationRule: created };
  });

  // Atomic bulk reorder (expanded-audit L38). A PATCH of a single priority into a value another rule
  // already holds → 23505; the only safe swap is to reassign all touched rows in ONE tx and let the
  // DEFERRABLE INITIALLY DEFERRED UNIQUE(org_id, priority) (migration 0015) defer the check to commit.
  fastify.post('/automation-rules/reorder', async (request) => {
    const { orgId } = orgContext.require();
    requireRole('admin');
    await requireAutomation(db, orgId);
    const body = parse(reorderSchema, request.body);
    const ids = body.order.map((o) => o.id);
    if (new Set(ids).size !== ids.length)
      throw new SpillwayError('validation_error', 'duplicate rule id in order', {
        httpStatus: 400,
      });
    const priorities = body.order.map((o) => o.priority);
    if (new Set(priorities).size !== priorities.length)
      throw new SpillwayError('validation_error', 'duplicate priority in order', {
        httpStatus: 400,
      });
    const rules = await withOrg(db, orgId, async (tx) => {
      // Ownership check: every id must belong to this org (RLS already scopes, this makes it a clean 404).
      const owned = await tx
        .select({ id: automationRules.id })
        .from(automationRules)
        .where(and(eq(automationRules.orgId, orgId), inArray(automationRules.id, ids)));
      if (owned.length !== ids.length)
        throw new SpillwayError('not_found', 'one or more automation rules not found', {
          httpStatus: 404,
        });
      for (const o of body.order) {
        await tx
          .update(automationRules)
          .set({ priority: o.priority, updatedAt: sql`now()` })
          .where(and(eq(automationRules.id, o.id), eq(automationRules.orgId, orgId)));
      }
      await appendAudit(tx, {
        action: 'automation_rule.reorder',
        target: { type: 'org', id: orgId },
        meta: { count: body.order.length },
      });
      return tx.select(publicCols).from(automationRules).orderBy(automationRules.priority);
    });
    return { automationRules: rules };
  });

  fastify.patch<{ Params: { id: string } }>('/automation-rules/:id', async (request) => {
    const { orgId } = orgContext.require();
    requireRole('admin');
    await requireAutomation(db, orgId);
    const { id } = request.params;
    const body = parse(updateAutomationRuleSchema, request.body);
    if (body.condition !== undefined) validateRuleCondition(body.condition);
    const updated = await withOrg(db, orgId, async (tx) => {
      const [row] = await tx
        .update(automationRules)
        .set({
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.priority !== undefined ? { priority: body.priority } : {}),
          ...(body.condition !== undefined ? { condition: body.condition } : {}),
          ...(body.action !== undefined ? { action: body.action } : {}),
          ...(body.state !== undefined ? { state: body.state } : {}),
          ...(body.stopOnMatch !== undefined ? { stopOnMatch: body.stopOnMatch } : {}),
          ...(body.rateCapPerHour !== undefined ? { rateCapPerHour: body.rateCapPerHour } : {}),
          ...(body.scheduleCron !== undefined ? { scheduleCron: body.scheduleCron } : {}),
          ...(body.notifyOnlyUntil !== undefined
            ? { notifyOnlyUntil: body.notifyOnlyUntil ? new Date(body.notifyOnlyUntil) : null }
            : {}),
          updatedAt: sql`now()`,
        })
        .where(and(eq(automationRules.id, id), eq(automationRules.orgId, orgId)))
        .returning(publicCols);
      if (!row)
        throw new SpillwayError('not_found', 'automation rule not found', { httpStatus: 404 });
      await appendAudit(tx, {
        action: 'automation_rule.update',
        target: { type: 'automation_rule', id },
      });
      return row;
    });
    return { automationRule: updated };
  });

  fastify.delete<{ Params: { id: string } }>('/automation-rules/:id', async (request, reply) => {
    const { orgId } = orgContext.require();
    requireRole('admin');
    await requireAutomation(db, orgId);
    const { id } = request.params;
    await withOrg(db, orgId, async (tx) => {
      const del = await tx
        .delete(automationRules)
        .where(and(eq(automationRules.id, id), eq(automationRules.orgId, orgId)))
        .returning({ id: automationRules.id });
      if (del.length === 0)
        throw new SpillwayError('not_found', 'automation rule not found', { httpStatus: 404 });
      await appendAudit(tx, {
        action: 'automation_rule.delete',
        target: { type: 'automation_rule', id },
      });
    });
    reply.code(204);
  });
};
