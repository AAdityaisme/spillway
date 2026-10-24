import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { makeTestApp, type TestHarness } from '../../../test/helpers/app.js';
import { makeEffectRegistry } from '../effects/registry.js';
import { makeDecisionHandlers } from './decide.js';
import { buildMembership } from './membership.js';
import {
  materializeChain,
  type ApprovalPolicyRow,
  type ApprovalRequestRow,
} from './materialize.js';
import { withOrg } from '../../db/tenancy.js';

/**
 * Approvals decision-engine exit gate (Part II §18 §2.7/§2.8) — the money- and RBAC-critical core that
 * shipped with ZERO automated coverage (expanded-audit M39). Also pins the M36 (notify_only never
 * blocks), M37 (reminder/escalation timers actually armed), M38 (missing new_limit_usd never zeroes a
 * budget), and L35 (viewer is not an effective approver) fixes.
 */

let h: TestHarness;
const orgId = randomUUID();
let handlers: ReturnType<typeof makeDecisionHandlers>;

const reg = () => makeEffectRegistry({ membershipFor: (o, tx) => buildMembership(tx, o) });

/** Seed a policy and return its coerced row for materializeChain. */
async function seedPolicy(def: unknown, kind = 'budget_increase'): Promise<ApprovalPolicyRow> {
  const id = randomUUID();
  await h.adminSql`INSERT INTO approval_policies (id, org_id, name, kind, definition, version, enabled)
    VALUES (${id}, ${orgId}, 'p', ${kind}, ${JSON.stringify(def)}::jsonb, 1, true)`;
  return {
    id,
    org_id: orgId,
    name: 'p',
    kind,
    scope_type: null,
    scope_id: null,
    definition: def as ApprovalPolicyRow['definition'],
    version: 1,
    enabled: true,
  };
}

/** Open an approval_request and freeze its chain via materializeChain (the production path). */
async function openApproval(o: {
  policy: ApprovalPolicyRow;
  requestedBy: string | null;
  amountUsd?: string | null;
  requestedValue?: Record<string, unknown>;
  scopeType?: string;
  scopeId?: string;
}): Promise<{ id: string; autoApproved: boolean }> {
  const id = randomUUID();
  const scopeType = o.scopeType ?? 'org';
  const scopeId = o.scopeId ?? orgId;
  await h.adminSql`INSERT INTO approval_requests
    (id, org_id, kind, requested_by, scope_type, scope_id, current_value, requested_value, amount_usd,
     current_step_index, status)
    VALUES (${id}, ${orgId}, ${o.policy.kind}, ${o.requestedBy}, ${scopeType}, ${scopeId},
            '{}'::jsonb, ${JSON.stringify(o.requestedValue ?? {})}::jsonb, ${o.amountUsd ?? null}, 0,
            'pending')`;
  const req: ApprovalRequestRow = {
    id,
    org_id: orgId,
    kind: o.policy.kind,
    requested_by: o.requestedBy,
    scope_type: scopeType,
    scope_id: scopeId,
    amount_usd: o.amountUsd ?? null,
    current_step_index: 0,
    status: 'pending',
    requested_value: o.requestedValue ?? {},
  };
  const out = await withOrg(h.db, orgId, async (tx) => {
    const members = await buildMembership(tx, orgId);
    return materializeChain(tx, req, o.policy, members, new Date());
  });
  return { id, autoApproved: out.autoApproved };
}

beforeAll(async () => {
  h = await makeTestApp();
  await h.adminSql`INSERT INTO orgs (id, name, slug) VALUES (${orgId}, 'A', ${'a-' + orgId.slice(0, 8)})`;
  handlers = makeDecisionHandlers({ db: h.db, registry: reg() });
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.adminSql`TRUNCATE approval_requests, approval_steps, approval_decisions, approval_policies,
    approver_delegations, workflow_timers, audit_log, budgets, org_members, users CASCADE`;
  await h.adminSql`INSERT INTO users (id, email) VALUES
    ('u_req', 'req@t.dev'), ('u_a', 'a@t.dev'), ('u_b', 'b@t.dev'), ('u_view', 'v@t.dev')
    ON CONFLICT (id) DO NOTHING`;
  await h.adminSql`INSERT INTO org_members (org_id, user_id, role) VALUES
    (${orgId}, 'u_req', 'member'), (${orgId}, 'u_a', 'admin'), (${orgId}, 'u_b', 'admin'),
    (${orgId}, 'u_view', 'viewer')`;
});

