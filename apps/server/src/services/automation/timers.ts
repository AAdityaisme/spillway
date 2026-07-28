import { sql } from 'drizzle-orm';
import type { DatabaseClient } from '../../db/client.js';
import { asJobs } from '../../db/jobs.js';
import { withOrg, type Tx } from '../../db/tenancy.js';
import { runEffect, type EffectRegistry } from '../effects/registry.js';

/**
 * Durable-timer sweep (Part II §18 §4.2) — one table + one cron sweep serves every wait in both
 * engines (approval expiry/reminder/escalation, automation suspend/schedule). Never `setTimeout`. A
 * sub-step of the same lease job as the poller, 15s cadence.
 *
 * At-least-once: `fired_at` is set in the SAME tx as the handler's DB-local effect, so a crash rolls
 * back both and the timer is re-swept; handlers are idempotent (expiry no-ops on terminal; the schedule
 * row is deduped; `unpause_key` no-ops on an active key), so a duplicate fire is harmless.
 */

const jsonb = (v: unknown) => sql`${JSON.stringify(v)}::jsonb`;

/** Raw tx.execute returns jsonb columns as STRINGS — coerce back (cf. B4). */
function asJson<T>(v: unknown): T {
  return (typeof v === 'string' ? JSON.parse(v) : v) as T;
}

interface TimerRow {
  id: string;
  org_id: string;
  kind: string;
  ref_id: string;
  fire_at: Date;
  payload: Record<string, unknown>;
}

/** Compute the next cron fire (injectable). `null` ⇒ no re-arm. */
export type NextCronFire = (cron: string, after: Date) => Date | null;

export interface SweepDeps {
  jobsDb: DatabaseClient; // cross-org SCAN (spillway_jobs)
  db: DatabaseClient; // per-timer APPLY (spillway_app under withOrg)
  registry: EffectRegistry;
  now?: () => Date;
  nextCronFire?: NextCronFire;
}

export interface SweepResult {
  swept: number;
}

