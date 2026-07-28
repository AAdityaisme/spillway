import { sql } from 'drizzle-orm';
import { SpillwayError } from '@spillway/shared';
import { parseUsd } from '@spillway/pricing';
import type { Tx } from '../../db/tenancy.js';
import { resolveDelegate, type ActiveDelegation } from './delegate.js';

/**
 * Chain freeze / materialization (Part II §18 §2.4) — the correctness heart of approvals.
 *
 * Runs inside the create transaction, after the `approval_requests` row exists and before commit.
 * Selects the amount tier, resolves role/user approver sets to concrete user ids, substitutes
 * delegates, excludes the requester (self-approval ban per step), checks quorum feasibility
 * (fail-closed 422 — a chain no one can satisfy is a policy misconfig surfaced at request time, NEVER
 * a silently-stuck approval), and writes the FROZEN `approval_steps`. Later policy/role/delegation
 * edits never mutate these rows (freeze-at-creation, §2.1.3 / ADR-039).
 */

// ── domain types (this module is the type hub for the vertical) ──────────────

export type QuorumSpec = 'all' | 'any' | number;

export interface Approvers {
  roles?: string[];
  user_ids?: string[];
}

export interface StepDef {
  approvers: Approvers;
  quorum: QuorumSpec;
  notify_only?: boolean;
}

export interface TierDef {
  min_amount_usd: string;
  auto_approve?: boolean;
  steps?: StepDef[];
}

export interface PolicyDefinition {
  tiers: TierDef[];
  expiry_hours?: number;
  reminders?: { after_hours: number }[];
  escalation?: { after_hours: number; to: Approvers };
}

export interface ApprovalPolicyRow {
  id: string;
  org_id: string;
  name: string;
  kind: string;
  scope_type: string | null;
  scope_id: string | null;
  definition: PolicyDefinition;
  version: number;
  enabled: boolean;
}

export interface ApprovalRequestRow {
  id: string;
  org_id: string;
  kind: string;
  requested_by: string | null;
  scope_type: string;
  scope_id: string;
  amount_usd: string | null;
  current_step_index: number;
  status: string;
  requested_value?: unknown;
}

export interface ApprovalStepRow {
  id: string;
  approval_id: string;
  step_index: number;
  quorum: string;
  required_approver_ids: string[];
  notify_only: boolean;
  status: string;
}

/**
 * Org membership snapshot. In V2 the role→user set is a SELECT on `org_members` under the org GUC and
 * the user-id verification is a cross-org FK re-check (§2.4 step 3.1, v2-code-seams F6). The caller
 * builds it from org_members; the freeze algorithm is identical either way.
 */
export interface Membership {
  /** User ids holding ANY of `roles`, within the request's org. */
  byRoles(roles: readonly string[]): readonly string[];
  /** Whether `userId` is a member of the request's org (drops a borrowed id). */
  isMember(userId: string): boolean;
}

// ── quorum helpers ───────────────────────────────────────────────────────────

/** Vote-count rule (§2.4). `all` = every resolved approver; `any` = 1; `N` = N distinct. */
export function quorumCount(quorum: QuorumSpec, setSize: number): number {
  if (quorum === 'all') return setSize;
  if (quorum === 'any') return 1;
  return Math.max(1, quorum); // integer N ≥ 1 (§2); feasibility (step 3.5) rejects N > setSize
}

/** Encode a quorum spec for the `text` column (`'all' | 'any' | 'N'`). */
export function encodeQuorum(q: QuorumSpec): string {
  return typeof q === 'number' ? String(q) : q;
}

/** Decode the `approval_steps.quorum` text back to a spec. */
export function decodeQuorum(s: string): QuorumSpec {
  if (s === 'all' || s === 'any') return s;
  return Number.parseInt(s, 10);
}

