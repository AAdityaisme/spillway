import { sql } from 'drizzle-orm';
import type { DatabaseClient } from '../../db/client.js';
import { asJobs } from '../../db/jobs.js';
import { withOrg, type Tx } from '../../db/tenancy.js';
import { runEffect, type EffectContext, type EffectRegistry } from '../effects/registry.js';
import {
  eventKindOf,
  effectiveState,
  isRateCapped,
  matchRules,
  normalizeEffects,
  type AutomationRule,
  type CelEval,
  type EventPayload,
} from './safety.js';

/**
 * Automation poller (Part II §18 §3.3) — the routing-rules first-match model moved OFF the hot path
 * and pointed at the `alert_events` log. A sub-step of the anomaly-scan / alert-delivery cron; two
 * roles: cross-org SCAN as spillway_jobs (24h NOT EXISTS cursor, FOR UPDATE SKIP LOCKED), per-event
 * APPLY as spillway_app under withOrg.
 *
 * Idempotency is two-layered: `automation_runs` UNIQUE is the coarse guard; per-effect idempotency
 * keyed `${rule}:${event}:${e}` (state-check pause, origin conflict) is the fine guard. At-least-once
 * + idempotent handlers — exactly-once delivery is not chased (F8/R). Effects and the run-row insert
 * commit in ONE withOrg tx (atomic): a crash rolls back both, and a re-scan converges via the fine
 * guard.
 */

const jsonb = (v: unknown) => sql`${JSON.stringify(v)}::jsonb`;

/** Raw tx.execute returns jsonb columns as STRINGS (no driver decode) — coerce back (cf. B4). */
function asJson<T>(v: unknown): T {
  return (typeof v === 'string' ? JSON.parse(v) : v) as T;
}

interface EventRow {
  id: string;
  org_id: string;
  payload: EventPayload;
}

export interface PollerDeps {
  jobsDb: DatabaseClient; // cross-org SCAN (spillway_jobs)
  db: DatabaseClient; // per-event APPLY (spillway_app under withOrg)
  registry: EffectRegistry;
  celEval?: CelEval;
  now?: () => Date;
  /** Optional structured logger — failed events log with a full stack, not just the run row. */
  log?: { error: (obj: Record<string, unknown>, msg: string) => void };
}

export interface PollerResult {
  processed: number;
}

/** Fill effect params from the event subject when omitted (§3.2). */
function withDefaults(
  spec: { type: string } & Record<string, unknown>,
  payload: EventPayload,
): { type: string } & Record<string, unknown> {
  const out = { ...spec };
  if (out['virtual_key_id'] === undefined && payload['virtual_key_id'] !== undefined) {
    out['virtual_key_id'] = payload['virtual_key_id'];
  }
  if (out['scope_type'] === undefined && payload['scope_type'] !== undefined) {
    out['scope_type'] = payload['scope_type'];
  }
  if (out['scope_id'] === undefined) {
    const s = payload['scope_id'] ?? payload['virtual_key_id'];
    if (s !== undefined) out['scope_id'] = s;
  }
  return out;
}

async function appliedInWindow(tx: Tx, ruleId: string): Promise<number> {
  const rows = (await tx.execute(sql`
    select count(*)::int as n from automation_runs
     where rule_id = ${ruleId} and status = 'applied' and ran_at >= now() - interval '1 hour'`)) as unknown as {
    n: number;
  }[];
  return rows[0]?.n ?? 0;
}

async function applyRule(
  deps: PollerDeps,
  tx: Tx,
  ev: EventRow,
  payload: EventPayload,
  rule: AutomationRule,
  now: Date,
  onCommit: (fn: () => void) => void,
): Promise<void> {
  // Serialize the rate-cap check+apply for THIS rule across concurrent events (expanded-audit L36 —
  // two pollers processing distinct events near-simultaneously both passed a rate_cap_per_hour=1 check
  // and both applied). A tx-scoped advisory lock on the rule id makes the window count-then-apply
  // atomic per rule; it releases at commit. hashtext gives a stable int key from the uuid.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${rule.id}))`);
  // Rate cap (§3.5.2): at/over the cap → record and skip effects.
  if (isRateCapped(await appliedInWindow(tx, rule.id), rule.rate_cap_per_hour)) {
    await tx.execute(sql`
      insert into automation_runs (org_id, rule_id, trigger_event_id, status, effect)
      values (${ev.org_id}, ${rule.id}, ${ev.id}, 'rate_capped', ${jsonb({})})
      on conflict (rule_id, trigger_event_id) do nothing`);
    return;
  }

  const state = effectiveState(rule, now);
  if (state === 'notify_only') {
    // Match, emit a "would have …" notification, apply NO effect (§3.3 step 3.5).
    await tx.execute(sql`
      insert into alert_events (org_id, alert_id, fired_at, dedupe_key, payload)
      values (${ev.org_id}, null, now(), ${'automation-would-have:' + rule.id + ':' + ev.id},
              ${jsonb({ would_have: rule.action, rule_id: rule.id })})
      on conflict (alert_id, dedupe_key) do nothing`);
    await tx.execute(sql`
      insert into automation_runs (org_id, rule_id, trigger_event_id, status, effect)
      values (${ev.org_id}, ${rule.id}, ${ev.id}, 'notify_only', ${jsonb({ would_have: rule.action })})
      on conflict (rule_id, trigger_event_id) do nothing`);
    return;
  }

  const ctx: EffectContext = {
    tx,
    orgId: ev.org_id,
    actor: { type: 'system', id: null },
    source: 'automation',
    ruleId: rule.id,
    trigger_event_id: ev.id,
    now,
    onCommit, // effects register cache invalidation here; flushed after the event tx commits
  };
  const specs = normalizeEffects(rule.action);
  const merged: Record<string, unknown> = {};
  for (let e = 0; e < specs.length; e++) {
    const spec = withDefaults(specs[e]!, payload);
    const res = await runEffect(deps.registry, ctx, `${rule.id}:${ev.id}:${e}`, spec);
    Object.assign(merged, res);
  }
  await tx.execute(sql`
    insert into automation_runs (org_id, rule_id, trigger_event_id, status, effect)
    values (${ev.org_id}, ${rule.id}, ${ev.id}, 'applied', ${jsonb(merged)})
    on conflict (rule_id, trigger_event_id) do nothing`);
}

