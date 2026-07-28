import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { makeTestApp, type TestHarness } from '../../../test/helpers/app.js';
import { makeEffectRegistry, type EffectRegistry } from '../effects/registry.js';
import { runAutomationPoller } from './poller.js';
import { sweepTimers } from './timers.js';
import { buildMembership } from '../approvals/membership.js';
import type { Membership } from '../approvals/materialize.js';

/**
 * B7.2 automation engine exit gate (Part II §18 §3.3 / §4.2): the poller matches alert_events → applies
 * effects (idempotent under re-scan), writes a no-match sentinel, honors notify-only, and the timer
 * sweep resumes a suspended key. Cross-org SCAN as spillway_jobs, per-event APPLY under withOrg.
 */

let h: TestHarness;
const orgId = randomUUID();
let vkId: string;
let registry: EffectRegistry;
const noMembers: Membership = { byRoles: () => [], isMember: () => false };

async function addRule(o: {
  action: Record<string, unknown>;
  condition?: Record<string, unknown>;
  state?: string;
  priority?: number;
  rate?: number;
  stopOnMatch?: boolean;
}): Promise<string> {
  const id = randomUUID();
  await h.adminSql`INSERT INTO automation_rules
    (id, org_id, name, trigger_type, condition, action, state, priority, rate_cap_per_hour, stop_on_match)
    VALUES (${id}, ${orgId}, ${'r-' + id.slice(0, 6)}, 'alert_fired',
            ${JSON.stringify(o.condition ?? {})}::jsonb, ${JSON.stringify(o.action)}::jsonb,
            ${o.state ?? 'active'}, ${o.priority ?? 100}, ${o.rate ?? 100}, ${o.stopOnMatch ?? true})`;
  return id;
}
async function fireEvent(payload: Record<string, unknown>): Promise<string> {
  const id = randomUUID();
  await h.adminSql`INSERT INTO alert_events (id, org_id, alert_id, fired_at, dedupe_key, payload)
    VALUES (${id}, ${orgId}, null, now(), ${'k:' + id}, ${JSON.stringify(payload)}::jsonb)`;
  return id;
}
const poll = () => runAutomationPoller({ jobsDb: h.jobsDb, db: h.db, registry });

beforeAll(async () => {
  h = await makeTestApp();
  registry = makeEffectRegistry({ membershipFor: () => noMembers });
  await h.adminSql`INSERT INTO orgs (id, name, slug) VALUES (${orgId}, 'A', ${'a-' + orgId.slice(0, 8)})`;
  vkId = randomUUID();
  await h.adminSql`INSERT INTO virtual_keys (id, org_id, name, key_hash, key_prefix, status)
            VALUES (${vkId}, ${orgId}, 'k', ${Buffer.from(vkId)}, 'mk-a', 'active')`;
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.adminSql`TRUNCATE automation_rules, automation_runs, alert_events, workflow_timers, audit_log,
    approval_requests, approval_steps, approval_policies, org_members`;
  await h.adminSql`UPDATE virtual_keys SET status = 'active' WHERE id = ${vkId}`;
});

