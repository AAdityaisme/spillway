import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { makeTestApp, type TestHarness } from '../../../test/helpers/app.js';
import { withOrg, type Tx } from '../../db/tenancy.js';
import { internalBus } from '@spillway/shared';
import { makeEffectRegistry, runEffect, type EffectContext } from './registry.js';
import type { Membership } from '../approvals/materialize.js';

/**
 * B7.1 effect-registry exit gate (Part II §18 §3.4): every effect is idempotent, keyed, and audits.
 * Runs the real handlers inside withOrg against RLS Postgres — a re-apply of each is a state no-op.
 */

let h: TestHarness;
const orgId = randomUUID();
let vkId: string;

const noMembers: Membership = { byRoles: () => [], isMember: () => false };
const registry = () => makeEffectRegistry({ membershipFor: () => noMembers });

/** Build a system-actor automation EffectContext for a tx. */
const sysCtx = (tx: Tx, over: Partial<EffectContext> = {}): EffectContext => ({
  tx,
  orgId,
  actor: { type: 'system', id: null },
  source: 'automation',
  ruleId: 'rule-1',
  trigger_event_id: 'evt-1',
  now: new Date('2026-07-07T12:00:00Z'),
  ...over,
});

const run = (spec: { type: string } & Record<string, unknown>, key: string, over = {}) =>
  withOrg(h.db, orgId, (tx) => runEffect(registry(), sysCtx(tx, over), key, spec));

beforeAll(async () => {
  h = await makeTestApp();
  const sql = h.adminSql;
  await sql`INSERT INTO orgs (id, name, slug) VALUES (${orgId}, 'E', ${'e-' + orgId.slice(0, 8)})`;
  vkId = randomUUID();
  await sql`INSERT INTO virtual_keys (id, org_id, name, key_hash, key_prefix, status)
            VALUES (${vkId}, ${orgId}, 'k', ${Buffer.from(vkId)}, 'mk-e', 'active')`;
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.adminSql`TRUNCATE audit_log, workflow_timers, budgets, approval_policies, approval_requests, approval_steps`;
  await h.adminSql`UPDATE virtual_keys SET status = 'active' WHERE id = ${vkId}`;
});

const autoApprovePolicy = (kind: string) =>
  h.adminSql`INSERT INTO approval_policies (org_id, name, kind, definition, version, enabled)
    VALUES (${orgId}, ${'auto-' + kind}, ${kind},
            ${JSON.stringify({ tiers: [{ min_amount_usd: '0', auto_approve: true }] })}::jsonb, 1, true)`;