/** Select the highest tier whose `min_amount_usd <= amt` (bigint µUSD compare, never float). */
function selectTier(def: PolicyDefinition, amt: bigint): TierDef {
  let best: TierDef | undefined;
  let bestMin = 0n;
  for (const tier of def.tiers) {
    const min = parseUsd(tier.min_amount_usd);
    if (min > amt) continue; // min > amt → not eligible
    if (best === undefined || min > bestMin) {
      best = tier;
      bestMin = min;
    }
  }
  if (!best) {
    throw new SpillwayError('approval_chain_unsatisfiable', 'no tier matches amount', {
      httpStatus: 422,
    });
  }
  return best;
}

/** Resolve one step's frozen approver set (roles ∪ verified user_ids → delegates → −requester). */
function resolveStepApprovers(
  step: StepDef,
  req: ApprovalRequestRow,
  members: Membership,
  delegations: readonly ActiveDelegation[],
  now: Date,
): string[] {
  const seed = new Set<string>(members.byRoles(step.approvers.roles ?? []));
  for (const uid of step.approvers.user_ids ?? []) {
    if (members.isMember(uid)) seed.add(uid);
  }
  // Delegation substitution: each u is replaced by its effective delegate (§2.4 step 3.2).
  const mapped = new Set<string>();
  for (const u of seed) mapped.add(resolveDelegate(u, now, delegations));
  // Requester exclusion — also drops a delegate that resolved TO the requester (§2.4 step 3.3).
  if (req.requested_by !== null) mapped.delete(req.requested_by);
  return [...mapped].sort();
}

/**
 * Freeze the chain for `req` under `policy`. Inserts `approval_steps`, fast-forwards a leading
 * notify-only prefix, stamps `policy_id` / `policy_version` / `expires_at` / `current_step_index`.
 * Returns the frozen steps and whether the request is already fully satisfied (auto-approve tier, or
 * an all-notify chain) so the caller runs the final apply immediately (§2.4 steps 2/4, §2.8).
 */
export async function materializeChain(
  tx: Tx,
  req: ApprovalRequestRow,
  policy: ApprovalPolicyRow,
  members: Membership,
  now: Date,
): Promise<{ steps: ApprovalStepRow[]; autoApproved: boolean }> {
  const def = policy.definition;
  const amt = req.amount_usd === null ? 0n : parseUsd(req.amount_usd);
  const tier = selectTier(def, amt);

  const expiryHours = def.expiry_hours ?? 336;
  const expiresAt = new Date(now.getTime() + expiryHours * 3_600_000);

  // Auto-approve tier: zero steps, caller runs the final apply (§2.4 step 2).
  if (tier.auto_approve) {
    await tx.execute(sql`
      update approval_requests
         set policy_id = ${policy.id}, policy_version = ${policy.version},
             expires_at = ${expiresAt.toISOString()}, current_step_index = 0
       where id = ${req.id}`);
    return { steps: [], autoApproved: true };
  }

  const delegations = (await tx.execute(sql`
    select from_user, to_user, starts_at, ends_at
      from approver_delegations
     where starts_at <= ${now.toISOString()} and ${now.toISOString()} <= ends_at`)) as unknown as ActiveDelegation[];

  const tierSteps = tier.steps ?? [];
  const stepRows: ApprovalStepRow[] = [];
  for (let i = 0; i < tierSteps.length; i++) {
    const step = tierSteps[i]!;
    const ids = resolveStepApprovers(step, req, members, delegations, now);
    const required = quorumCount(step.quorum, ids.length);
    // notify_only steps are purely informational and never gate (they're marked 'skipped' below), so
    // an unresolvable notify_only tier (e.g. role 'security' with 0 members) must NOT fail the whole
    // chain — only GATING steps get the feasibility throw (expanded-audit M36).
    if (!(step.notify_only ?? false) && (ids.length === 0 || ids.length < required)) {
      throw new SpillwayError(
        'approval_chain_unsatisfiable',
        `step ${i} resolves to ${ids.length} approver(s) but needs ${required}`,
        { httpStatus: 422 },
      );
    }
    const rows = (await tx.execute(sql`
      insert into approval_steps
        (org_id, approval_id, step_index, quorum, required_approver_ids, notify_only, status)
      values
        (${req.org_id}, ${req.id}, ${i}, ${encodeQuorum(step.quorum)},
         ${sql`ARRAY[${sql.join(
           ids.map((id) => sql`${id}`),
           sql`, `,
         )}]::text[]`}, ${step.notify_only ?? false}, 'pending')
      returning *`)) as unknown as ApprovalStepRow[];
    stepRows.push(rows[0]!);
  }

  // Notify-only steps never gate (§2 field-semantics, §2.4 step 4): mark each 'skipped' at freeze so
  // the advance loop steps past them wherever they sit.
  for (const row of stepRows) {
    if (row.notify_only) {
      await tx.execute(sql`update approval_steps set status = 'skipped' where id = ${row.id}`);
      row.status = 'skipped';
    }
  }
  let idx = 0;
  while (idx < stepRows.length && stepRows[idx]!.status === 'skipped') idx++;
  const autoApproved = idx >= stepRows.length; // ran off the end → nothing left to gate
  const currentStepIndex = autoApproved ? stepRows.length : idx;

  await tx.execute(sql`
    update approval_requests
       set policy_id = ${policy.id}, policy_version = ${policy.version},
           expires_at = ${expiresAt.toISOString()}, current_step_index = ${currentStepIndex}
     where id = ${req.id}`);

  // Arm reminder / escalation timers from the policy definition (expanded-audit M37 — timers.ts has
  // live dispatch branches for both, but nothing ever seeded the rows, so the advertised
  // reminder/escalation fields were dead). Only for a live (non-satisfied) chain; a chain with nothing
  // left to gate needs no reminders. `on conflict do nothing` keeps re-freeze idempotent.
  if (!autoApproved) {
    await armReminders(tx, req, def, now);
    await armEscalation(tx, req, def, members, delegations, now);
  }

  return { steps: stepRows, autoApproved };
}

