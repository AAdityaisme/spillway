import { sql } from 'drizzle-orm';
import type { Tx } from '../../db/tenancy.js';
import {
  decodeQuorum,
  quorumCount,
  type ApprovalRequestRow,
  type ApprovalStepRow,
} from './materialize.js';

/**
 * Quorum evaluation & step advancement (Part II §18 §2.7). Called by the decision handler after a vote
 * is inserted. Mutates `approval.current_step_index` in memory (the caller persists it) and writes
 * step-status + cross-step de-dup carries. Returns the request's outcome.
 */

/** Distinct approvers who cast `approve` at `stepIndex`. */
async function approverSet(tx: Tx, approvalId: string, stepIndex: number): Promise<string[]> {
  const rows = (await tx.execute(sql`
    select distinct decided_by from approval_decisions
     where approval_id = ${approvalId} and step_index = ${stepIndex} and decision = 'approve'`)) as unknown as {
    decided_by: string;
  }[];
  return rows.map((r) => r.decided_by);
}

/** Whether a `deny` vote exists at `stepIndex` (deny-overrides / short-circuit). */
async function hasDeny(tx: Tx, approvalId: string, stepIndex: number): Promise<boolean> {
  const rows = (await tx.execute(sql`
    select 1 from approval_decisions
     where approval_id = ${approvalId} and step_index = ${stepIndex} and decision = 'deny'
     limit 1`)) as unknown as unknown[];
  return rows.length > 0;
}

/** True iff `step`'s quorum is met by the currently-recorded approves. */
async function isSatisfied(tx: Tx, approvalId: string, step: ApprovalStepRow): Promise<boolean> {
  const approves = await approverSet(tx, approvalId, step.step_index);
  const required = quorumCount(decodeQuorum(step.quorum), step.required_approver_ids.length);
  return approves.length >= required;
}

export async function advance(
  tx: Tx,
  approval: ApprovalRequestRow,
): Promise<'pending' | 'approved' | 'denied'> {
  const steps = (await tx.execute(sql`
    select * from approval_steps where approval_id = ${approval.id} order by step_index`)) as unknown as ApprovalStepRow[];

  const k = approval.current_step_index;
  const step = steps[k];
  if (!step) return 'pending'; // defensive: no current step to evaluate

  // 2. Deny short-circuit — a single deny at the current step is terminal.
  if (await hasDeny(tx, approval.id, k)) return 'denied';

  // 3–5. Current step not yet satisfied → still gathering votes.
  if (!(await isSatisfied(tx, approval.id, step))) return 'pending';

  // 6. Step satisfied.
  await tx.execute(sql`
    update approval_steps set status = 'satisfied', satisfied_at = now() where id = ${step.id}`);

  // 7. Cross-step de-dup auto-carry: an approver of step k who is also required in a later step votes
  //    there once, automatically (Ramp semantics, source='dedup').
  const satisfiers = await approverSet(tx, approval.id, k);
  for (let m = k + 1; m < steps.length; m++) {
    const later = steps[m]!;
    for (const u of satisfiers) {
      if (!later.required_approver_ids.includes(u)) continue;
      await tx.execute(sql`
        insert into approval_decisions
          (org_id, approval_id, step_index, decided_by, decision, source)
        values (${approval.org_id}, ${approval.id}, ${m}, ${u}, 'approve', 'dedup')
        on conflict (approval_id, step_index, decided_by) do nothing`);
    }
  }

  // 8. Advance loop — skip notify-only (`skipped`) steps and any already auto-satisfied step.
  let j = k + 1;
  while (j < steps.length) {
    const next = steps[j]!;
    if (next.status === 'skipped') {
      j++;
      continue;
    }
    if (await isSatisfied(tx, approval.id, next)) {
      await tx.execute(sql`
        update approval_steps set status = 'satisfied', satisfied_at = now() where id = ${next.id}`);
      j++;
      continue;
    }
    break; // this is the new current step
  }
  approval.current_step_index = Math.min(j, steps.length);

  // 9. All steps satisfied → approved; else the request waits on the new current step.
  return approval.current_step_index >= steps.length ? 'approved' : 'pending';
}
