import { sql } from 'drizzle-orm';
import { SpillwayError, internalBus } from '@spillway/shared';
import { withOrg, type Tx } from '../../db/tenancy.js';
import type { DatabaseClient } from '../../db/client.js';
import { runEffect, type EffectContext, type EffectRegistry } from '../effects/registry.js';
import { appendAudit } from '../audit.js';
import { advance } from './advance.js';
import type { ApprovalRequestRow, ApprovalStepRow } from './materialize.js';

/**
 * Decision handlers — approve / deny / cancel (Part II §18 §2.8). Lock-and-validate + single-tx
 * discipline. On final approval the change is applied through the shared EFFECT REGISTRY (§18 §3.4) so
 * approvals and automation share ONE apply path (actor=user, source=approval here vs system/automation
 * on the poller). Deny is terminal at any step (deny-overrides, ADR-034) and applies nothing.
 */

/** Raw tx.execute returns jsonb columns as STRINGS — coerce back (cf. B4). */
function asJson<T>(v: unknown): T {
  return (typeof v === 'string' ? JSON.parse(v) : v) as T;
}

export interface DecideDeps {
  db: DatabaseClient;
  registry: EffectRegistry;
  /** Post-commit notification outbox (§2.13). Wired with the delivery job (B7.4). */
  enqueueNotification?: (approvalId: string, event: string) => void;
}

/** Role of the deciding user in the org — a viewer is never an effective approver (L35). */
export type VoterRole = string;

export interface DecisionHandlers {
  approveRequest(
    orgId: string,
    approvalId: string,
    decidedBy: string,
    role: VoterRole,
    comment?: string,
  ): Promise<'pending' | 'approved' | 'denied'>;
  denyRequest(
    orgId: string,
    approvalId: string,
    decidedBy: string,
    role: VoterRole,
    comment?: string,
  ): Promise<void>;
  cancelRequest(
    orgId: string,
    approvalId: string,
    actorId: string,
    opts?: { admin?: boolean; comment?: string },
  ): Promise<void>;
}

async function lockPending(tx: Tx, approvalId: string): Promise<ApprovalRequestRow> {
  const rows = (await tx.execute(sql`
    select * from approval_requests where id = ${approvalId} for update`)) as unknown as ApprovalRequestRow[];
  const approval = rows[0];
  if (!approval || approval.status !== 'pending') {
    throw new SpillwayError('not_pending', 'approval is not pending', { httpStatus: 409 });
  }
  return approval;
}

async function loadStep(tx: Tx, approvalId: string, index: number): Promise<ApprovalStepRow> {
  const rows = (await tx.execute(sql`
    select * from approval_steps where approval_id = ${approvalId} and step_index = ${index}`)) as unknown as ApprovalStepRow[];
  const step = rows[0];
  if (!step) throw new SpillwayError('conflict', 'current step missing', { httpStatus: 409 });
  return step;
}

/** Per-step authz + self-approval ban (§2.8 / §2.9). Applies to owners too. */
function assertCanVote(
  approval: ApprovalRequestRow,
  step: ApprovalStepRow,
  decidedBy: string,
  role: VoterRole,
): void {
  // A viewer is read-only everywhere else (requireRole); being named in a frozen approver set must not
  // make one an effective approver of a money move (expanded-audit L35). Reject BEFORE the set check so
  // a viewer never learns whether they're in the set.
  if (role === 'viewer') {
    throw new SpillwayError('forbidden', 'viewers cannot vote on approvals', { httpStatus: 403 });
  }
  if (approval.requested_by === decidedBy) {
    throw new SpillwayError('self_approval_not_allowed', 'requester cannot self-approve', {
      httpStatus: 403,
    });
  }
  if (!step.required_approver_ids.includes(decidedBy)) {
    throw new SpillwayError('not_an_approver', 'not in this step approver set', {
      httpStatus: 403,
    });
  }
}

