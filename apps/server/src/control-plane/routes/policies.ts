import type { FastifyPluginAsync } from 'fastify';
import { and, eq, sql } from 'drizzle-orm';
import {
  SpillwayError,
  internalBus,
  createPolicySchema,
  updatePolicySchema,
} from '@spillway/shared';
import type { DatabaseClient } from '../../db/client.js';
import { governancePolicies, orgs } from '../../db/schema.js';
import { orgContext } from '../../org-context.js';
import { withOrg } from '../../db/tenancy.js';
import { isUniqueViolation } from '../../db/pg-error.js';
import { requireRole } from '../../auth/rbac.js';
import { resolveEntitlements } from '../../auth/entitlements.js';
import { appendAudit } from '../../services/audit.js';
import { BufbuildConditionEvaluator } from '../../data-plane/policy/condition-evaluator.js';
import { CelCompileError } from '../../data-plane/policy/bounds.js';
import { lintConfig } from '../../data-plane/policy/lint.js';
import type { MatchSpec } from '../../data-plane/policy/guardrail-types.js';
import { parse } from '../validate.js';

export interface PoliciesDeps {
  db: DatabaseClient;
}

interface LintTarget {
  provider: string;
  model: string;
}

/** Flatten a stored TypedChain ({default, context_window?, content_policy?}) into a flat target list. */
function chainTargets(chain: unknown): LintTarget[] {
  const c = chain as {
    default?: LintTarget[];
    context_window?: LintTarget[];
    content_policy?: LintTarget[];
  } | null;
  if (!c || typeof c !== 'object') return [];
  return [...(c.default ?? []), ...(c.context_window ?? []), ...(c.content_policy ?? [])];
}

/** The {provider,model} targets a routing rule's action routes TO (§9.1 L3): a rewrite `to` (+ its
 *  fallbacks) or a set_fallbacks chain. Unknown/deny actions carry no route-to target. */
function actionTargets(action: unknown): LintTarget[] {
  const a = action as {
    type?: string;
    to?: LintTarget;
    fallbacks?: unknown;
    chain?: unknown;
  } | null;
  if (!a || typeof a !== 'object') return [];
  if (a.type === 'rewrite_model') return [...(a.to ? [a.to] : []), ...chainTargets(a.fallbacks)];
  if (a.type === 'set_fallbacks') return chainTargets(a.chain);
  return [];
}

const publicCols = {
  id: governancePolicies.id,
  name: governancePolicies.name,
  description: governancePolicies.description,
  effect: governancePolicies.effect,
  reason: governancePolicies.reason,
  match: governancePolicies.match,
  conditionCel: governancePolicies.conditionCel,
  conditionCost: governancePolicies.conditionCost,
  enforcement: governancePolicies.enforcement,
  enabled: governancePolicies.enabled,
  revision: governancePolicies.revision,
  createdAt: governancePolicies.createdAt,
};

interface CompiledCel {
  conditionCel: string | null;
  conditionProgram: Buffer | null;
  conditionCost: number | null;
}

/**
 * Guardrail-policy CRUD (16 §2/§5). Governance-tier (entitlement 'guardrails'). Admin+. CEL is
 * compiled + statically bounds-checked at AUTHORING here (the request path never compiles): a
 * CelCompileError maps to its 422 cel_* code; the compiled program + cost are stored, so the
 * (condition_cel IS NULL) = (condition_program IS NULL) CHECK always holds. Every mutation emits
 * org:mutated (policies travel in the cached bundle — B1.2 invalidation lint).
 */
