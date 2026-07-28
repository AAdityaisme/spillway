import { z, type ZodType } from 'zod';
import { sql } from 'drizzle-orm';
import { SpillwayError, internalBus } from '@spillway/shared';
import { parseUsd, formatUsd } from '@spillway/pricing';
import type { Tx } from '../../db/tenancy.js';
import { selectPolicy } from '../approvals/policy-select.js';
import {
  materializeChain,
  type ApprovalPolicyRow,
  type ApprovalRequestRow,
  type Membership,
} from '../approvals/materialize.js';

/**
 * Effect-handler registry (Part II §18 §3.4) — ONE module called by BOTH the approval final-apply
 * (§2.8) and the automation poller (§3.3). This is the single swap-point a future DBOS/Temporal
 * executor reuses (§3.7): the domain never moves.
 *
 * Every handler is idempotent, keyed, and DB-local. `compensate` is RESERVED and empty for every v1
 * handler — all v1 effects are covered by the apply-tx ACID rollback (workflow-engines F12); the slot
 * exists so a future non-DB must-undo effect can populate it without a signature change. Do NOT
 * implement sagas here.
 *
 * `meta.source`/actor split (§3.4 / §5.4): the poller sets actor={type:'system',id:null},
 * source='automation' + {rule_id, trigger_event_id}; approval final-apply sets
 * actor={type:'user',id:decidedBy}, source='approval'. This is how the audit trail distinguishes a
 * human pause from a rule-triggered one.
 */

// ── registry contracts (§3.4) ─────────────────────────────────────────────────

const jsonb = (v: unknown) => sql`${JSON.stringify(v)}::jsonb`;

/** Raw tx.execute returns jsonb columns as STRINGS — coerce back (cf. B4). */
function asJson<T>(v: unknown): T {
  return (typeof v === 'string' ? JSON.parse(v) : v) as T;
}

export interface EffectContext {
  tx: Tx;
  orgId: string;
  actor: { type: 'user' | 'system'; id: string | null };
  /** Distinguishes automation | approval | automation:suspend | action_token in the audit trail. */
  source: string;
  ruleId?: string;
  trigger_event_id?: string;
  now: Date;
  /**
   * Post-commit hook collector (ADR-038 §2.12). An effect that narrows access (pause a key, tighten a
   * budget) MUST invalidate the policy LRU so the change takes effect ≤ instantly, not after the 30s
   * TTL — the kill-switch guarantee. The emit MUST run AFTER the owning tx commits: emitting mid-tx
   * lets a concurrent cache-fill re-read the pre-commit (stale) row and re-cache it. The tx-owning
   * caller (the automation poller) collects these and flushes them post-commit. Absent for callers
   * that already invalidate broadly post-commit (the approval decision path emits org:mutated).
   */
  onCommit?: (fn: () => void) => void;
}

/** What an effect did — merged into the `automation_runs.effect` jsonb (§3.3 step 6). */
export type EffectResult = Record<string, unknown>;