/** Pending timers for a decided request never fire (§2.11 neutralize-on-terminal). */
async function neutralizeTimers(tx: Tx, approvalId: string): Promise<void> {
  await tx.execute(sql`
    delete from workflow_timers where ref_id = ${approvalId} and fired_at is null`);
}

/** Final apply for an approved request via the shared registry (§2.8), actor=user / source=approval. */
async function finalApply(
  tx: Tx,
  registry: EffectRegistry,
  approval: ApprovalRequestRow,
  decidedBy: string,
): Promise<void> {
  const ctx: EffectContext = {
    tx,
    orgId: approval.org_id,
    actor: { type: 'user', id: decidedBy },
    source: 'approval',
    now: new Date(),
  };
  const key = `approval:${approval.id}:apply`;
  if (approval.kind === 'budget_increase') {
    const rv = asJson<Record<string, unknown>>(approval.requested_value ?? {});
    // Never silently zero a budget on a missing target (expanded-audit M38 — the old `?? '0'` default
    // set limit_usd to $0, throttling all spend for the scope). A malformed request is a policy/authoring
    // bug: fail the apply (rolls back the tx, request stays pending) rather than coercing to zero.
    if (typeof rv.new_limit_usd !== 'string' || !/^\d+(\.\d{1,6})?$/.test(rv.new_limit_usd)) {
      throw new SpillwayError(
        'approval_chain_unsatisfiable',
        'budget_increase requested_value.new_limit_usd is missing or malformed',
        { httpStatus: 422 },
      );
    }
    await runEffect(registry, ctx, key, {
      type: 'apply_budget_increase',
      scope_type: approval.scope_type,
      scope_id: approval.scope_id,
      period: typeof rv.period === 'string' ? rv.period : 'month',
      new_limit_usd: rv.new_limit_usd,
    });
  } else if (approval.kind === 'key_unpause') {
    await runEffect(registry, ctx, key, { type: 'unpause_key', virtual_key_id: approval.scope_id });
  }
}