describe('effect registry (§18 §3.4, B7.1)', () => {
  it('pause_key is idempotent — flips once, audits once, re-apply is a no-op', async () => {
    const r1 = await run({ type: 'pause_key', virtual_key_id: vkId }, 'k1');
    expect(r1.paused_key).toBe(vkId);
    expect(r1.noop).toBeUndefined();
    const r2 = await run({ type: 'pause_key', virtual_key_id: vkId }, 'k2');
    expect(r2.noop).toBe(true); // already paused → flip is a no-op

    const status = await h.adminSql<{ status: string }[]>`
      SELECT status FROM virtual_keys WHERE id = ${vkId}`;
    expect(status[0]!.status).toBe('paused');
    const audits =
      await h.adminSql`SELECT 1 FROM audit_log WHERE org_id = ${orgId} AND action = 'virtual_key.pause'`;
    expect(audits).toHaveLength(1); // only the real flip audited
  });

  it('pause_key registers a post-commit virtual-key:mutated invalidation; a no-op flip does not (kill switch §5.1)', async () => {
    const fired: string[] = [];
    const onEvt = (p: { virtualKeyId: string }): void => void fired.push(p.virtualKeyId);
    internalBus.on('virtual-key:mutated', onEvt);
    try {
      const cbs: (() => void)[] = [];
      const r1 = await run({ type: 'pause_key', virtual_key_id: vkId }, 'k1', {
        onCommit: (fn: () => void) => cbs.push(fn),
      });
      expect(r1.noop).toBeUndefined();
      expect(cbs).toHaveLength(1); // a real flip registered exactly one invalidation
      cbs.forEach((fn) => fn()); // post-commit flush (what the poller does after the tx)
      expect(fired).toEqual([vkId]);

      // Re-apply on an already-paused key is a no-op → no invalidation registered.
      const cbs2: (() => void)[] = [];
      const r2 = await run({ type: 'pause_key', virtual_key_id: vkId }, 'k2', {
        onCommit: (fn: () => void) => cbs2.push(fn),
      });
      expect(r2.noop).toBe(true);
      expect(cbs2).toHaveLength(0);
    } finally {
      internalBus.off('virtual-key:mutated', onEvt);
    }
  });

  it('suspend pauses + arms one resume timer; re-suspend does not arm a second', async () => {
    await run({ type: 'suspend', virtual_key_id: vkId, seconds: 300 }, 's1');
    await run({ type: 'suspend', virtual_key_id: vkId, seconds: 60 }, 's2'); // key already paused → no-op

    const timers = await h.adminSql`
      SELECT 1 FROM workflow_timers WHERE ref_id = ${vkId} AND kind = 'automation_suspend' AND fired_at IS NULL`;
    expect(timers).toHaveLength(1); // exactly one pending resume
  });

  it('pause cancels a pending suspend resume (a hard kill cannot silently reactivate)', async () => {
    await run({ type: 'suspend', virtual_key_id: vkId, seconds: 300 }, 's1');
    await run({ type: 'pause_key', virtual_key_id: vkId }, 'k1'); // hard kill during suspend
    const timers = await h.adminSql`
      SELECT 1 FROM workflow_timers WHERE ref_id = ${vkId} AND kind = 'automation_suspend' AND fired_at IS NULL`;
    expect(timers).toHaveLength(0); // resume cancelled
  });

  it('tighten_budget never raises — clamps down, re-apply is a no-op', async () => {
    await h.adminSql`INSERT INTO budgets (org_id, scope_type, scope_id, period, limit_usd)
      VALUES (${orgId}, 'org', ${orgId}, 'day', 100)`;
    const r1 = await run(
      { type: 'tighten_budget', scope_type: 'org', scope_id: orgId, period: 'day', factor: 0.5 },
      't1',
    );
    expect(r1.budget_limit).toBe('50.000000');
    // a RAISE attempt (factor 2) must be refused — never raises.
    const r2 = await run(
      { type: 'tighten_budget', scope_type: 'org', scope_id: orgId, period: 'day', factor: 2 },
      't2',
    );
    expect(r2.noop).toBe(true);
    const b = await h.adminSql<{ limit_usd: string }[]>`
      SELECT limit_usd FROM budgets WHERE org_id = ${orgId} AND scope_type = 'org' AND period = 'day'`;
    expect(Number(b[0]!.limit_usd)).toBe(50); // still 50, not raised to 100
  });

  it('create_alert dedupes on (alert_id, dedupe_key)', async () => {
    await run({ type: 'create_alert', kind: 'anomaly', dedupe_key: 'd1' }, 'a1');
    await run({ type: 'create_alert', kind: 'anomaly', dedupe_key: 'd1' }, 'a2'); // same dedupe → no-op
    const events =
      await h.adminSql`SELECT 1 FROM alert_events WHERE org_id = ${orgId} AND dedupe_key = 'd1'`;
    expect(events).toHaveLength(1);
  });

  it('require_approval with an auto-approve policy applies the effect immediately (H7)', async () => {
    await autoApprovePolicy('budget_increase');
    const res = await run(
      {
        type: 'require_approval',
        kind: 'budget_increase',
        scope_type: 'org',
        scope_id: orgId,
        requested_value: { new_limit_usd: '50', period: 'month' },
      },
      'ra-auto',
      { trigger_event_id: randomUUID() },
    );
    expect(res.auto_approved).toBe(true);
    // the budget was ACTUALLY raised — not left pending → expired → cancelled with no mutation
    const b = await h.adminSql<{ limit_usd: string }[]>`
      SELECT limit_usd FROM budgets WHERE org_id = ${orgId} AND scope_type = 'org' AND period = 'month'`;
    expect(Number(b[0]!.limit_usd)).toBe(50);
    const ar = await h.adminSql<{ status: string }[]>`
      SELECT status FROM approval_requests WHERE org_id = ${orgId}`;
    expect(ar[0]!.status).toBe('approved'); // finalized, not pending
    // no expiry timer armed for an already-final request
    const t = await h.adminSql`
      SELECT 1 FROM workflow_timers WHERE org_id = ${orgId} AND kind = 'approval_expiry'`;
    expect(t).toHaveLength(0);
  });

  it('auto-approve budget_increase with a missing new_limit_usd is rejected — never zeroes the budget (M38)', async () => {
    await autoApprovePolicy('budget_increase');
    await expect(
      run(
        {
          type: 'require_approval',
          kind: 'budget_increase',
          scope_type: 'org',
          scope_id: orgId,
          requested_value: {},
        },
        'ra-nolimit',
        { trigger_event_id: randomUUID() },
      ),
    ).rejects.toMatchObject({ code: 'approval_chain_unsatisfiable' });
    const b =
      await h.adminSql`SELECT 1 FROM budgets WHERE org_id = ${orgId} AND scope_type = 'org'`;
    expect(b).toHaveLength(0); // budget never created/zeroed
  });

  it('an unknown effect type → 422 unknown_effect', async () => {
    await expect(run({ type: 'nuke_everything' }, 'x')).rejects.toMatchObject({
      code: 'unknown_effect',
      httpStatus: 422,
    });
  });

  // ── M31: tighten_budget seed-new-budget branch + apply_budget_increase upsert (untested money paths)

  it('tighten_budget seeds a new budget from new_limit_usd; on-conflict re-apply is idempotent (M31)', async () => {
    // no budget row exists → only a new_limit_usd target can seed one (narrowing).
    const r1 = await run(
      {
        type: 'tighten_budget',
        scope_type: 'org',
        scope_id: orgId,
        period: 'day',
        new_limit_usd: '25',
      },
      'ts1',
    );
    expect(r1.budget_limit).toBe('25.000000');
    let b = await h.adminSql<{ limit_usd: string }[]>`
      SELECT limit_usd FROM budgets WHERE org_id = ${orgId} AND scope_type = 'org' AND period = 'day'`;
    expect(Number(b[0]!.limit_usd)).toBe(25);

    // re-seed at a DIFFERENT target — on conflict DO NOTHING means the existing row is untouched.
    const r2 = await run(
      {
        type: 'tighten_budget',
        scope_type: 'org',
        scope_id: orgId,
        period: 'day',
        new_limit_usd: '10',
      },
      'ts2',
    );
    // seed branch only runs when no row exists; here a row exists so it takes the clamp path → 10 < 25 → clamps
    expect(r2.budget_limit).toBe('10.000000');
    b = await h.adminSql<{ limit_usd: string }[]>`
      SELECT limit_usd FROM budgets WHERE org_id = ${orgId} AND scope_type = 'org' AND period = 'day'`;
    expect(Number(b[0]!.limit_usd)).toBe(10);
  });

  it('tighten_budget with no row and no new_limit_usd is a no-op (no_budget) (M31)', async () => {
    const r = await run(
      { type: 'tighten_budget', scope_type: 'org', scope_id: orgId, period: 'week', factor: 0.5 },
      'ts3',
    );
    expect(r).toMatchObject({ tightened: false, reason: 'no_budget' });
    const b =
      await h.adminSql`SELECT 1 FROM budgets WHERE org_id = ${orgId} AND scope_type = 'org' AND period = 'week'`;
    expect(b).toHaveLength(0);
  });

  it('apply_budget_increase upserts — insert path, do-update path, then no-op re-apply (M31)', async () => {
    // insert path (no existing row)
    const r1 = await run(
      {
        type: 'apply_budget_increase',
        scope_type: 'org',
        scope_id: orgId,
        period: 'month',
        new_limit_usd: '100',
      },
      'ai1',
    );
    expect(r1.budget_limit).toBe('100.000000');
    let b = await h.adminSql<{ limit_usd: string }[]>`
      SELECT limit_usd FROM budgets WHERE org_id = ${orgId} AND scope_type = 'org' AND period = 'month'`;
    expect(Number(b[0]!.limit_usd)).toBe(100);

    // do-update path — RAISES unconditionally (unlike tighten_budget which never raises)
    const r2 = await run(
      {
        type: 'apply_budget_increase',
        scope_type: 'org',
        scope_id: orgId,
        period: 'month',
        new_limit_usd: '250',
      },
      'ai2',
    );
    expect(r2.budget_limit).toBe('250.000000');
    b = await h.adminSql<{ limit_usd: string }[]>`
      SELECT limit_usd FROM budgets WHERE org_id = ${orgId} AND scope_type = 'org' AND period = 'month'`;
    expect(Number(b[0]!.limit_usd)).toBe(250);

    // no-op re-apply at the same target — one row, same value
    const r3 = await run(
      {
        type: 'apply_budget_increase',
        scope_type: 'org',
        scope_id: orgId,
        period: 'month',
        new_limit_usd: '250',
      },
      'ai3',
    );
    expect(r3.budget_limit).toBe('250.000000');
    const rows =
      await h.adminSql`SELECT 1 FROM budgets WHERE org_id = ${orgId} AND scope_type = 'org' AND period = 'month'`;
    expect(rows).toHaveLength(1);
  });

  // ── L32: notify / unpause_key / require_approval direct coverage

  it('notify inserts an alert_event and dedupes on re-apply with the same key (L32)', async () => {
    await run({ type: 'notify', payload: { msg: 'hi' } }, 'n1');
    await run({ type: 'notify', payload: { msg: 'hi' } }, 'n1'); // same key → auto:n1 dedupe → no-op
    const events =
      await h.adminSql`SELECT 1 FROM alert_events WHERE org_id = ${orgId} AND dedupe_key = 'auto:n1'`;
    expect(events).toHaveLength(1);
  });

  it('unpause_key flips paused→active once; re-apply on an active key is a no-op (L32)', async () => {
    await h.adminSql`UPDATE virtual_keys SET status = 'paused' WHERE id = ${vkId}`;
    const r1 = await run({ type: 'unpause_key', virtual_key_id: vkId }, 'u1');
    expect(r1.unpaused_key).toBe(vkId);
    expect(r1.noop).toBeUndefined();
    const r2 = await run({ type: 'unpause_key', virtual_key_id: vkId }, 'u2'); // already active → no-op
    expect(r2.noop).toBe(true);
    const status = await h.adminSql<{ status: string }[]>`
      SELECT status FROM virtual_keys WHERE id = ${vkId}`;
    expect(status[0]!.status).toBe('active');
    const audits =
      await h.adminSql`SELECT 1 FROM audit_log WHERE org_id = ${orgId} AND action = 'virtual_key.unpause'`;
    expect(audits).toHaveLength(1); // only the real flip audited
  });

  it('require_approval with no matching policy throws 422 approval_chain_unsatisfiable (L32)', async () => {
    // no approval_policies rows → selectPolicy returns null after the request is opened
    await expect(
      run(
        {
          type: 'require_approval',
          kind: 'budget_increase',
          scope_type: 'org',
          scope_id: orgId,
          requested_value: { new_limit_usd: '50' },
        },
        'ra-nopolicy',
        { trigger_event_id: randomUUID() },
      ),
    ).rejects.toMatchObject({ code: 'approval_chain_unsatisfiable', httpStatus: 422 });
  });

  it('require_approval dedupes on origin_event_id — a duplicate trigger is a no-op (L32)', async () => {
    await autoApprovePolicy('budget_increase');
    const evt = randomUUID();
    const spec = {
      type: 'require_approval',
      kind: 'budget_increase',
      scope_type: 'org',
      scope_id: orgId,
      requested_value: { new_limit_usd: '50', period: 'month' },
    };
    const first = await run(spec, 'ra-d1', { trigger_event_id: evt });
    expect(first.auto_approved).toBe(true);
    const second = await run(spec, 'ra-d2', { trigger_event_id: evt }); // same origin → deduped
    expect(second.deduped).toBe(true);
    const ars = await h.adminSql`SELECT 1 FROM approval_requests WHERE org_id = ${orgId}`;
    expect(ars).toHaveLength(1); // exactly one approval, not two
  });
});