export interface EffectHandler<P> {
  params: ZodType<P>;
  auditAction: string | null;
  apply(ctx: EffectContext, key: string, params: P): Promise<EffectResult>;
  /** RESERVED — empty for every v1 handler (§3.4). */
  compensate?: undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type EffectRegistry = Record<string, EffectHandler<any>>;

/** Resolves an org's role→user membership for `require_approval` (org_members in V2). */
export interface EffectRegistryDeps {
  membershipFor: (orgId: string, tx: Tx) => Promise<Membership> | Membership;
}

// ── audit helper (§3.4 / §5.4) ─────────────────────────────────────────────────

/** Register the post-commit policy-cache invalidation for a key/org state change (ADR-038 §2.12). */
function invalidateKey(ctx: EffectContext, virtualKeyId: string): void {
  ctx.onCommit?.(() => internalBus.emit('virtual-key:mutated', { virtualKeyId }));
}
function invalidateOrg(ctx: EffectContext): void {
  const orgId = ctx.orgId;
  ctx.onCommit?.(() => internalBus.emit('org:mutated', { orgId }));
}

function baseMeta(ctx: EffectContext): Record<string, unknown> {
  const m: Record<string, unknown> = { source: ctx.source };
  if (ctx.ruleId !== undefined) m.rule_id = ctx.ruleId;
  if (ctx.trigger_event_id !== undefined) m.trigger_event_id = ctx.trigger_event_id;
  return m;
}

async function writeAudit(
  ctx: EffectContext,
  action: string,
  targetType: string,
  targetId: string,
  meta: Record<string, unknown>,
): Promise<void> {
  await ctx.tx.execute(sql`
    insert into audit_log (org_id, actor_type, actor_id, action, target, meta)
    values (${ctx.orgId}, ${ctx.actor.type}, ${ctx.actor.id}, ${action},
            ${jsonb({ type: targetType, id: targetId })}, ${jsonb(meta)})`);
}

// ── param schemas ─────────────────────────────────────────────────────────────

const uuid = z.string().uuid();
const pauseParams = z.object({ virtual_key_id: uuid });
const tightenParams = z.object({
  scope_type: z.string(),
  scope_id: uuid,
  period: z.string(),
  factor: z.number().positive().optional(),
  new_limit_usd: z.string().optional(),
});
const budgetIncreaseParams = z.object({
  scope_type: z.string(),
  scope_id: uuid,
  period: z.string(),
  new_limit_usd: z.string(),
});
const notifyParams = z.object({
  channel_ref: uuid.optional(),
  channels: z.array(z.string()).optional(),
  template: z.string().optional(),
  payload: z.record(z.unknown()).optional(),
});
const requireApprovalParams = z.object({
  kind: z.string(),
  scope_type: z.string().optional(),
  scope_id: uuid.optional(),
  amount_usd: z.string().optional(),
  current_value: z.record(z.unknown()).optional(),
  requested_value: z.record(z.unknown()).optional(),
});
const createAlertParams = z.object({
  kind: z.string(),
  payload: z.record(z.unknown()).optional(),
  dedupe_key: z.string().optional(),
});
const suspendParams = z.object({ virtual_key_id: uuid, seconds: z.number().int().positive() });

// ── state-check pause / unpause (shared by pause_key, unpause_key, suspend) ────

/** Flip `virtual_keys.status` only from `from`→`to`; returns whether a row actually changed. */
async function flipKey(tx: Tx, keyId: string, from: string, to: string): Promise<boolean> {
  const rows = (await tx.execute(sql`
    update virtual_keys set status = ${to}, updated_at = now()
     where id = ${keyId} and status = ${from} returning id`)) as unknown as unknown[];
  return rows.length > 0;
}

// ── registry ──────────────────────────────────────────────────────────────────

export function makeEffectRegistry(deps: EffectRegistryDeps): EffectRegistry {
  const pause_key: EffectHandler<z.infer<typeof pauseParams>> = {
    params: pauseParams,
    auditAction: 'virtual_key.pause',
    async apply(ctx, _key, p) {
      const flipped = await flipKey(ctx.tx, p.virtual_key_id, 'active', 'paused');
      // A hard kill supersedes any temporary suspend: cancel its pending auto-resume so the killed
      // key can never silently reactivate (§4.2 / §5.2 — unpause is admin/approval-gated). NOT gated
      // on `flipped`: a pause landing during a suspend is a no-op flip but must still cancel resume.
      await ctx.tx.execute(sql`
        delete from workflow_timers
         where ref_id = ${p.virtual_key_id} and kind = 'automation_suspend' and fired_at is null`);
      if (flipped) {
        await writeAudit(ctx, 'virtual_key.pause', 'virtual_key', p.virtual_key_id, baseMeta(ctx));
        invalidateKey(ctx, p.virtual_key_id); // kill switch: drop the cached key ≤ instantly (§5.1)
      }
      return { paused_key: p.virtual_key_id, ...(flipped ? {} : { noop: true }) };
    },
  };

  const unpause_key: EffectHandler<z.infer<typeof pauseParams>> = {
    params: pauseParams,
    auditAction: 'virtual_key.unpause',
    async apply(ctx, _key, p) {
      const flipped = await flipKey(ctx.tx, p.virtual_key_id, 'paused', 'active');
      if (flipped) {
        await writeAudit(
          ctx,
          'virtual_key.unpause',
          'virtual_key',
          p.virtual_key_id,
          baseMeta(ctx),
        );
        invalidateKey(ctx, p.virtual_key_id); // reactivation must also refresh the cached key
      }
      return { unpaused_key: p.virtual_key_id, ...(flipped ? {} : { noop: true }) };
    },
  };

  const tighten_budget: EffectHandler<z.infer<typeof tightenParams>> = {
    params: tightenParams,
    auditAction: 'budget.update',
    async apply(ctx, _key, p) {
      const rows = (await ctx.tx.execute(sql`
        select limit_usd from budgets
         where org_id = ${ctx.orgId} and scope_type = ${p.scope_type}
           and scope_id = ${p.scope_id} and period = ${p.period}`)) as unknown as {
        limit_usd: string;
      }[];
      if (rows.length === 0) {
        // Nothing to clamp; only a new_limit_usd target can seed a (narrowing) budget.
        if (p.new_limit_usd === undefined) return { tightened: false, reason: 'no_budget' };
        const target = formatUsd(parseUsd(p.new_limit_usd));
        await ctx.tx.execute(sql`
          insert into budgets (org_id, scope_type, scope_id, period, limit_usd)
          values (${ctx.orgId}, ${p.scope_type}, ${p.scope_id}, ${p.period}, ${target})
          on conflict (org_id, scope_type, scope_id, period) do nothing`);
        await writeAudit(ctx, 'budget.update', 'budget', p.scope_id, {
          ...baseMeta(ctx),
          period: p.period,
          limit_usd: target,
        });
        invalidateOrg(ctx); // budget seeded → invalidate the org bundle (§2.12)
        return { budget_limit: target };
      }
      const current = parseUsd(rows[0]!.limit_usd);
      const rawTarget =
        p.new_limit_usd !== undefined
          ? parseUsd(p.new_limit_usd)
          : (current * parseUsd(String(p.factor ?? 1))) / 1_000_000n;
      // NEVER raise — clamp to min(current, target); re-apply at the same target is a no-op.
      const clamped = rawTarget < current ? rawTarget : current;
      if (clamped >= current) return { budget_limit: formatUsd(current), noop: true };
      const target = formatUsd(clamped);
      await ctx.tx.execute(sql`
        update budgets set limit_usd = ${target}, updated_at = now()
         where org_id = ${ctx.orgId} and scope_type = ${p.scope_type}
           and scope_id = ${p.scope_id} and period = ${p.period}`);
      await writeAudit(ctx, 'budget.update', 'budget', p.scope_id, {
        ...baseMeta(ctx),
        period: p.period,
        limit_usd: target,
      });
      invalidateOrg(ctx); // budget changed → invalidate the org bundle (§2.12)
      return { budget_limit: target };
    },
  };

  const apply_budget_increase: EffectHandler<z.infer<typeof budgetIncreaseParams>> = {
    params: budgetIncreaseParams,
    auditAction: 'budget.update',
    async apply(ctx, _key, p) {
      // Sets the limit unconditionally (no clamp); re-apply at the same target is a no-op.
      const target = formatUsd(parseUsd(p.new_limit_usd));
      await ctx.tx.execute(sql`
        insert into budgets (org_id, scope_type, scope_id, period, limit_usd)
        values (${ctx.orgId}, ${p.scope_type}, ${p.scope_id}, ${p.period}, ${target})
        on conflict (org_id, scope_type, scope_id, period)
          do update set limit_usd = ${target}, updated_at = now()`);
      await writeAudit(ctx, 'budget.update', 'budget', p.scope_id, {
        ...baseMeta(ctx),
        period: p.period,
        limit_usd: target,
      });
      invalidateOrg(ctx); // budget changed → invalidate the org bundle (§2.12)
      return { budget_limit: target };
    },
  };

  const notify: EffectHandler<z.infer<typeof notifyParams>> = {
    params: notifyParams,
    auditAction: null,
    async apply(ctx, key, p) {
      await ctx.tx.execute(sql`
        insert into alert_events (org_id, alert_id, fired_at, dedupe_key, payload)
        values (${ctx.orgId}, ${p.channel_ref ?? null}, now(), ${'auto:' + key},
                ${jsonb(p.payload ?? {})})
        on conflict (alert_id, dedupe_key) do nothing`);
      return { notified: true };
    },
  };

  const require_approval: EffectHandler<z.infer<typeof requireApprovalParams>> = {
    params: requireApprovalParams,
    auditAction: 'approval.create',
    async apply(ctx, _key, p) {
      const scopeType = p.scope_type ?? null;
      const scopeId = p.scope_id ?? null;
      // Idempotent open: one approval per spawning event (§2.1.1 origin unique).
      const inserted = (await ctx.tx.execute(sql`
        insert into approval_requests
          (org_id, kind, requested_by, scope_type, scope_id, current_value, requested_value,
           amount_usd, origin_event_id)
        values (${ctx.orgId}, ${p.kind}, null, ${scopeType}, ${scopeId},
                ${jsonb(p.current_value ?? {})}, ${jsonb(p.requested_value ?? {})},
                ${p.amount_usd ?? null}, ${ctx.trigger_event_id ?? null})
        on conflict (origin_event_id) where origin_event_id is not null do nothing
        returning *`)) as unknown as ApprovalRequestRow[];
      const req = inserted[0];
      if (!req) {
        // Collision → the approval already exists (crash-retry / duplicate event): no-op.
        const ex = (await ctx.tx.execute(sql`
          select id from approval_requests where origin_event_id = ${ctx.trigger_event_id ?? null}`)) as unknown as {
          id: string;
        }[];
        return { approval_id: ex[0]?.id ?? null, deduped: true };
      }
      const rawPolicies = (await ctx.tx.execute(sql`
        select * from approval_policies where enabled`)) as unknown as ApprovalPolicyRow[];
      // jsonb `definition` arrives as a string via raw execute — coerce before materializeChain (B4).
      const policies = rawPolicies.map((pol) => ({
        ...pol,
        definition: asJson<ApprovalPolicyRow['definition']>(pol.definition),
      }));
      const policy = selectPolicy(policies, { kind: p.kind, scopeType, scopeId });
      if (!policy) {
        throw new SpillwayError('approval_chain_unsatisfiable', 'no approval policy selected', {
          httpStatus: 422,
        });
      }
      const members = await deps.membershipFor(ctx.orgId, ctx.tx);
      const { autoApproved } = await materializeChain(ctx.tx, req, policy, members, ctx.now);

      if (autoApproved) {
        // Auto-approve tier / all-steps-skipped chain: FINALIZE now — apply the pending effect and
        // mark the request approved. Without this the request sat pending with zero live steps, armed
        // an expiry, and was cancelled, so the budget/key was NEVER mutated (expanded-audit HIGH H7).
        // actor=system (no human decided); reuses the same handlers decide.ts:finalApply runs.
        const applyCtx: EffectContext = {
          ...ctx,
          actor: { type: 'system', id: null },
          source: 'approval',
        };
        const applyKey = `approval:${req.id}:apply`;
        const rv = p.requested_value ?? {};
        if (p.kind === 'budget_increase') {
          // Never silently zero a budget on a missing target (expanded-audit M38 — the old
          // `?? '0'` default set the cap to $0). Reject an unsatisfiable auto-approve instead.
          if (scopeType === null || scopeId === null || rv.new_limit_usd === undefined) {
            throw new SpillwayError(
              'approval_chain_unsatisfiable',
              'budget_increase auto-approve is missing scope_type/scope_id/new_limit_usd',
              { httpStatus: 422 },
            );
          }
          await apply_budget_increase.apply(applyCtx, applyKey, {
            scope_type: scopeType,
            scope_id: scopeId,
            period: typeof rv.period === 'string' ? rv.period : 'month',
            new_limit_usd: String(rv.new_limit_usd),
          });
        } else if (p.kind === 'key_unpause') {
          if (scopeId === null) {
            throw new SpillwayError(
              'approval_chain_unsatisfiable',
              'key_unpause auto-approve is missing scope_id',
              { httpStatus: 422 },
            );
          }
          await unpause_key.apply(applyCtx, applyKey, { virtual_key_id: scopeId });
        }
        await ctx.tx.execute(sql`
          update approval_requests set status = 'approved', decided_at = now() where id = ${req.id}`);
        await writeAudit(ctx, 'approval.create', 'approval_request', req.id, {
          ...baseMeta(ctx),
          auto_approved: true,
        });
        return { approval_id: req.id, auto_approved: true };
      }

      // Not auto-approved → arm the expiry timer (§2.11); neutralized on any terminal decision (§2.8).
      await ctx.tx.execute(sql`
        insert into workflow_timers (org_id, kind, ref_id, fire_at)
        select org_id, 'approval_expiry', id, expires_at from approval_requests where id = ${req.id}
        on conflict (ref_id, kind, fire_at) do nothing`);
      await writeAudit(ctx, 'approval.create', 'approval_request', req.id, baseMeta(ctx));
      return { approval_id: req.id };
    },
  };

  const create_alert: EffectHandler<z.infer<typeof createAlertParams>> = {
    params: createAlertParams,
    auditAction: null,
    async apply(ctx, key, p) {
      const dedupe = p.dedupe_key ?? 'alert:' + key;
      await ctx.tx.execute(sql`
        insert into alert_events (org_id, alert_id, fired_at, dedupe_key, payload)
        values (${ctx.orgId}, null, now(), ${dedupe}, ${jsonb({ kind: p.kind, ...(p.payload ?? {}) })})
        on conflict (alert_id, dedupe_key) do nothing`);
      return { alerted: true, dedupe_key: dedupe };
    },
  };

  const suspend: EffectHandler<z.infer<typeof suspendParams>> = {
    params: suspendParams,
    auditAction: 'virtual_key.pause',
    async apply(ctx, _key, p) {
      // PagerDuty suspend-with-cancel: pause now, arm an unpause timer at now+seconds (§3.4/§4).
      const flipped = await flipKey(ctx.tx, p.virtual_key_id, 'active', 'paused');
      const fireAt = new Date(ctx.now.getTime() + p.seconds * 1000);
      if (!flipped) {
        // This suspend did NOT pause the key — something else (a hard kill / admin / another
        // automation) already had it paused. The auto-resume must be attributable to THAT suspend
        // (§3.4): scheduling a resume for a pause we didn't cause would silently reactivate a killed
        // key. So arm NO timer and write NO pause audit — no-op.
        return { suspended_key: p.virtual_key_id, noop: true };
      }
      await writeAudit(ctx, 'virtual_key.pause', 'virtual_key', p.virtual_key_id, {
        ...baseMeta(ctx),
        source: 'automation:suspend',
      });
      invalidateKey(ctx, p.virtual_key_id); // suspend pauses now → cache must drop the key immediately
      // One pending suspend timer per key (§3.4): a re-suspend must NOT arm a second, shorter resume
      // that would defeat a longer pending suspend. Guarded insert — the base UNIQUE (ref_id, kind,
      // fire_at) can't express this (rule_schedule needs the fire_at series).
      await ctx.tx.execute(sql`
        insert into workflow_timers (org_id, kind, ref_id, fire_at)
        select ${ctx.orgId}, 'automation_suspend', ${p.virtual_key_id}, ${fireAt.toISOString()}
        where not exists (
          select 1 from workflow_timers
           where ref_id = ${p.virtual_key_id} and kind = 'automation_suspend' and fired_at is null
        )`);
      return { suspended_key: p.virtual_key_id, resume_at: fireAt.toISOString() };
    },
  };

  return {
    pause_key,
    unpause_key,
    tighten_budget,
    apply_budget_increase,
    notify,
    require_approval,
    create_alert,
    suspend,
  };
}

/** Look up, param-validate, and apply one effect (§3.3 step 5). */
export async function runEffect(
  registry: EffectRegistry,
  ctx: EffectContext,
  key: string,
  spec: { type: string } & Record<string, unknown>,
): Promise<EffectResult> {
  const handler = registry[spec.type];
  if (!handler) {
    throw new SpillwayError('unknown_effect', `no effect handler: ${spec.type}`, {
      httpStatus: 422,
    });
  }
  const params = handler.params.parse(spec) as unknown;
  return handler.apply(ctx, key, params);
}
