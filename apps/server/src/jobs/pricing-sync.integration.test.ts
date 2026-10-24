import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { makeTestApp, type TestHarness } from '../../test/helpers/app.js';
import { runPricingSyncJob, type SchedulerDeps } from './scheduler.js';

/**
 * pricing-sync as a leased scheduler job (ch12 §7, ADR-010): the vendored-snapshot upsert
 * runs on the spillway_jobs role (proving the global-price-table grants), the lease is
 * exclusive, and the fresh-skip guard prevents boot-time rewrites.
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
  await h.adminSql`TRUNCATE model_prices`;
});

describe('pricing-sync job', () => {
  it('empty table → full sync as spillway_jobs; job_runs row ok=true with detail', async () => {
    const result = await runPricingSyncJob(deps());
    expect(result).not.toBeNull();
    expect(result!.synced).toBeGreaterThan(0);
    expect(result!.skipped).toBeUndefined();

    const rows = await h.adminSql`SELECT count(*)::int AS count FROM model_prices`;
    expect(rows[0]!.count).toBe(result!.synced);

    const runs = await h.adminSql`
      SELECT ok, detail FROM job_runs WHERE job = 'pricing-sync' AND finished_at IS NOT NULL`;
    expect(runs).toHaveLength(1);
    expect(runs[0]!.ok).toBe(true);
    expect((runs[0]!.detail as { synced: number }).synced).toBe(result!.synced);
  });

  it('fresh prices → skip (no rewrite), detail says fresh with a real age', async () => {
    const first = await runPricingSyncJob(deps());
    expect(first!.synced).toBeGreaterThan(0);
    await h.adminSql`TRUNCATE job_runs`; // free the lease for the second run

    const second = await runPricingSyncJob(deps());
    expect(second).not.toBeNull();
    expect(second!.skipped).toBe('fresh');
    expect(second!.synced).toBe(0);
    expect(second!.ageHours).toBeGreaterThanOrEqual(0);
    expect(second!.ageHours).toBeLessThan(20);
  });

  it('stale prices (>20h) → re-syncs instead of skipping', async () => {
    await runPricingSyncJob(deps());
    await h.adminSql`TRUNCATE job_runs`;
    await h.adminSql`UPDATE model_prices SET synced_at = now() - interval '30 hours'`;

    const result = await runPricingSyncJob(deps());
    expect(result!.skipped).toBeUndefined();
    expect(result!.synced).toBeGreaterThan(0);
    expect(result!.ageHours).toBeGreaterThan(20);
  });

  it('held lease → null (exclusive claim)', async () => {
    const [a, b] = await Promise.all([runPricingSyncJob(deps()), runPricingSyncJob(deps())]);
    expect([a, b].filter((r) => r !== null)).toHaveLength(1);
  });
});