describe('automation poller (§18 §3.3, B7.2)', () => {
  it('matches an event → applies pause_key; a re-scan does not double-apply', async () => {
    await addRule({ condition: { event_kind: 'budget_threshold' }, action: { type: 'pause_key' } });
    await fireEvent({ event_type: 'budget_threshold', virtual_key_id: vkId });

    const r1 = await poll();
    expect(r1.processed).toBe(1);
    const paused = await h.adminSql<{ status: string }[]>`
      SELECT status FROM virtual_keys WHERE id = ${vkId}`;
    expect(paused[0]!.status).toBe('paused');
    const runs =
      await h.adminSql`SELECT 1 FROM automation_runs WHERE org_id = ${orgId} AND status = 'applied'`;
    expect(runs).toHaveLength(1);

    await poll(); // re-scan: event already has a run row → NOT EXISTS cursor skips it
    const runs2 = await h.adminSql`SELECT 1 FROM automation_runs WHERE org_id = ${orgId}`;
    expect(runs2).toHaveLength(1); // still one — no double-apply
  });

  it('writes a no-match sentinel so an unmatched event is never re-scanned', async () => {
    await addRule({ condition: { event_kind: 'budget_threshold' }, action: { type: 'pause_key' } });
    await fireEvent({ event_type: 'something_else', virtual_key_id: vkId });
    await poll();
    const sentinel = await h.adminSql<{ status: string; rule_id: string | null }[]>`
      SELECT status, rule_id FROM automation_runs WHERE org_id = ${orgId}`;
    expect(sentinel).toHaveLength(1);
    expect(sentinel[0]!.status).toBe('skipped');
    expect(sentinel[0]!.rule_id).toBeNull();
  });

  it('notify_only rule records a would-have run and applies NO effect', async () => {
    await addRule({
      condition: { event_kind: 'budget_threshold' },
      action: { type: 'pause_key' },
      state: 'notify_only',
    });
    await fireEvent({ event_type: 'budget_threshold', virtual_key_id: vkId });
    await poll();
    const key = await h.adminSql<
      { status: string }[]
    >`SELECT status FROM virtual_keys WHERE id = ${vkId}`;
    expect(key[0]!.status).toBe('active'); // NOT paused
    const runs = await h.adminSql<
      { status: string }[]
    >`SELECT status FROM automation_runs WHERE org_id = ${orgId}`;
    expect(runs[0]!.status).toBe('notify_only');
  });

  it('isolates a poison rule: a later rule failure does not roll back an earlier applied effect (H8)', async () => {
    // good rule runs FIRST (priority 1) and pauses the key; the poison rule runs second and throws.
    // Pre-H8 the poison's throw rolled back the whole event tx — undoing the pause AND leaving no run
    // rows, so the event was re-scanned forever (at-most-once loss). Now each rule is savepoint-isolated.
    await addRule({
      condition: { event_kind: 'budget_threshold' },
      action: { type: 'pause_key' },
      priority: 1,
      stopOnMatch: false, // let the poison rule co-match so both run in one event tx
    });
    const poison = await addRule({
      condition: { event_kind: 'budget_threshold' },
      // a real effect type (passes match-time validation) that THROWS at apply: require_approval with
      // no approval_policy seeded → selectPolicy returns null → approval_chain_unsatisfiable.
      action: {
        type: 'require_approval',
        kind: 'budget_increase',
        scope_type: 'org',
        scope_id: orgId,
      },
      priority: 2,
    });
    await fireEvent({ event_type: 'budget_threshold', virtual_key_id: vkId });

    const r = await poll();
    expect(r.processed).toBe(1); // the event was processed, not wedged
    const key = await h.adminSql<{ status: string }[]>`
      SELECT status FROM virtual_keys WHERE id = ${vkId}`;
    expect(key[0]!.status).toBe('paused'); // the earlier pause SURVIVED the later failure

    const runs = await h.adminSql<{ status: string; rule_id: string }[]>`
      SELECT status, rule_id FROM automation_runs WHERE org_id = ${orgId}`;
    expect(runs.map((x) => x.status).sort()).toEqual(['applied', 'failed']);
    expect(runs.find((x) => x.status === 'failed')!.rule_id).toBe(poison);

    await poll(); // event is terminal (both rules have runs) → not re-processed
    const runs2 = await h.adminSql`SELECT 1 FROM automation_runs WHERE org_id = ${orgId}`;
    expect(runs2).toHaveLength(2);
  });

  it('rate cap: at the cap the effect is skipped and recorded rate_capped', async () => {
    const ruleId = await addRule({
      condition: { event_kind: 'budget_threshold' },
      action: { type: 'create_alert', kind: 'x' },
      rate: 1,
    });
    // seed one prior 'applied' run in the last hour → at the cap of 1
    await h.adminSql`INSERT INTO automation_runs (org_id, rule_id, trigger_event_id, status, ran_at)
      VALUES (${orgId}, ${ruleId}, ${randomUUID()}, 'applied', now())`;
    await fireEvent({ event_type: 'budget_threshold', virtual_key_id: vkId });
    await poll();
    const capped =
      await h.adminSql`SELECT 1 FROM automation_runs WHERE org_id = ${orgId} AND status = 'rate_capped'`;
    expect(capped).toHaveLength(1);
  });
});

