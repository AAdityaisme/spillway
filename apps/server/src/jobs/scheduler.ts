import { sql } from 'drizzle-orm';
import type { DatabaseClient } from '../db/client.js';
import { asJobs } from '../db/jobs.js';
import { withOrg } from '../db/tenancy.js';
import { makeEffectRegistry, type EffectRegistry } from '../services/effects/registry.js';
import { buildMembership } from '../services/approvals/membership.js';
import { runAutomationPoller } from '../services/automation/poller.js';
import { sweepTimers } from '../services/automation/timers.js';
import { runAlertDelivery, type ChannelSink } from '../services/alerts/delivery.js';
import { runAnomalyScanForScope } from '../services/anomaly/scan.js';
import { evaluateAndFireBudgetForecast } from '../services/anomaly/forecast-scan.js';
import {
  fetchEnabledErrorRateAlerts,
  evaluateAndFireErrorRate,
} from '../services/alerts/error-rate.js';
import { runRetentionSweep, type RetentionResult } from './retention.js';
import { runInsightsScan } from './insights.js';
import { jobRunsTotal, jobDurationMs } from '../observability/metrics.js';
import type { ScopeType } from '../services/anomaly/baseline.js';

/**
 * The background job scheduler (Part II 18 §3.3/§4.2, 19 §2.2; plan B7.1). Two leased jobs:
 *
 *  - `poller` (every 15s): automation poller → workflow-timer sweep → alert-delivery drain.
 *    Sweep + delivery ride the poller lease per 18 §3.3 step 1 / §4.2 — one lease, one cadence.
 *  - `anomaly-scan` (hourly): §2.3 scope selection cross-org, then per-scope anomaly v2
 *    evaluation under the org's own RLS context. The §3.2 confirmed AND-gate and §4 forecast
 *    steps are wired by their own B-steps; this job is the cadence + lease they attach to.
 *
 * Lease = crash-safe `job_runs` row: a run claims by inserting when no live row exists for the
 * job (live = unfinished AND younger than the stale window), serialized by an advisory xact
 * lock so two instances can't both claim. A crashed worker leaves an unfinished row that ages
 * past the stale window and stops blocking. FOR UPDATE SKIP LOCKED inside the poller/sweep
 * keeps row-level work single-consumer even if a lease is ever double-held.
 */

const POLLER_INTERVAL_MS = 15_000;
const ANOMALY_INTERVAL_MS = 3_600_000;
const RETENTION_INTERVAL_MS = 86_400_000;
const INSIGHTS_INTERVAL_MS = 604_800_000; // 19 §8: weekly savings-insights regenerate
const POLLER_STALE_MS = 120_000; // a poller run is seconds; 2min unfinished = crashed
const ANOMALY_STALE_MS = 1_800_000; // an hourly scan should never take 30min
const RETENTION_STALE_MS = 14_400_000; // ch12: 4h lease window — may process large volumes
const INSIGHTS_STALE_MS = 14_400_000; // 4h — a cross-org classify may process large volumes

// Stable advisory-lock keys per job (audit L33). hashtext(job) could collide two job names onto one
// advisory lock and serialize their claim attempts; correctness holds via the `where job=…` filter
// (only the claim latency is affected), but an enumerated bigint eliminates the surprise entirely.
const JOB_LOCK_KEY: Record<string, number> = {
  poller: 1,
  'anomaly-scan': 2,
  'retention-sweeper': 3,
  'savings-insights': 4,
};

// 19 §2.6 defaults: fire at max(3 × baseline, $5). Per-org alert config overrides land with the
// alert-config read seam (B-session); the defaults are the bible's documented floor.
const ANOMALY_DEFAULTS = { multiplier: 3, minUsdMicro: 5_000_000n };

// Keyset page size for anomaly scope selection (audit M29) — bounds memory + per-page tx length.
const SCOPE_PAGE_SIZE = 500;

interface SchedulerLog {
  info: (obj: Record<string, unknown>, msg: string) => void;
  error: (obj: Record<string, unknown>, msg: string) => void;
}

