import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { makeTestApp, type TestHarness } from '../../test/helpers/app.js';
import {
  claimJobRun,
  finishJobRun,
  pruneJobRuns,
  runPollerLeaseJob,
  runAnomalyScanJob,
  runRetentionJob,
  type SchedulerDeps,
} from './scheduler.js';

/**
 * B7.1 scheduler: the crash-safe job_runs lease + the two leased cycles, against a real
 * RLS-enforced Postgres on the spillway_jobs role. Engine internals (poller matching, timer
 * re-arm, anomaly math) are covered by their own suites — this file proves the orchestration:
 * exclusive claim, stale takeover, cycle bookkeeping.
 */

let h: TestHarness;
const noopLog = { info: () => {}, error: () => {} };

const deps = (): SchedulerDeps => ({ jobsDb: h.jobsDb, db: h.db, log: noopLog, sink: null });

beforeAll(async () => {
  h = await makeTestApp();
});

afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  await h.adminSql`TRUNCATE job_runs`;
});

describe('job_runs lease', () => {
  it('claims exclusively — a live run blocks a second claim', async () => {
    const now = new Date();
    const first = await claimJobRun(h.jobsDb, 'poller', 120_000, now);
    expect(first).not.toBeNull();
    expect(await claimJobRun(h.jobsDb, 'poller', 120_000, now)).toBeNull();
  });

  it('concurrent claimers resolve to exactly one winner', async () => {
    const now = new Date();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => claimJobRun(h.jobsDb, 'poller', 120_000, now)),
    );
    expect(results.filter((r) => r !== null)).toHaveLength(1);
  });

  it('a finished run frees the lease; different jobs never contend', async () => {
    const now = new Date();
    const id = await claimJobRun(h.jobsDb, 'poller', 120_000, now);
    expect(await claimJobRun(h.jobsDb, 'anomaly-scan', 120_000, now)).not.toBeNull();
    await finishJobRun(h.jobsDb, id!, true, { processed: 0 });
    expect(await claimJobRun(h.jobsDb, 'poller', 120_000, now)).not.toBeNull();
  });

  it('a crashed (stale unfinished) run stops blocking after the stale window', async () => {
    await h.adminSql`
      INSERT INTO job_runs (job, started_at) VALUES ('poller', now() - interval '3 minutes')`;
    expect(await claimJobRun(h.jobsDb, 'poller', 120_000, new Date())).not.toBeNull();
  });
});

describe('leased cycles', () => {
  it('poller cycle runs poller + sweep and records a finished ok job_runs row', async () => {
    const result = await runPollerLeaseJob(deps());
    expect(result).toEqual({ processed: 0, swept: 0, delivered: 0 });
    const rows = await h.adminSql`
      SELECT job, ok, finished_at, detail FROM job_runs WHERE job = 'poller'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ok).toBe(true);
    expect(rows[0]!.finished_at).not.toBeNull();
  });

  it('poller cycle yields null (not an error) when the lease is held', async () => {
    await claimJobRun(h.jobsDb, 'poller', 120_000, new Date());
    expect(await runPollerLeaseJob(deps())).toBeNull();
  });

  it('anomaly cycle selects scopes cross-org and records its run', async () => {
    // outside the utc-midnight skip the empty DB yields zero scopes
    const d = { ...deps(), now: () => new Date('2026-07-07T12:30:00Z') };
    const result = await runAnomalyScanJob(d);
    expect(result).toEqual({ scopes: 0, fired: 0, errors: 0, errorSample: [] });
    const rows = await h.adminSql`SELECT ok, detail FROM job_runs WHERE job = 'anomaly-scan'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ok).toBe(true);
  });

  it('anomaly cycle honors the utc-midnight skip (19 §2.2)', async () => {
    const d = { ...deps(), now: () => new Date('2026-07-07T00:30:00Z') };
    const result = await runAnomalyScanJob(d);
    expect(result).toEqual({ scopes: 0, fired: 0, errors: 0, errorSample: [] });
  });
});

describe('job_runs prune (audit L30 — moved off every finish to the daily retention sweep)', () => {
  it('pruneJobRuns removes finished rows older than 7 days, keeps recent + unfinished', async () => {
    await h.adminSql`INSERT INTO job_runs (job, started_at, finished_at, ok)
      VALUES ('poller', now() - interval '10 days', now() - interval '10 days', true)`; // stale finished → pruned
    await h.adminSql`INSERT INTO job_runs (job, started_at, finished_at, ok)
      VALUES ('poller', now() - interval '1 day', now() - interval '1 day', true)`; // recent → kept
    await h.adminSql`INSERT INTO job_runs (job, started_at)
      VALUES ('poller', now() - interval '10 days')`; // unfinished (finished_at null) → kept

    const removed = await pruneJobRuns(h.jobsDb);
    expect(removed).toBe(1);
    const left = await h.adminSql`SELECT 1 FROM job_runs`;
    expect(left).toHaveLength(2);
  });

  it('finishJobRun no longer prunes on its own — a stale finished row survives a plain finish', async () => {
    await h.adminSql`INSERT INTO job_runs (job, started_at, finished_at, ok)
      VALUES ('poller', now() - interval '30 days', now() - interval '30 days', true)`;
    const id = await claimJobRun(h.jobsDb, 'anomaly-scan', 120_000, new Date());
    await finishJobRun(h.jobsDb, id!, true, {});
    // the 30-day-old row is untouched by finish (prune now rides retention, not every finish)
    const stale =
      await h.adminSql`SELECT 1 FROM job_runs WHERE finished_at < now() - interval '7 days'`;
    expect(stale).toHaveLength(1);
  });

  it('the retention job cycle prunes stale job_runs as part of its daily sweep', async () => {
    await h.adminSql`INSERT INTO job_runs (job, started_at, finished_at, ok)
      VALUES ('poller', now() - interval '10 days', now() - interval '10 days', true)`;
    const result = await runRetentionJob(deps());
    expect(result).not.toBeNull();
    // only the retention lease row itself remains (the 10-day-old poller row was pruned)
    const stale =
      await h.adminSql`SELECT 1 FROM job_runs WHERE finished_at < now() - interval '7 days'`;
    expect(stale).toHaveLength(0);
  });
});
