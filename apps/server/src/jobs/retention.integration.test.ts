import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { makeTestApp, type TestHarness } from '../../test/helpers/app.js';
import { runRetentionSweep } from './retention.js';
import { upsertConfigSnapshot } from '../data-plane/policy/config-snapshot.js';

/**
 * Retention sweeper (ch12 / 03 §retention / 16 §7.5) against real RLS Postgres on the jobs
 * role: per-org windows honored, the billing ledger survives, snapshot GC respects liveness
 * and the per-org content-address boundary.
 */

let h: TestHarness;
const orgA = randomUUID(); // metadata_retention_days = 30
const orgB = randomUUID(); // metadata_retention_days = 365

async function seedRequest(
  orgId: string,
  ageDays: number,
  opts: { hash?: string; body?: boolean } = {},
): Promise<string> {
  const id = randomUUID();
  await h.adminSql`
    INSERT INTO requests (id, org_id, endpoint, status, stream, created_at, config_snapshot_hash)
    VALUES (${id}, ${orgId}, 'chat_completions', 'ok', false,
            now() - make_interval(days => ${ageDays}), ${opts.hash ?? null})`;
  await h.adminSql`
    INSERT INTO request_attempts (request_id, attempt_number, org_id, outcome, cost_usd)
    VALUES (${id}, 0, ${orgId}, 'ok', 0.001)`;
  if (opts.body) {
    await h.adminSql`
      INSERT INTO request_bodies (request_id, org_id, prompt, expires_at)
      VALUES (${id}, ${orgId}, '{"m":1}'::jsonb, now() - interval '1 day')`;
  }
  return id;
}

async function seedSnapshot(orgId: string, hash: string, ageDays: number): Promise<void> {
  await h.adminSql`
    INSERT INTO routing_config_snapshots (org_id, hash, config, created_at)
    VALUES (${orgId}, ${hash}, '{}'::jsonb, now() - make_interval(days => ${ageDays}))`;
}

beforeAll(async () => {
  h = await makeTestApp();
  await h.adminSql`INSERT INTO orgs (id, name, slug, metadata_retention_days)
    VALUES (${orgA}, 'A', ${'ra-' + orgA.slice(0, 8)}, 30),
           (${orgB}, 'B', ${'rb-' + orgB.slice(0, 8)}, 365)`;
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.adminSql`TRUNCATE requests, request_bodies, request_attempts, decision_logs, routing_config_snapshots`;
});

describe('retention sweeper', () => {
  it('honors per-org metadata windows; the attempts ledger survives the sweep', async () => {
    const oldA = await seedRequest(orgA, 60); // past A's 30d window
    const freshA = await seedRequest(orgA, 5);
    const oldB = await seedRequest(orgB, 60); // within B's 365d window

    const r = await runRetentionSweep(h.jobsDb);
    expect(r.requests).toBe(1);

    const ids = (await h.adminSql<{ id: string }[]>`SELECT id FROM requests`).map((x) => x.id);
    expect(ids.sort()).toEqual([freshA, oldB].sort());
    // billing ledger untouched — all three attempt rows survive, incl. the swept request's
    const attempts = await h.adminSql`SELECT 1 FROM request_attempts`;
    expect(attempts).toHaveLength(3);
    void oldA;
  });

  it('sweeps expired bodies without touching their requests row', async () => {
    await seedRequest(orgA, 10, { body: true }); // body expired yesterday → swept
    const r = await runRetentionSweep(h.jobsDb);
    expect(r.bodies).toBe(1);
    expect(r.requests).toBe(0);
    expect(await h.adminSql`SELECT 1 FROM requests`).toHaveLength(1);
    expect(await h.adminSql`SELECT 1 FROM request_bodies`).toHaveLength(0);
  });

  it('GCs only unreferenced, aged snapshots — per-org liveness (16 §7.5)', async () => {
    await seedSnapshot(orgA, 'h-live', 30);
    await seedSnapshot(orgA, 'h-dead', 30);
    await seedSnapshot(orgB, 'h-live', 30); // same hash, other org — must be judged on B's rows only
    await seedSnapshot(orgA, 'h-young', 0); // unreferenced but inside the age floor
    await seedRequest(orgA, 5, { hash: 'h-live' });

    const r = await runRetentionSweep(h.jobsDb);
    expect(r.snapshots).toBe(2); // A's h-dead + B's h-live (B has no referencing rows)

    const left = await h.adminSql<{ org_id: string; hash: string }[]>`
      SELECT org_id, hash FROM routing_config_snapshots ORDER BY hash`;
    expect(left.map((x) => `${x.org_id === orgA ? 'A' : 'B'}:${x.hash}`).sort()).toEqual([
      'A:h-live',
      'A:h-young',
    ]);
  });

  it('deletes across MULTIPLE bounded batches — total count is correct, nothing left behind (M30)', async () => {
    // 7 old requests past A's 30d window, swept with batchSize=2 → forces 4 batch iterations.
    for (let i = 0; i < 7; i++) await seedRequest(orgA, 60);
    const freshA = await seedRequest(orgA, 5); // inside the window → survives

    const r = await runRetentionSweep(h.jobsDb, 2);
    expect(r.requests).toBe(7); // all 7 across 4 batches, counted correctly

    const ids = (await h.adminSql<{ id: string }[]>`SELECT id FROM requests`).map((x) => x.id);
    expect(ids).toEqual([freshA]); // only the in-window row remains
  });

  it('a re-used snapshot refreshes its age and survives GC even if first-created long ago (red-team)', async () => {
    // First-created 30 days ago, ZERO referencing rows → would be reaped by the age floor...
    await seedSnapshot(orgA, 'h-reused', 30);
    // ...but a fresh cache-fill re-upserts it (production path) → created_at bumped to now (last-use).
    await upsertConfigSnapshot(h.db, orgA, { hash: 'h-reused', config: {} });

    const r = await runRetentionSweep(h.jobsDb);
    expect(r.snapshots).toBe(0); // NOT reaped — last-use is fresh
    const left =
      await h.adminSql`SELECT 1 FROM routing_config_snapshots WHERE org_id = ${orgA} AND hash = 'h-reused'`;
    expect(left).toHaveLength(1);
  });
});