export interface SchedulerDeps {
  jobsDb: DatabaseClient; // spillway_jobs role — cross-org scan + job_runs lease
  db: DatabaseClient; // spillway_app role — per-org apply under withOrg
  log: SchedulerLog;
  sink?: ChannelSink | null; // alert delivery channel router; null → drain step skipped
  registry?: EffectRegistry; // injectable for tests; defaults to the real 8-handler registry
  now?: () => Date;
}

export interface SchedulerHandle {
  stop: () => Promise<void>;
}

/**
 * Claim the `job` lease: insert a job_runs row iff no live one exists. Returns the run id, or
 * null when another instance holds the lease. The advisory xact lock serializes concurrent
 * claimers (read-committed would otherwise let two pass the liveness check together).
 */
export async function claimJobRun(
  jobsDb: DatabaseClient,
  job: string,
  staleMs: number,
  now: Date,
): Promise<string | null> {
  void now; // liveness is evaluated entirely in the DB clock (below); mixing app+DB clocks let skew
  //          defeat the single-consumer guarantee (red-team post-B9 scheduler-lease).
  return asJobs(jobsDb, async (tx) => {
    // Stable per-job lock key (audit L33) — falls back to hashtext for any unenumerated job name.
    const lockKey = JOB_LOCK_KEY[job];
    if (lockKey !== undefined) {
      await tx.execute(sql`select pg_advisory_xact_lock(${lockKey})`);
    } else {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'spillway:job:' + job}))`);
    }
    // started_at AND the stale boundary are both now() — one clock domain, no skew window.
    const live = (await tx.execute(sql`
      select 1 from job_runs
       where job = ${job} and finished_at is null
         and started_at > now() - make_interval(secs => ${staleMs / 1000})
       limit 1`)) as unknown as unknown[];
    if (live.length > 0) return null;
    const rows = (await tx.execute(sql`
      insert into job_runs (job) values (${job}) returning id`)) as unknown as { id: string }[];
    return rows[0]?.id ?? null;
  });
}

export async function finishJobRun(
  jobsDb: DatabaseClient,
  id: string,
  ok: boolean,
  detail: Record<string, unknown>,
): Promise<void> {
  await asJobs(jobsDb, async (tx) => {
    await tx.execute(sql`
      update job_runs
         set finished_at = now(), ok = ${ok}, detail = ${JSON.stringify(detail)}::jsonb
       where id = ${id}`);
  });
}

/**
 * Prune finished job_runs older than 7 days. The 15s poller cadence writes ~5.8k rows/day, so the
 * lease table must be swept — but doing it inside every finishJobRun (audit L30) turned a repeated
 * full scan into steady per-tick load with no test coverage. It now rides the daily retention sweep,
 * where a single bounded pass keeps plenty of ops history.
 */
export async function pruneJobRuns(jobsDb: DatabaseClient): Promise<number> {
  return asJobs(jobsDb, async (tx) => {
    const res = (await tx.execute(sql`
      delete from job_runs
       where finished_at is not null and finished_at < now() - interval '7 days'`)) as unknown as {
      count?: number;
    };
    return Number(res.count ?? 0);
  });
}

/** One leased poller-job cycle: poller → timer sweep → delivery drain. Null when lease is held. */
export async function runPollerLeaseJob(
  deps: SchedulerDeps,
): Promise<{ processed: number; swept: number; delivered: number } | null> {
  const now = deps.now ?? (() => new Date());
  const runId = await claimJobRun(deps.jobsDb, 'poller', POLLER_STALE_MS, now());
  if (runId === null) return null;
  const registry =
    deps.registry ??
    makeEffectRegistry({ membershipFor: (orgId, tx) => buildMembership(tx, orgId) });
  const detail = { processed: 0, swept: 0, delivered: 0 };
  try {
    const polled = await runAutomationPoller({
      jobsDb: deps.jobsDb,
      db: deps.db,
      registry,
      now: deps.now,
      log: deps.log,
    });
    detail.processed = polled.processed;
    const sweep = await sweepTimers({ jobsDb: deps.jobsDb, db: deps.db, registry, now: deps.now });
    detail.swept = sweep.swept;
    if (deps.sink) {
      const delivery = await runAlertDelivery({
        jobsDb: deps.jobsDb,
        db: deps.db,
        sink: deps.sink,
        now: deps.now,
      });
      detail.delivered = delivery.delivered;
    }
    await finishJobRun(deps.jobsDb, runId, true, detail);
    return detail;
  } catch (err) {
    // A swallowed finish failure leaves the lease unfinished (blocks claims until the stale window)
    // and must be observable, not silent (audit L34).
    await finishJobRun(deps.jobsDb, runId, false, { ...detail, error: String(err) }).catch((e) =>
      deps.log.error({ job: 'poller', e }, 'finishJobRun failed'),
    );
    throw err;
  }
}

/** One leased retention-sweeper cycle (ch12; daily). Null when lease is held. */
export async function runRetentionJob(deps: SchedulerDeps): Promise<RetentionResult | null> {
  const now = deps.now ?? (() => new Date());
  const runId = await claimJobRun(deps.jobsDb, 'retention-sweeper', RETENTION_STALE_MS, now());
  if (runId === null) return null;
  try {
    const result = await runRetentionSweep(deps.jobsDb);
    // Job-runs prune rides the daily retention sweep, not every lease finish (audit L30).
    const prunedJobRuns = await pruneJobRuns(deps.jobsDb);
    const detail = { ...result, prunedJobRuns };
    await finishJobRun(deps.jobsDb, runId, true, detail as unknown as Record<string, unknown>);
    return result;
  } catch (err) {
    await finishJobRun(deps.jobsDb, runId, false, { error: String(err) }).catch((e) =>
      deps.log.error({ job: 'retention-sweeper', e }, 'finishJobRun failed'),
    );
    throw err;
  }
}

interface ScopeRow {
  org_id: string;
  scope_type: ScopeType;
  scope_id: string;
}

/** One leased anomaly-scan cycle (19 §2.2 steps 1–2). Null when lease is held. */
export async function runAnomalyScanJob(
  deps: SchedulerDeps,
): Promise<{ scopes: number; fired: number } | null> {
  const now = (deps.now ?? (() => new Date()))();
  const runId = await claimJobRun(deps.jobsDb, 'anomaly-scan', ANOMALY_STALE_MS, now);
  if (runId === null) return null;
  const detail = { scopes: 0, fired: 0, errors: 0, errorSample: [] as string[] };
  try {
    // §2.2: at utc_hour = 0 the day-counter is near-zero — skip selection + evaluation outright.
    if (now.getUTCHours() !== 0) {
      // §2.3 scope selection, KEYSET-PAGINATED (audit M29): as production grows to thousands of
      // scopes, a single unbounded select would hold the full row set in memory. Page through in
      // bounded chunks ordered by (org_id, scope_type, scope_id); each page is a short jobs-role tx
      // and each scope still settles in its own withOrg tx (per-scope isolation below).
      let after: { org_id: string; scope_type: string; scope_id: string } | null = null;
      for (;;) {
        const cursor = after;
        const page = (await asJobs(deps.jobsDb, async (tx) =>
          tx.execute(sql`
            select org_id, scope_type, scope_id
              from spend_counters
             where period_key ~ '^\\d{4}-\\d{2}-\\d{2}$'
               and period_key < to_char(now() at time zone 'utc', 'YYYY-MM-DD')
               ${
                 cursor
                   ? sql`and (org_id, scope_type, scope_id) > (${cursor.org_id}, ${cursor.scope_type}, ${cursor.scope_id})`
                   : sql``
               }
             group by org_id, scope_type, scope_id
            having count(distinct period_key) >= 7
             order by org_id, scope_type, scope_id
             limit ${SCOPE_PAGE_SIZE}`),
        )) as unknown as ScopeRow[];
        if (page.length === 0) break;
        detail.scopes += page.length;
        // Per-SCOPE isolation (expanded-audit HIGH): one bad scope/org must not abort the whole
        // cross-org run. Each scope settles in its own tx; a failure is counted + sampled and the run
        // continues. (Scope-selection above still fails the job if IT throws — we can't proceed
        // without the scope list.)
        for (const s of page) {
          try {
            const evaluation = await withOrg(deps.db, s.org_id, (tx) =>
              runAnomalyScanForScope(
                tx,
                { orgId: s.org_id, scopeType: s.scope_type, scopeId: s.scope_id },
                now,
                ANOMALY_DEFAULTS,
              ),
            );
            if (evaluation.fires) detail.fired += 1;
          } catch (err) {
            detail.errors += 1;
            if (detail.errorSample.length < 5)
              detail.errorSample.push(`${s.org_id}/${s.scope_type}/${s.scope_id}: ${String(err)}`);
          }
        }
        const last = page[page.length - 1]!;
        after = { org_id: last.org_id, scope_type: last.scope_type, scope_id: last.scope_id };
        if (page.length < SCOPE_PAGE_SIZE) break;
      }
    }
    // Error-rate alerts (§M5.3): windowed, so evaluated every scan cycle (incl. utc_hour 0, unlike
    // anomaly). Configured alerts read cross-org (jobs role); each fires per-org under RLS (app role,
    // same as the anomaly producer). One bad alert/org is counted + sampled, never aborts the run.
    let errorRateFired = 0;
    const erAlerts = await asJobs(deps.jobsDb, fetchEnabledErrorRateAlerts);
    for (const alert of erAlerts) {
      try {
        const fired = await withOrg(deps.db, alert.orgId, (tx) =>
          evaluateAndFireErrorRate(tx, alert, now),
        );
        if (fired) errorRateFired += 1;
      } catch (err) {
        detail.errors += 1;
        if (detail.errorSample.length < 5)
          detail.errorSample.push(`error_rate ${alert.id}: ${String(err)}`);
      }
    }
    // Budget forecast (§4): runs EVERY cycle including utc_hour 0 (a forward projection is valid at
    // any hour). Per-org: enumerate orgs (jobs role on `orgs`) and forecast each org's month budgets
    // under its own RLS (app role) — no cross-org grant on `budgets` needed. An org with no month
    // budgets returns 0 cheaply. orgs is a small table (one row per customer); one bad org is counted.
    let forecastFired = 0;
    const orgRows = (await asJobs(deps.jobsDb, (tx) =>
      tx.execute(sql`select id from orgs`),
    )) as unknown as { id: string }[];
    for (const o of orgRows) {
      try {
        forecastFired += await withOrg(deps.db, o.id, (tx) =>
          evaluateAndFireBudgetForecast(tx, { orgId: o.id, now }),
        );
      } catch (err) {
        detail.errors += 1;
        if (detail.errorSample.length < 5)
          detail.errorSample.push(`forecast ${o.id}: ${String(err)}`);
      }
    }
    await finishJobRun(deps.jobsDb, runId, true, { ...detail, errorRateFired, forecastFired });
    return detail;
  } catch (err) {
    await finishJobRun(deps.jobsDb, runId, false, { ...detail, error: String(err) }).catch((e) =>
      deps.log.error({ job: 'anomaly-scan', e }, 'finishJobRun failed'),
    );
    throw err;
  }
}

/** One leased savings-insights cycle (19 §8; weekly). Null when lease is held. */
export async function runInsightsJob(
  deps: SchedulerDeps,
): Promise<{ orgs: number; failed: number } | null> {
  const now = (deps.now ?? (() => new Date()))();
  const runId = await claimJobRun(deps.jobsDb, 'savings-insights', INSIGHTS_STALE_MS, now);
  if (runId === null) return null;
  try {
    // Pass the log so a single org's failure is observable + counted, not fatal (audit M28).
    const result = await runInsightsScan(deps.jobsDb, deps.db, now, deps.log);
    await finishJobRun(deps.jobsDb, runId, true, result);
    return result;
  } catch (err) {
    await finishJobRun(deps.jobsDb, runId, false, { error: String(err) }).catch((e) =>
      deps.log.error({ job: 'savings-insights', e }, 'finishJobRun failed'),
    );
    throw err;
  }
}

/** Start the cadence loops. Ticks never overlap themselves; errors are logged, never fatal. */
export function startScheduler(deps: SchedulerDeps): SchedulerHandle {
  let pollerBusy = false;
  let anomalyBusy = false;
  let retentionBusy = false;
  let insightsBusy = false;
  let stopped = false;

  const tick = async (
    name: string,
    busy: () => boolean,
    setBusy: (b: boolean) => void,
    run: () => Promise<unknown>,
  ): Promise<void> => {
    if (stopped || busy()) return;
    setBusy(true);
    const t0 = Date.now();
    try {
      const result = await run();
      if (result !== null) {
        deps.log.info({ job: name, result }, 'job cycle done');
        jobRunsTotal.inc({ job: name, ok: 'true' });
        jobDurationMs.observe({ job: name }, Date.now() - t0);
      }
    } catch (err) {
      deps.log.error({ job: name, err }, 'job cycle failed');
      jobRunsTotal.inc({ job: name, ok: 'false' });
    } finally {
      setBusy(false);
    }
  };

  const pollerTick = () =>
    tick(
      'poller',
      () => pollerBusy,
      (b) => (pollerBusy = b),
      () => runPollerLeaseJob(deps),
    );
  const anomalyTick = () =>
    tick(
      'anomaly-scan',
      () => anomalyBusy,
      (b) => (anomalyBusy = b),
      () => runAnomalyScanJob(deps),
    );
  const retentionTick = () =>
    tick(
      'retention-sweeper',
      () => retentionBusy,
      (b) => (retentionBusy = b),
      () => runRetentionJob(deps),
    );
  const insightsTick = () =>
    tick(
      'savings-insights',
      () => insightsBusy,
      (b) => (insightsBusy = b),
      () => runInsightsJob(deps),
    );

  void pollerTick();
  void anomalyTick();
  void retentionTick();
  void insightsTick();
  const timers = [
    setInterval(() => void pollerTick(), POLLER_INTERVAL_MS),
    setInterval(() => void anomalyTick(), ANOMALY_INTERVAL_MS),
    setInterval(() => void retentionTick(), RETENTION_INTERVAL_MS),
    setInterval(() => void insightsTick(), INSIGHTS_INTERVAL_MS),
  ];
  for (const t of timers) if (typeof t.unref === 'function') t.unref();

  return {
    stop: async () => {
      stopped = true;
      for (const t of timers) clearInterval(t);
      // Let an in-flight tick settle so its lease row gets finished — but BOUND the wait (expanded-audit
      // HIGH #5): an unbounded drain blocked SIGTERM, so Fly's grace timer SIGKILLed active streams. A
      // stuck job's lease ages out via its stale window anyway.
      const deadline = Date.now() + 8_000;
      while ((pollerBusy || anomalyBusy || retentionBusy || insightsBusy) && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 25));
      // Timed out with a tick still in flight (audit L31): its lease row is unfinished and would
      // block new claims for the whole stale window (up to 4h for retention). Best-effort mark any
      // of OUR still-unfinished lease rows finished ok=false so a fresh worker can re-claim
      // immediately. This can't touch a row a live worker is about to finish — the only rows this
      // matches are ones whose owning tx is being aborted by pool close.
      if (pollerBusy || anomalyBusy || retentionBusy || insightsBusy) {
        const busyJobs = [
          pollerBusy ? 'poller' : null,
          anomalyBusy ? 'anomaly-scan' : null,
          retentionBusy ? 'retention-sweeper' : null,
          insightsBusy ? 'savings-insights' : null,
        ].filter((j): j is string => j !== null);
        await asJobs(deps.jobsDb, (tx) =>
          tx.execute(sql`
            update job_runs set finished_at = now(), ok = false,
                   detail = '{"error":"stopped-before-finish"}'::jsonb
             where finished_at is null
               and job = any(ARRAY[${sql.join(
                 busyJobs.map((j) => sql`${j}`),
                 sql`, `,
               )}]::text[])`),
        ).catch((e) => deps.log.error({ e }, 'stop() best-effort lease finish failed'));
      }
    },
  };
}