describe('require_approval composition (§18 §3.6, B7.2)', () => {
  it('a rule → require_approval opens an approval, freezes the chain, arms the expiry timer', async () => {
    await h.adminSql`INSERT INTO users (id, email) VALUES ('u_req', 'req@t.dev'), ('u_app', 'app@t.dev')
      ON CONFLICT (id) DO NOTHING`;
    await h.adminSql`INSERT INTO org_members (org_id, user_id, role)
      VALUES (${orgId}, 'u_req', 'member'), (${orgId}, 'u_app', 'admin')`;
    await h.adminSql`INSERT INTO approval_policies (org_id, name, kind, definition, version, enabled)
      VALUES (${orgId}, 'p', 'budget_increase',
              ${JSON.stringify({ tiers: [{ min_amount_usd: '0', steps: [{ approvers: { roles: ['admin'] }, quorum: 'any' }] }] })}::jsonb,
              1, true)`;
    await addRule({
      condition: { event_kind: 'be' },
      action: {
        type: 'require_approval',
        kind: 'budget_increase',
        scope_type: 'org',
        scope_id: orgId,
        amount_usd: '500',
      },
    });
    await fireEvent({ event_type: 'be' });

    const reg = makeEffectRegistry({ membershipFor: (o, tx) => buildMembership(tx, o) });
    await runAutomationPoller({ jobsDb: h.jobsDb, db: h.db, registry: reg });

    const appr = await h.adminSql<{ status: string; kind: string }[]>`
      SELECT status, kind FROM approval_requests WHERE org_id = ${orgId}`;
    expect(appr).toHaveLength(1);
    expect(appr[0]!.status).toBe('pending');
    expect(appr[0]!.kind).toBe('budget_increase');
    const steps = await h.adminSql<{ required_approver_ids: string[] }[]>`
      SELECT required_approver_ids FROM approval_steps WHERE org_id = ${orgId}`;
    expect(steps).toHaveLength(1);
    expect(steps[0]!.required_approver_ids).toContain('u_app'); // admin resolved, requester (null) excluded
    const timer = await h.adminSql`
      SELECT 1 FROM workflow_timers WHERE org_id = ${orgId} AND kind = 'approval_expiry'`;
    expect(timer).toHaveLength(1);
  });
});

describe('timer sweep (§18 §4.2, B7.2)', () => {
  it('an automation_suspend timer resumes (unpauses) the key, then marks fired', async () => {
    await h.adminSql`UPDATE virtual_keys SET status = 'paused' WHERE id = ${vkId}`;
    const timerId = randomUUID();
    await h.adminSql`INSERT INTO workflow_timers (id, org_id, kind, ref_id, fire_at)
      VALUES (${timerId}, ${orgId}, 'automation_suspend', ${vkId}, now() - interval '1 minute')`;

    const res = await sweepTimers({ jobsDb: h.jobsDb, db: h.db, registry });
    expect(res.swept).toBe(1);
    const key = await h.adminSql<
      { status: string }[]
    >`SELECT status FROM virtual_keys WHERE id = ${vkId}`;
    expect(key[0]!.status).toBe('active'); // resumed
    const fired = await h.adminSql<{ fired_at: Date | null }[]>`
      SELECT fired_at FROM workflow_timers WHERE id = ${timerId}`;
    expect(fired[0]!.fired_at).not.toBeNull();
  });
});