/** Seed one approval_reminder timer per configured offset (dispatched by the sweep, §4.2). */
async function armReminders(
  tx: Tx,
  req: ApprovalRequestRow,
  def: PolicyDefinition,
  now: Date,
): Promise<void> {
  for (const r of def.reminders ?? []) {
    const fireAt = new Date(now.getTime() + r.after_hours * 3_600_000);
    await tx.execute(sql`
      insert into workflow_timers (org_id, kind, ref_id, fire_at)
      values (${req.org_id}, 'approval_reminder', ${req.id}, ${fireAt.toISOString()})
      on conflict (ref_id, kind, fire_at) do nothing`);
  }
}

/**
 * Seed the escalation timer, resolving `escalation.to` to concrete add_ids AT ARM TIME (the sweep
 * widens the then-current step with payload.add_ids, additive-only §2.11). Resolving now keeps the
 * frozen-at-creation contract; a later membership/delegation edit never mutates a pending escalation.
 */
async function armEscalation(
  tx: Tx,
  req: ApprovalRequestRow,
  def: PolicyDefinition,
  members: Membership,
  delegations: readonly ActiveDelegation[],
  now: Date,
): Promise<void> {
  const esc = def.escalation;
  if (!esc) return;
  const addIds = resolveStepApprovers(
    { approvers: esc.to, quorum: 'any' },
    req,
    members,
    delegations,
    now,
  );
  if (addIds.length === 0) return; // nothing to widen to → no timer
  const fireAt = new Date(now.getTime() + esc.after_hours * 3_600_000);
  await tx.execute(sql`
    insert into workflow_timers (org_id, kind, ref_id, fire_at, payload)
    values (${req.org_id}, 'approval_escalation', ${req.id}, ${fireAt.toISOString()},
            ${sql`${JSON.stringify({ add_ids: addIds })}::jsonb`})
    on conflict (ref_id, kind, fire_at) do nothing`);
}