describe('approvals decision engine (§2.7/§2.8, M39)', () => {
  it('single-step quorum:any → approve applies the budget increase and marks approved', async () => {
    const pol = await seedPolicy({
      tiers: [{ min_amount_usd: '0', steps: [{ approvers: { roles: ['admin'] }, quorum: 'any' }] }],
    });
    const { id } = await openApproval({
      policy: pol,
      requestedBy: 'u_req',
      amountUsd: '500',
      requestedValue: { new_limit_usd: '1000.000000', period: 'month' },
    });
    const outcome = await handlers.approveRequest(orgId, id, 'u_a', 'admin');
    expect(outcome).toBe('approved');
    const budget = await h.adminSql<{ limit_usd: string }[]>`
      SELECT limit_usd FROM budgets WHERE org_id = ${orgId} AND scope_type = 'org' AND period = 'month'`;
    expect(budget[0]!.limit_usd).toBe('1000.000000');
  });

  it('deny at step 0 is terminal and applies nothing', async () => {
    const pol = await seedPolicy({
      tiers: [{ min_amount_usd: '0', steps: [{ approvers: { roles: ['admin'] }, quorum: 'any' }] }],
    });
    const { id } = await openApproval({
      policy: pol,
      requestedBy: 'u_req',
      requestedValue: { new_limit_usd: '1000.000000' },
    });
    await handlers.denyRequest(orgId, id, 'u_a', 'admin');
    const req = await h.adminSql<{ status: string }[]>`
      SELECT status FROM approval_requests WHERE id = ${id}`;
    expect(req[0]!.status).toBe('denied');
    const budget = await h.adminSql`SELECT 1 FROM budgets WHERE org_id = ${orgId}`;
    expect(budget).toHaveLength(0);
  });

  it('self-approval is 403 and a non-approver is 403', async () => {
    // Both u_a and u_b are in the set so the chain is SATISFIABLE after u_a (the requester) is excluded
    // by the self-approval ban — otherwise the step would resolve to 0 approvers and never open.
    const pol = await seedPolicy({
      tiers: [
        {
          min_amount_usd: '0',
          steps: [{ approvers: { user_ids: ['u_a', 'u_b'] }, quorum: 'any' }],
        },
      ],
    });
    const { id } = await openApproval({ policy: pol, requestedBy: 'u_a' });
    // u_a is the requester → self-approval ban even though they're in the set.
    await expect(handlers.approveRequest(orgId, id, 'u_a', 'admin')).rejects.toMatchObject({
      httpStatus: 403,
    });
    // u_view is a member but NOT in this step's approver set → non-approver.
    await expect(handlers.approveRequest(orgId, id, 'u_view', 'viewer')).rejects.toMatchObject({
      httpStatus: 403,
    });
  });

  it('two-step quorum completes only after both steps and cross-step dedup auto-carries', async () => {
    const pol = await seedPolicy({
      tiers: [
        {
          min_amount_usd: '0',
          steps: [
            { approvers: { user_ids: ['u_a', 'u_b'] }, quorum: 'any' },
            { approvers: { user_ids: ['u_a'] }, quorum: 'any' },
          ],
        },
      ],
    });
    const { id } = await openApproval({
      policy: pol,
      requestedBy: 'u_req',
      requestedValue: { new_limit_usd: '2000.000000' },
    });
    // u_a satisfies step 0; the dedup carry auto-approves step 1 (u_a is required there too) → approved.
    const outcome = await handlers.approveRequest(orgId, id, 'u_a', 'admin');
    expect(outcome).toBe('approved');
  });

  it('cancel by a non-requester non-admin is 403; requester cancel succeeds', async () => {
    const pol = await seedPolicy({
      tiers: [{ min_amount_usd: '0', steps: [{ approvers: { roles: ['admin'] }, quorum: 'any' }] }],
    });
    const { id } = await openApproval({ policy: pol, requestedBy: 'u_req' });
    await expect(handlers.cancelRequest(orgId, id, 'u_a', { admin: false })).rejects.toMatchObject({
      httpStatus: 403,
    });
    await handlers.cancelRequest(orgId, id, 'u_req', { admin: false });
    const req = await h.adminSql<{ status: string }[]>`
      SELECT status FROM approval_requests WHERE id = ${id}`;
    expect(req[0]!.status).toBe('cancelled');
  });

  it('every decision writes an audit_log row (approvals audited end-to-end, 20 §4)', async () => {
    const pol = await seedPolicy({
      tiers: [{ min_amount_usd: '0', steps: [{ approvers: { roles: ['admin'] }, quorum: 'any' }] }],
    });
    const auditFor = (
      id: string,
    ): Promise<{ action: string; actor_id: string; actor_type: string }[]> =>
      h.adminSql`SELECT action, actor_id, actor_type FROM audit_log
                 WHERE org_id = ${orgId} AND target->>'id' = ${id} ORDER BY created_at`;

    const a = await openApproval({
      policy: pol,
      requestedBy: 'u_req',
      requestedValue: { new_limit_usd: '1000.000000', period: 'month' },
    });
    await handlers.approveRequest(orgId, a.id, 'u_a', 'admin');
    const approveRows = await auditFor(a.id);
    expect(approveRows.map((r) => r.action)).toContain('approval.approve');
    expect(approveRows.find((r) => r.action === 'approval.approve')!.actor_id).toBe('u_a');
    expect(approveRows.find((r) => r.action === 'approval.approve')!.actor_type).toBe('user');

    const d = await openApproval({ policy: pol, requestedBy: 'u_req' });
    await handlers.denyRequest(orgId, d.id, 'u_a', 'admin');
    expect((await auditFor(d.id)).map((r) => r.action)).toContain('approval.deny');

    const c = await openApproval({ policy: pol, requestedBy: 'u_req' });
    await handlers.cancelRequest(orgId, c.id, 'u_req', { admin: false });
    const cancelRows = await auditFor(c.id);
    expect(cancelRows.map((r) => r.action)).toContain('approval.cancel');
    expect(cancelRows.find((r) => r.action === 'approval.cancel')!.actor_id).toBe('u_req');
  });

  it('decision neutralizes a pending expiry timer', async () => {
    const pol = await seedPolicy({
      tiers: [{ min_amount_usd: '0', steps: [{ approvers: { roles: ['admin'] }, quorum: 'any' }] }],
    });
    const { id } = await openApproval({
      policy: pol,
      requestedBy: 'u_req',
      requestedValue: { new_limit_usd: '1000.000000' },
    });
    await h.adminSql`INSERT INTO workflow_timers (org_id, kind, ref_id, fire_at)
      VALUES (${orgId}, 'approval_expiry', ${id}, now() + interval '1 day')`;
    await handlers.approveRequest(orgId, id, 'u_a', 'admin');
    const live = await h.adminSql`
      SELECT 1 FROM workflow_timers WHERE ref_id = ${id} AND fired_at IS NULL`;
    expect(live).toHaveLength(0);
  });
});