export function makeDecisionHandlers(deps: DecideDeps): DecisionHandlers {
  const { db, registry } = deps;

  async function approveRequest(
    orgId: string,
    approvalId: string,
    decidedBy: string,
    role: VoterRole,
    comment?: string,
  ): Promise<'pending' | 'approved' | 'denied'> {
    const { outcome, orgOut, stepAdvanced } = await withOrg(db, orgId, async (tx) => {
      const approval = await lockPending(tx, approvalId);
      const step = await loadStep(tx, approvalId, approval.current_step_index);
      assertCanVote(approval, step, decidedBy, role);

      await tx.execute(sql`
        insert into approval_decisions
          (org_id, approval_id, step_index, decided_by, decision, comment, source)
        values (${approval.org_id}, ${approvalId}, ${step.step_index}, ${decidedBy},
                'approve', ${comment ?? null}, 'human')
        on conflict (approval_id, step_index, decided_by) do nothing`);

      const before = approval.current_step_index;
      const result = await advance(tx, approval);

      if (result === 'approved') {
        await finalApply(tx, registry, approval, decidedBy);
        await tx.execute(sql`
          update approval_requests
             set status = 'approved', decided_by = ${decidedBy}, decided_at = now(),
                 decision_comment = ${comment ?? null}
           where id = ${approvalId}`);
        await neutralizeTimers(tx, approvalId);
      } else if (result === 'denied') {
        await tx.execute(sql`
          update approval_requests
             set status = 'denied', decided_by = ${decidedBy}, decided_at = now(),
                 decision_comment = ${comment ?? null}
           where id = ${approvalId}`);
        await neutralizeTimers(tx, approvalId);
      } else {
        await tx.execute(sql`
          update approval_requests set current_step_index = ${approval.current_step_index}
           where id = ${approvalId}`);
      }
      // Audit the vote + terminal outcome (20 §4; ch18 §2.8). Same tx as the decision so the trail
      // can't diverge from the state change; actor comes from the request's orgContext.
      const actor = {
        orgId: approval.org_id,
        actorType: 'user' as const,
        actorId: decidedBy,
        actorRole: role,
      };
      await appendAudit(
        tx,
        {
          action: 'approval.approve',
          target: { type: 'approval_request', id: approvalId },
          meta: {
            kind: approval.kind,
            step_index: step.step_index,
            outcome: result,
            ...(comment ? { comment } : {}),
          },
        },
        actor,
      );
      if (result === 'pending' && approval.current_step_index > before) {
        await appendAudit(
          tx,
          {
            action: 'approval.step_advance',
            target: { type: 'approval_request', id: approvalId },
            meta: { from_step: before, to_step: approval.current_step_index },
          },
          actor,
        );
      }
      return {
        outcome: result,
        orgOut: approval.org_id,
        stepAdvanced: approval.current_step_index > before,
      };
    });

    // Post-commit side effects (ADR-038 §2.12, §2.13).
    if (outcome === 'approved') {
      internalBus.emit('org:mutated', { orgId: orgOut });
      deps.enqueueNotification?.(approvalId, 'approved');
    } else if (outcome === 'denied') deps.enqueueNotification?.(approvalId, 'denied');
    else if (stepAdvanced) deps.enqueueNotification?.(approvalId, 'step_advanced');
    return outcome;
  }

  async function denyRequest(
    orgId: string,
    approvalId: string,
    decidedBy: string,
    role: VoterRole,
    comment?: string,
  ): Promise<void> {
    await withOrg(db, orgId, async (tx) => {
      const approval = await lockPending(tx, approvalId);
      const step = await loadStep(tx, approvalId, approval.current_step_index);
      assertCanVote(approval, step, decidedBy, role);

      await tx.execute(sql`
        insert into approval_decisions
          (org_id, approval_id, step_index, decided_by, decision, comment, source)
        values (${approval.org_id}, ${approvalId}, ${step.step_index}, ${decidedBy},
                'deny', ${comment ?? null}, 'human')
        on conflict (approval_id, step_index, decided_by) do nothing`);

      // advance short-circuits to 'denied'; no final apply is ever run.
      await advance(tx, approval);
      await tx.execute(sql`
        update approval_requests
           set status = 'denied', decided_by = ${decidedBy}, decided_at = now(),
               decision_comment = ${comment ?? null}
         where id = ${approvalId}`);
      await neutralizeTimers(tx, approvalId);
      await appendAudit(
        tx,
        {
          action: 'approval.deny',
          target: { type: 'approval_request', id: approvalId },
          meta: {
            kind: approval.kind,
            step_index: step.step_index,
            ...(comment ? { comment } : {}),
          },
        },
        { orgId: approval.org_id, actorType: 'user', actorId: decidedBy, actorRole: role },
      );
    });
    deps.enqueueNotification?.(approvalId, 'denied');
  }

  async function cancelRequest(
    orgId: string,
    approvalId: string,
    actorId: string,
    opts?: { admin?: boolean; comment?: string },
  ): Promise<void> {
    await withOrg(db, orgId, async (tx) => {
      const approval = await lockPending(tx, approvalId);
      if (approval.requested_by !== actorId && !opts?.admin) {
        throw new SpillwayError('forbidden', 'only requester or admin may cancel', {
          httpStatus: 403,
        });
      }
      await tx.execute(sql`
        update approval_requests
           set status = 'cancelled', decided_by = ${actorId}, decided_at = now(),
               decision_comment = ${opts?.comment ?? null}
         where id = ${approvalId}`);
      await neutralizeTimers(tx, approvalId);
      await appendAudit(
        tx,
        {
          action: 'approval.cancel',
          target: { type: 'approval_request', id: approvalId },
          meta: {
            by: opts?.admin ? 'admin' : 'requester',
            ...(opts?.comment ? { comment: opts.comment } : {}),
          },
        },
        { orgId: approval.org_id, actorType: 'user', actorId: actorId },
      );
    });
    deps.enqueueNotification?.(approvalId, 'cancelled');
  }

  return { approveRequest, denyRequest, cancelRequest };
}
