import { sql } from 'drizzle-orm';
import { SpillwayError } from '@spillway/shared';
import { withOrg } from '../../db/tenancy.js';
import type { DatabaseClient } from '../../db/client.js';
import { runEffect, type EffectRegistry, type EffectContext } from '../effects/registry.js';
import { appendAudit } from '../audit.js';
import { selectPolicy } from './policy-select.js';
import {
  materializeChain,
  type ApprovalRequestRow,
  type ApprovalPolicyRow,
} from './materialize.js';
import { buildMembership } from './membership.js';

/**
 * Human-initiated approval creation (18 §2.3/§2.14) — the approval "front door". A member/admin/owner
 * requests a `budget_increase` or `key_unpause`; the handler selects the org policy (§2.1.2 — the
 * seeded org default always matches), freezes the chain in the SAME tx as the insert (§2.4), arms the
 * expiry timer (§2.11), and audits `approval.create`. `requested_by` is the authenticated user (never
 * the body). An auto-approve tier applies the effect immediately through the shared registry — the same
 * apply path automation uses — so a one-shot policy behaves identically whoever opened the request.
 */

const jsonb = (v: unknown) => sql`${JSON.stringify(v)}::jsonb`;
const asJson = <T>(v: unknown): T => (typeof v === 'string' ? JSON.parse(v) : v) as T;

export interface CreateApprovalDeps {
  db: DatabaseClient;
  registry: EffectRegistry;
}

export interface CreateApprovalInput {
  orgId: string;
  userId: string;
  kind: 'budget_increase' | 'key_unpause';
  scopeType: string;
  scopeId: string;
  currentValue?: Record<string, unknown>;
  requestedValue: Record<string, unknown>;
  now: Date;
}

export async function createApprovalRequest(
  deps: CreateApprovalDeps,
  input: CreateApprovalInput,
): Promise<{ id: string; status: 'pending' | 'approved' }> {
  const { db, registry } = deps;
  const { orgId, userId, kind, scopeType, scopeId, currentValue, requestedValue, now } = input;
  // amount_usd is the tier-routing key for budget_increase (= the requested new limit); NULL otherwise.
  const amountUsd =
    kind === 'budget_increase' && typeof requestedValue.new_limit_usd === 'string'
      ? requestedValue.new_limit_usd
      : null;

  return withOrg(db, orgId, async (tx) => {
    const inserted = (await tx.execute(sql`
      insert into approval_requests
        (org_id, kind, requested_by, scope_type, scope_id, current_value, requested_value, amount_usd)
      values (${orgId}, ${kind}, ${userId}, ${scopeType}, ${scopeId},
              ${jsonb(currentValue ?? {})}, ${jsonb(requestedValue)}, ${amountUsd})
      returning *`)) as unknown as ApprovalRequestRow[];
    const req = inserted[0]!;

    const rawPolicies = (await tx.execute(sql`
      select * from approval_policies where enabled`)) as unknown as ApprovalPolicyRow[];
    const policies = rawPolicies.map((p) => ({
      ...p,
      definition: asJson<ApprovalPolicyRow['definition']>(p.definition),
    }));
    const policy = selectPolicy(policies, { kind, scopeType, scopeId });
    if (!policy) {
      // The seeded org default (§2.10) always matches, so this only fires if it was deleted.
      throw new SpillwayError('approval_chain_unsatisfiable', 'no approval policy selected', {
        httpStatus: 422,
      });
    }

    const members = await buildMembership(tx, orgId);
    const { autoApproved } = await materializeChain(tx, req, policy, members, now);
    const actor = { orgId, actorType: 'user' as const, actorId: userId };

    if (autoApproved) {
      // Auto-approve tier: apply the effect NOW via the shared registry (actor=user), mark approved.
      const applyCtx: EffectContext = {
        tx,
        orgId,
        actor: { type: 'user', id: userId },
        source: 'approval',
        now,
      };
      const key = `approval:${req.id}:apply`;
      if (kind === 'budget_increase') {
        if (typeof requestedValue.new_limit_usd !== 'string') {
          throw new SpillwayError(
            'approval_chain_unsatisfiable',
            'budget_increase requires requested_value.new_limit_usd',
            { httpStatus: 422 },
          );
        }
        await runEffect(registry, applyCtx, key, {
          type: 'apply_budget_increase',
          scope_type: scopeType,
          scope_id: scopeId,
          period: typeof requestedValue.period === 'string' ? requestedValue.period : 'month',
          new_limit_usd: requestedValue.new_limit_usd,
        });
      } else {
        await runEffect(registry, applyCtx, key, { type: 'unpause_key', virtual_key_id: scopeId });
      }
      await tx.execute(sql`
        update approval_requests set status = 'approved', decided_at = now() where id = ${req.id}`);
      await appendAudit(
        tx,
        {
          action: 'approval.create',
          target: { type: 'approval_request', id: req.id },
          meta: { kind, auto_approved: true },
        },
        actor,
      );
      return { id: req.id, status: 'approved' as const };
    }

    // Not auto-approved → arm the expiry timer (§2.11; expires_at set by materializeChain) + audit.
    await tx.execute(sql`
      insert into workflow_timers (org_id, kind, ref_id, fire_at)
      select org_id, 'approval_expiry', id, expires_at from approval_requests where id = ${req.id}
      on conflict (ref_id, kind, fire_at) do nothing`);
    await appendAudit(
      tx,
      {
        action: 'approval.create',
        target: { type: 'approval_request', id: req.id },
        meta: { kind },
      },
      actor,
    );
    return { id: req.id, status: 'pending' as const };
  });
}