describe('approvals — L35 viewer gate', () => {
  it('a viewer named in the approver set cannot approve a money move', async () => {
    const pol = await seedPolicy({
      tiers: [
        { min_amount_usd: '0', steps: [{ approvers: { user_ids: ['u_view'] }, quorum: 'any' }] },
      ],
    });
    const { id } = await openApproval({
      policy: pol,
      requestedBy: 'u_req',
      requestedValue: { new_limit_usd: '1000.000000' },
    });
    await expect(handlers.approveRequest(orgId, id, 'u_view', 'viewer')).rejects.toMatchObject({
      httpStatus: 403,
    });
    const budget = await h.adminSql`SELECT 1 FROM budgets WHERE org_id = ${orgId}`;
    expect(budget).toHaveLength(0);
  });
});

describe('approvals — M38 budget-zeroing guard', () => {
  it('final approval with a missing new_limit_usd is rejected (never zeroes the budget)', async () => {
    const pol = await seedPolicy({
      tiers: [{ min_amount_usd: '0', steps: [{ approvers: { roles: ['admin'] }, quorum: 'any' }] }],
    });
    const { id } = await openApproval({
      policy: pol,
      requestedBy: 'u_req',
      requestedValue: {}, // new_limit_usd omitted (misconfig)
    });
    await expect(handlers.approveRequest(orgId, id, 'u_a', 'admin')).rejects.toMatchObject({
      httpStatus: 422,
    });
    // Tx rolled back: NO $0 budget row was written, request stays pending.
    const budget = await h.adminSql`SELECT 1 FROM budgets WHERE org_id = ${orgId}`;
    expect(budget).toHaveLength(0);
    const req = await h.adminSql<{ status: string }[]>`
      SELECT status FROM approval_requests WHERE id = ${id}`;
    expect(req[0]!.status).toBe('pending');
  });
});