async function applyEvent(deps: PollerDeps, ev: EventRow, now: Date): Promise<void> {
  const payload = asJson<EventPayload>(ev.payload);
  // Post-commit cache invalidations from applied effects (ADR-038 §2.12) — emitted only AFTER the
  // event tx commits, and only for rules whose savepoint actually released (a rolled-back rule changed
  // nothing, so its invalidations are discarded).
  const postCommit: (() => void)[] = [];
  await withOrg(deps.db, ev.org_id, async (tx) => {
    const eventKind = eventKindOf(payload);
    const raw = (await tx.execute(sql`
      select * from automation_rules order by priority asc`)) as unknown as AutomationRule[];
    // jsonb condition/action arrive as strings via raw execute — coerce before the matcher (B4 class).
    const rules = raw.map((r) => ({
      ...r,
      condition: asJson<Record<string, unknown>>(r.condition),
      action: asJson<Record<string, unknown>>(r.action),
    }));
    const matched = matchRules(rules, eventKind, payload, now, deps.celEval);
    if (matched.length === 0) {
      // No-match sentinel so the event is never re-scanned (§3.3 step 3.3).
      await tx.execute(sql`
        insert into automation_runs (org_id, rule_id, trigger_event_id, status, effect)
        values (${ev.org_id}, null, ${ev.id}, 'skipped', ${jsonb({ reason: 'no_match' })})
        on conflict (trigger_event_id) where rule_id is null do nothing`);
      return;
    }
    // Per-rule SAVEPOINT isolation (expanded-audit HIGH H8). All co-matched rules share one event tx;
    // previously a later rule's throw rolled back an EARLIER rule's already-applied effect (e.g. a
    // pause_key) and wedged the whole event at-most-once. Now each rule commits or rolls back
    // independently; a failure records a per-rule 'failed' run (terminal for that rule+event only) and
    // the sibling rules proceed.
    for (const rule of matched) {
      const ruleCbs: (() => void)[] = [];
      try {
        await tx.execute(sql`savepoint automation_rule`);
        await applyRule(deps, tx, ev, payload, rule, now, (fn) => ruleCbs.push(fn));
        await tx.execute(sql`release savepoint automation_rule`);
        postCommit.push(...ruleCbs); // rule committed → its invalidations are real
      } catch (err) {
        await tx.execute(sql`rollback to savepoint automation_rule`); // discards ruleCbs
        await tx.execute(sql`
          insert into automation_runs (org_id, rule_id, trigger_event_id, status, effect)
          values (${ev.org_id}, ${rule.id}, ${ev.id}, 'failed', ${jsonb({ error: String(err) })})
          on conflict (rule_id, trigger_event_id) do nothing`);
        await tx.execute(sql`release savepoint automation_rule`);
      }
    }
  });
  // Tx committed: fire the collected cache invalidations (never before commit — a mid-tx emit lets a
  // concurrent cache-fill re-read the stale row). Swallow: a failed emit must not fail the run.
  for (const fn of postCommit) {
    try {
      fn();
    } catch {
      /* invalidation is best-effort; the 30s TTL is the backstop */
    }
  }
}

export async function runAutomationPoller(deps: PollerDeps): Promise<PollerResult> {
  const now = deps.now ? deps.now() : new Date();

  // Scan (jobs role, cross-org): un-processed events in the last 24h, oldest first. NOT EXISTS is the
  // cursor (robust to out-of-order / backfilled events); FOR UPDATE SKIP LOCKED stops a second
  // instance double-claiming the same event.
  const events = (await asJobs(
    deps.jobsDb,
    (tx) =>
      tx.execute(sql`
        select ae.id, ae.org_id, ae.payload
          from alert_events ae
         where ae.fired_at >= now() - interval '24 hours'
           and not exists (select 1 from automation_runs r where r.trigger_event_id = ae.id)
         order by ae.fired_at asc
         for update skip locked
         limit 200`) as unknown as Promise<EventRow[]>,
  )) as unknown as EventRow[];

  let processed = 0;
  for (const ev of events) {
    try {
      await applyEvent(deps, ev, now);
    } catch (err) {
      // A deterministic effect throw (bad param / no selectable policy) rolls back the effect tx.
      // Record a terminal 'failed' run row in a SEPARATE withOrg tx (§3.3; status='failed') so the
      // event isn't re-scanned forever — one poison event must not wedge the cross-org, oldest-first
      // batch for every tenant.
      deps.log?.error({ err, eventId: ev.id, orgId: ev.org_id }, 'automation event failed');
      await withOrg(deps.db, ev.org_id, (tx) =>
        tx.execute(sql`
          insert into automation_runs (org_id, rule_id, trigger_event_id, status, effect, error)
          values (${ev.org_id}, null, ${ev.id}, 'failed', ${jsonb({})}, ${String(err)})
          on conflict (trigger_event_id) where rule_id is null do nothing`),
      );
    }
    processed++;
  }
  return { processed };
}