export const policiesRoutes: FastifyPluginAsync<PoliciesDeps> = async (fastify, { db }) => {
  const evaluator = new BufbuildConditionEvaluator();

  // 16 §3.4 is settled on the intent (require_approval → terminal 403 + approval opened), but the
  // *grant* mechanism — what an approved guardrail-approval does so the caller's retry passes — is not
  // concretely specified (no guardrail approval kind, no grant record, no gate-flip check; the effect
  // kinds are budget_increase/key_unpause). Shipping an invented grant on the money/security path would
  // be silent improvisation on a security-sensitive gate. Until an ADR settles the grant model, reject
  // authoring a require_approval policy with a clear 422 instead of letting it become a silent permanent
  // 403 at request time (the guardrail-stage LANDMINE). Flip this to full enforcement when the ADR lands.
  function assertSupportedEffect(effect: string | undefined): void {
    if (effect === 'require_approval') {
      throw new SpillwayError(
        'validation_error',
        'require_approval guardrails are not yet available (the approval-grant mechanism, 16 §3.4, is pending an ADR). Use deny or flag.',
        { httpStatus: 422, details: { effect: 'require_approval' } },
      );
    }
  }

  async function requireGuardrails(orgId: string): Promise<void> {
    const [row] = await db
      .select({ plan: orgs.plan })
      .from(orgs)
      .where(eq(orgs.id, orgId))
      .limit(1);
    if (!resolveEntitlements(row?.plan ?? 'free').has('guardrails')) {
      throw new SpillwayError('tier_required', 'guardrail policies require the Governance plan', {
        httpStatus: 402,
        details: { entitlement: 'guardrails' },
      });
    }
  }

  /** Compile CEL at authoring; CelCompileError → its 422 code. null source → no condition. */
  function compileCel(source: string | null | undefined): CompiledCel {
    if (source == null || source === '')
      return { conditionCel: null, conditionProgram: null, conditionCost: null };
    try {
      const c = evaluator.compile(source);
      return {
        conditionCel: c.source,
        conditionProgram: Buffer.from(c.program),
        conditionCost: c.cost,
      };
    } catch (e) {
      if (e instanceof CelCompileError)
        throw new SpillwayError(e.code, e.message, { httpStatus: 422, details: e.details });
      throw e;
    }
  }

  fastify.get('/policies', async () => {
    const { orgId } = orgContext.require();
    const rows = await withOrg(db, orgId, (tx) => tx.select(publicCols).from(governancePolicies));
    return { policies: rows };
  });

  // 16 §9.1 policy lint — static analysis of the effective routing rules + guardrail policies (L1–L6).
  fastify.post('/policies/lint', async () => {
    const { orgId } = orgContext.require();
    requireRole('admin');
    await requireGuardrails(orgId);
    return withOrg(db, orgId, async (tx) => {
      const asJson = <T>(v: unknown): T => (typeof v === 'string' ? JSON.parse(v) : v) as T;
      const rr = (await tx.execute(sql`
        select id, priority, match, action, enabled from routing_rules`)) as unknown as {
        id: string;
        priority: number;
        match: unknown;
        action: unknown;
        enabled: boolean;
      }[];
      const pol = (await tx.execute(sql`
        select id, condition_cost, condition_cel, effect, enforcement, match, enabled
        from governance_policies`)) as unknown as {
        id: string;
        condition_cost: number | null;
        condition_cel: string | null;
        effect: string;
        enforcement: string;
        match: unknown;
        enabled: boolean;
      }[];
      const al = (await tx.execute(sql`
        select alias, targets from model_aliases`)) as unknown as {
        alias: string;
        targets: unknown;
      }[];
      // Providers with an active credential — an alias target on any other provider can never dispatch (L4).
      const pk = (await tx.execute(sql`
        select distinct provider from provider_keys where status = 'active'`)) as unknown as {
        provider: string;
      }[];

      const rules = rr.map((r) => ({
        id: r.id,
        priority: r.priority,
        match: asJson<MatchSpec>(r.match),
        enabled: r.enabled,
        targets: actionTargets(asJson(r.action)),
      }));
      const policies = pol.map((p) => ({
        id: p.id,
        conditionCost: p.condition_cost,
        enabled: p.enabled,
        effect: p.effect,
        enforcement: p.enforcement,
        match: asJson<MatchSpec>(p.match),
        conditionCel: p.condition_cel,
      }));
      const aliases = al.map((a) => ({
        alias: a.alias,
        targets: asJson<{ provider: string; model: string }[]>(a.targets),
      }));
      return {
        findings: lintConfig(rules, policies, {
          aliases,
          activeProviders: pk.map((r) => r.provider),
        }),
      };
    });
  });

  fastify.post('/policies', async (request, reply) => {
    const { orgId, userId } = orgContext.require();
    requireRole('admin');
    await requireGuardrails(orgId);
    const body = parse(createPolicySchema, request.body);
    assertSupportedEffect(body.effect);
    const cel = compileCel(body.conditionCel);

    let created;
    try {
      created = await withOrg(db, orgId, async (tx) => {
        const [row] = await tx
          .insert(governancePolicies)
          .values({
            orgId,
            name: body.name,
            description: body.description ?? null,
            effect: body.effect,
            reason: body.reason,
            match: body.match,
            conditionCel: cel.conditionCel,
            conditionProgram: cel.conditionProgram,
            conditionCost: cel.conditionCost,
            enforcement: body.enforcement,
            enabled: body.enabled,
            effectConfig: body.effectConfig,
            createdBy: userId,
          })
          .returning(publicCols);
        if (!row) throw new Error('policy insert returned no row');
        await appendAudit(tx, {
          action: 'policy.create',
          target: { type: 'governance_policy', id: row.id },
          meta: { effect: body.effect, enforcement: body.enforcement },
        });
        return row;
      });
    } catch (e) {
      if (isUniqueViolation(e))
        throw new SpillwayError('conflict', `policy '${body.name}' already exists`, {
          httpStatus: 409,
        });
      throw e;
    }
    internalBus.emit('org:mutated', { orgId });
    reply.code(201);
    return { policy: created };
  });

  fastify.patch<{ Params: { id: string } }>('/policies/:id', async (request) => {
    const { orgId } = orgContext.require();
    requireRole('admin');
    await requireGuardrails(orgId);
    const { id } = request.params;
    const body = parse(updatePolicySchema, request.body);
    assertSupportedEffect(body.effect);
    // Recompile CEL only when the field is present in the patch (undefined = leave unchanged).
    const celPatch = body.conditionCel !== undefined ? compileCel(body.conditionCel) : null;
    const updated = await withOrg(db, orgId, async (tx) => {
      const [row] = await tx
        .update(governancePolicies)
        .set({
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.effect !== undefined ? { effect: body.effect } : {}),
          ...(body.reason !== undefined ? { reason: body.reason } : {}),
          ...(body.match !== undefined ? { match: body.match } : {}),
          ...(celPatch !== null
            ? {
                conditionCel: celPatch.conditionCel,
                conditionProgram: celPatch.conditionProgram,
                conditionCost: celPatch.conditionCost,
              }
            : {}),
          ...(body.enforcement !== undefined ? { enforcement: body.enforcement } : {}),
          ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
          ...(body.effectConfig !== undefined ? { effectConfig: body.effectConfig } : {}),
          revision: sql`${governancePolicies.revision} + 1`,
          updatedAt: sql`now()`,
        })
        .where(and(eq(governancePolicies.id, id), eq(governancePolicies.orgId, orgId)))
        .returning(publicCols);
      if (!row) throw new SpillwayError('not_found', 'policy not found', { httpStatus: 404 });
      await appendAudit(tx, { action: 'policy.update', target: { type: 'governance_policy', id } });
      return row;
    });
    internalBus.emit('org:mutated', { orgId });
    return { policy: updated };
  });

  fastify.delete<{ Params: { id: string } }>('/policies/:id', async (request, reply) => {
    const { orgId } = orgContext.require();
    requireRole('admin');
    await requireGuardrails(orgId);
    const { id } = request.params;
    await withOrg(db, orgId, async (tx) => {
      const del = await tx
        .delete(governancePolicies)
        .where(and(eq(governancePolicies.id, id), eq(governancePolicies.orgId, orgId)))
        .returning({ id: governancePolicies.id });
      if (del.length === 0)
        throw new SpillwayError('not_found', 'policy not found', { httpStatus: 404 });
      await appendAudit(tx, { action: 'policy.delete', target: { type: 'governance_policy', id } });
    });
    internalBus.emit('org:mutated', { orgId });
    reply.code(204);
  });
};