describe('approvals — M36 notify_only never blocks freeze', () => {
  it('an unresolvable notify_only step (0 members) does not fail chain creation', async () => {
    // 'security' role has 0 members; the notify_only step must NOT throw 422 at freeze.
    const pol = await seedPolicy({
      tiers: [
        {
          min_amount_usd: '0',
          steps: [
            { approvers: { roles: ['security'] }, quorum: 'any', notify_only: true },
            { approvers: { roles: ['admin'] }, quorum: 'any' },
          ],
        },
      ],
    });
    const { id, autoApproved } = await openApproval({
      policy: pol,
      requestedBy: 'u_req',
      requestedValue: { new_limit_usd: '1000.000000' },
    });
    expect(autoApproved).toBe(false);
    const steps = await h.adminSql<{ status: string; notify_only: boolean }[]>`
      SELECT status, notify_only FROM approval_steps WHERE approval_id = ${id} ORDER BY step_index`;
    expect(steps[0]!.notify_only).toBe(true);
    expect(steps[0]!.status).toBe('skipped'); // marked skipped, not blocking
    // The gating admin step still works.
    const outcome = await handlers.approveRequest(orgId, id, 'u_a', 'admin');
    expect(outcome).toBe('approved');
  });
});

describe('approvals — M37 reminder/escalation timers are armed', () => {
  it('materializeChain seeds reminder and escalation timers from the policy definition', async () => {
    const pol = await seedPolicy({
      tiers: [
        { min_amount_usd: '0', steps: [{ approvers: { user_ids: ['u_a'] }, quorum: 'any' }] },
      ],
      reminders: [{ after_hours: 24 }],
      escalation: { after_hours: 48, to: { roles: ['admin'] } },
    });
    const { id } = await openApproval({
      policy: pol,
      requestedBy: 'u_req',
      requestedValue: { new_limit_usd: '1000.000000' },
    });
    const reminder = await h.adminSql`
      SELECT 1 FROM workflow_timers WHERE ref_id = ${id} AND kind = 'approval_reminder'`;
    expect(reminder).toHaveLength(1);
    const esc = await h.adminSql<{ payload: { add_ids: string[] } }[]>`
      SELECT payload FROM workflow_timers WHERE ref_id = ${id} AND kind = 'approval_escalation'`;
    expect(esc).toHaveLength(1);
    // escalation.to resolves admins (u_a, u_b) minus the requester → both present.
    expect(esc[0]!.payload.add_ids.sort()).toEqual(['u_a', 'u_b']);
  });
});