/** Minimal default: `@every <n>[smh]`. Anything else ⇒ no re-arm (V2 can inject a full parser). */
export const defaultNextCronFire: NextCronFire = (cron, after) => {
  const m = /^@every\s+(\d+)([smh])$/.exec(cron.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const mult = m[2] === 's' ? 1000 : m[2] === 'm' ? 60_000 : 3_600_000;
  return new Date(after.getTime() + n * mult);
};

async function dispatch(deps: SweepDeps, tx: Tx, t: TimerRow, now: Date): Promise<void> {
  switch (t.kind) {
    case 'approval_expiry': {
      // No-op if the request is no longer pending (idempotent on terminal).
      const rows = (await tx.execute(sql`
        select status from approval_requests where id = ${t.ref_id}`)) as unknown as {
        status: string;
      }[];
      if (rows[0]?.status === 'pending') {
        await tx.execute(sql`
          update approval_requests
             set status = 'cancelled', decided_by = null, decided_at = now(), decision_comment = 'expired'
           where id = ${t.ref_id}`);
        await tx.execute(sql`
          insert into audit_log (org_id, actor_type, actor_id, action, target, meta)
          values (${t.org_id}, 'system', null, 'approval.expire',
                  ${jsonb({ type: 'approval_request', id: t.ref_id })}, ${jsonb({})})`);
      }
      return;
    }
    case 'approval_reminder': {
      // No-op if terminal; else enqueue a reminder for the CURRENT step (step-indexed dedupe).
      const rows = (await tx.execute(sql`
        select status, current_step_index from approval_requests where id = ${t.ref_id}`)) as unknown as {
        status: string;
        current_step_index: number;
      }[];
      const req = rows[0];
      if (req?.status === 'pending') {
        await tx.execute(sql`
          insert into alert_events (org_id, alert_id, fired_at, dedupe_key, payload)
          values (${t.org_id}, null, now(),
                  ${'approval:' + t.ref_id + ':reminder:' + req.current_step_index},
                  ${jsonb({ event: 'reminder', approval_id: t.ref_id })})
          on conflict (alert_id, dedupe_key) do nothing`);
      }
      return;
    }
    case 'approval_escalation': {
      // Widen the current step (additive-only, §2.11). Escalation approver ids are resolved at
      // arm-time and carried in payload.add_ids.
      const rows = (await tx.execute(sql`
        select status, current_step_index from approval_requests where id = ${t.ref_id}`)) as unknown as {
        status: string;
        current_step_index: number;
      }[];
      const req = rows[0];
      const addIds = t.payload['add_ids'];
      if (req?.status === 'pending' && Array.isArray(addIds) && addIds.length > 0) {
        const addArr = sql`ARRAY[${sql.join(
          (addIds as string[]).map((id) => sql`${id}`),
          sql`, `,
        )}]::text[]`;
        await tx.execute(sql`
          update approval_steps
             set required_approver_ids = (
               select array(select distinct e from unnest(required_approver_ids || ${addArr}) e))
           where approval_id = ${t.ref_id} and step_index = ${req.current_step_index}`);
      }
      return;
    }
    case 'rule_schedule': {
      // Synthetic schedule event for the poller (deduped); then arm the next cron fire.
      const fireIso = new Date(t.fire_at).toISOString();
      await tx.execute(sql`
        insert into alert_events (org_id, alert_id, fired_at, dedupe_key, payload)
        values (${t.org_id}, null, now(), ${'schedule:' + t.ref_id + ':' + fireIso},
                ${jsonb({ event_type: 'schedule', rule_id: t.ref_id })})
        on conflict (alert_id, dedupe_key) do nothing`);
      const nextFire = deps.nextCronFire ?? defaultNextCronFire;
      const cronRows = (await tx.execute(sql`
        select schedule_cron from automation_rules where id = ${t.ref_id}`)) as unknown as {
        schedule_cron: string | null;
      }[];
      const cron = cronRows[0]?.schedule_cron ?? null;
      if (cron !== null) {
        const next = nextFire(cron, new Date(t.fire_at));
        if (next) {
          await tx.execute(sql`
            insert into workflow_timers (org_id, kind, ref_id, fire_at)
            values (${t.org_id}, 'rule_schedule', ${t.ref_id}, ${next.toISOString()})
            on conflict (ref_id, kind, fire_at) do nothing`);
        }
      }
      return;
    }
    case 'automation_suspend': {
      // Resume: unpause the key (no-op if a cancel already flipped it active, §4.2).
      await runEffect(
        deps.registry,
        {
          tx,
          orgId: t.org_id,
          actor: { type: 'system', id: null },
          source: 'automation:suspend',
          now,
        },
        `suspend:${t.ref_id}:${new Date(t.fire_at).toISOString()}`,
        { type: 'unpause_key', virtual_key_id: t.ref_id },
      );
      return;
    }
  }
}

export async function sweepTimers(deps: SweepDeps): Promise<SweepResult> {
  const now = deps.now ? deps.now() : new Date();

  // Scan (jobs role, cross-org): due, unfired timers.
  const timers = (await asJobs(
    deps.jobsDb,
    (tx) =>
      tx.execute(sql`
        select id, org_id, kind, ref_id, fire_at, payload from workflow_timers
         where fired_at is null and fire_at <= now()
         for update skip locked
         limit 200`) as unknown as Promise<TimerRow[]>,
  )) as unknown as TimerRow[];

  let swept = 0;
  for (const t of timers) {
    // Dispatch + `fired_at` in the SAME tx (at-least-once, §4.2 step 3). Coerce the jsonb payload
    // (raw execute yields a string) so escalation's payload.add_ids reads correctly.
    const timer = { ...t, payload: asJson<Record<string, unknown>>(t.payload) };
    await withOrg(deps.db, t.org_id, async (tx) => {
      await dispatch(deps, tx, timer, now);
      await tx.execute(sql`update workflow_timers set fired_at = now() where id = ${t.id}`);
    });
    swept++;
  }
  return { swept };
}

/**
 * Suspend-cancel (PagerDuty suspend-with-cancel, §4.2): a "spend normalized" resolve event deletes the
 * pending suspend timer, so the key stays paused only until spend normalizes or the timer fires,
 * whichever first. Exposed for the poller/resolve wiring.
 */
export async function cancelSuspend(tx: Tx, refId: string): Promise<void> {
  await tx.execute(sql`
    delete from workflow_timers
     where ref_id = ${refId} and kind = 'automation_suspend' and fired_at is null`);
}