describe('approvals — F2 delegation substitution against the real driver', () => {
  /**
   * Red-team F2. Delegation was covered ONLY by a pure unit test that hands `resolveDelegate` real
   * `Date` objects, and chain creation was covered only with an EMPTY delegations table — so the
   * two features were never exercised together and the gap between them was invisible.
   *
   * The gap: materializeChain reads `approver_delegations` through a raw `tx.execute`, and
   * postgres-js hands raw results back unparsed, so `starts_at` arrives as the STRING
   * '2026-08-09 01:32:59.471707+00'. The row type declared `Date`, the `as unknown as` cast made
   * TypeScript believe it, and `.getTime()` threw a TypeError. One active delegation row therefore
   * broke ALL approval creation with a 500 — org-wide, for a feature the delegated user never
   * touched. Fails closed, but a headline governance feature is inoperative.
   *
   * Seeding a delegation and materializing a chain is the whole repro: this test throws
   * "d.starts_at.getTime is not a function" against the pre-fix delegate.ts.
   */
  async function seedDelegation(from: string, to: string, startsAt: string, endsAt: string) {
    await h.adminSql`INSERT INTO approver_delegations (org_id, from_user, to_user, starts_at, ends_at)
      VALUES (${orgId}, ${from}, ${to}, ${startsAt}::timestamptz, ${endsAt}::timestamptz)`;
  }

  it('an ACTIVE delegation substitutes the delegate instead of 500ing chain creation', async () => {
    await seedDelegation('u_a', 'u_b', '2020-01-01T00:00:00Z', '2999-01-01T00:00:00Z');
    const pol = await seedPolicy({
      tiers: [
        { min_amount_usd: '0', steps: [{ approvers: { user_ids: ['u_a'] }, quorum: 'any' }] },
      ],
    });
    const { id } = await openApproval({
      policy: pol,
      requestedBy: 'u_req',
      requestedValue: { new_limit_usd: '1000.000000' },
    });
    const steps = await h.adminSql<{ required_approver_ids: string[] }[]>`
      SELECT required_approver_ids FROM approval_steps WHERE approval_id = ${id}`;
    expect(steps).toHaveLength(1);
    // u_a delegated to u_b, so the frozen step names u_b — proving the string timestamps were
    // compared, not merely tolerated.
    expect(steps[0]!.required_approver_ids).toEqual(['u_b']);
    // And the substitution is real end to end: the delegate can actually decide.
    expect(await handlers.approveRequest(orgId, id, 'u_b', 'admin')).toBe('approved');
  });

  it('a delegation OUTSIDE its window is ignored, not applied', async () => {
    await seedDelegation('u_a', 'u_b', '2020-01-01T00:00:00Z', '2020-06-01T00:00:00Z');
    const pol = await seedPolicy({
      tiers: [
        { min_amount_usd: '0', steps: [{ approvers: { user_ids: ['u_a'] }, quorum: 'any' }] },
      ],
    });
    const { id } = await openApproval({
      policy: pol,
      requestedBy: 'u_req',
      requestedValue: { new_limit_usd: '1000.000000' },
    });
    const steps = await h.adminSql<{ required_approver_ids: string[] }[]>`
      SELECT required_approver_ids FROM approval_steps WHERE approval_id = ${id}`;
    // Note what this does and does not prove: materialize.ts's SELECT already filters the window
    // server-side, so an expired delegation never reaches delegate.ts at all — which is exactly why
    // this case passed even BEFORE the fix, while the active-window case above threw. It is pinned
    // because the in-code window check is a redundant second gate that must agree with the SQL one,
    // not because it demonstrates the coercion.
    expect(steps[0]!.required_approver_ids).toEqual(['u_a']);
  });

  it('a CHAINED delegation (A→B→C) resolves to the terminus across the driver boundary', async () => {
    await h.adminSql`INSERT INTO users (id, email) VALUES ('u_c', 'c@t.dev')
      ON CONFLICT (id) DO NOTHING`;
    await h.adminSql`INSERT INTO org_members (org_id, user_id, role) VALUES (${orgId}, 'u_c', 'admin')`;
    await seedDelegation('u_a', 'u_b', '2020-01-01T00:00:00Z', '2999-01-01T00:00:00Z');
    await seedDelegation('u_b', 'u_c', '2020-01-01T00:00:00Z', '2999-01-01T00:00:00Z');
    const pol = await seedPolicy({
      tiers: [
        { min_amount_usd: '0', steps: [{ approvers: { user_ids: ['u_a'] }, quorum: 'any' }] },
      ],
    });
    const { id } = await openApproval({
      policy: pol,
      requestedBy: 'u_req',
      requestedValue: { new_limit_usd: '1000.000000' },
    });
    const steps = await h.adminSql<{ required_approver_ids: string[] }[]>`
      SELECT required_approver_ids FROM approval_steps WHERE approval_id = ${id}`;
    expect(steps[0]!.required_approver_ids).toEqual(['u_c']);
  });
});
