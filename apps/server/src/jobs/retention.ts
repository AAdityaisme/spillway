import { sql } from 'drizzle-orm';
import type { DatabaseClient } from '../db/client.js';
import { asJobs } from '../db/jobs.js';

/**
 * Retention sweeper (12-operations; 03 §retention; 16 §7.5). Cross-org on the jobs role —
 * the `_jobs` RLS policies scope exactly what it may touch. Four passes, in order:
 *
 *  1. request_bodies past their own `expires_at` (stamped at write from body_retention_days).
 *  2. requests past the org's `metadata_retention_days` (FK-cascades any remaining body row).
 *     request_attempts are NOT swept — the billing ledger outlives request metadata.
 *  3. decision_logs past the same per-org metadata window.
 *  4. routing_config_snapshots GC (16 §7.5): a snapshot row is live while ANY surviving
 *     requests or decision_logs row of the SAME org stamps its hash. The age floor keeps a
 *     just-written snapshot safe while its first referencing row is still in flight
 *     (reconcile is post-response; "never GC a hash still stamped on a live row").
 */

export interface RetentionResult {
  bodies: number;
  requests: number;
  decisionLogs: number;
  snapshots: number;
}

const SNAPSHOT_MIN_AGE = '1 day';

// Batched-delete cap (audit M30). A retention-window drop (e.g. 365→30 days) can delete ~11 months of
// requests + cascaded bodies. One unbounded DELETE would hold a long transaction, block, and bloat;
// a mid-sweep lease-steal after 4h would then compound it. Each batch is its own short transaction so
// every statement is short and re-entrant and progress survives a restart.
const BATCH = 5_000;
const MAX_BATCHES = 10_000; // hard stop against a runaway loop (10k × 5k = 50M rows/pass ceiling)

function count(res: unknown): number {
  return Number((res as { count?: number }).count ?? 0);
}

/**
 * Delete rows matching `where` in bounded batches, each in its own transaction, until a batch
 * removes fewer than a full batch. Uses `ctid` (physical row id) for the LIMIT selection so it works
 * uniformly across tables with single-column, composite, or no natural surrogate key.
 */
async function deleteInBatches(
  jobsDb: DatabaseClient,
  table: string,
  where: ReturnType<typeof sql>,
  batchSize: number,
): Promise<number> {
  let total = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const removed = await asJobs(jobsDb, async (tx) => {
      const res = await tx.execute(sql`
        delete from ${sql.raw(table)}
         where ctid in (
           select ctid from ${sql.raw(table)} where ${where} limit ${batchSize}
         )`);
      return count(res);
    });
    total += removed;
    if (removed < batchSize) break;
  }
  return total;
}

/** `batchSize` is injectable so a test can force the multi-batch loop cheaply; prod uses BATCH. */
export async function runRetentionSweep(
  jobsDb: DatabaseClient,
  batchSize: number = BATCH,
): Promise<RetentionResult> {
  // Four passes, each batched in its own short transactions (audit M30). Order is preserved:
  // bodies first, then requests (FK-cascades any remaining body row), then decision_logs, then the
  // snapshot GC — which reads requests/decision_logs and so must run after they're pruned.
  const bodies = await deleteInBatches(
    jobsDb,
    'request_bodies',
    sql`expires_at < now()`,
    batchSize,
  );

  const requests = await deleteInBatches(
    jobsDb,
    'requests',
    sql`exists (
      select 1 from orgs o
       where o.id = requests.org_id
         and requests.created_at < now() - make_interval(days => o.metadata_retention_days))`,
    batchSize,
  );

  const decisionLogs = await deleteInBatches(
    jobsDb,
    'decision_logs',
    sql`exists (
      select 1 from orgs o
       where o.id = decision_logs.org_id
         and decision_logs.created_at < now() - make_interval(days => o.metadata_retention_days))`,
    batchSize,
  );

  const snapshots = await deleteInBatches(
    jobsDb,
    'routing_config_snapshots',
    sql`routing_config_snapshots.created_at < now() - interval ${sql.raw(`'${SNAPSHOT_MIN_AGE}'`)}
      and not exists (
        select 1 from requests r
         where r.org_id = routing_config_snapshots.org_id
           and r.config_snapshot_hash = routing_config_snapshots.hash)
      and not exists (
        select 1 from decision_logs d
         where d.org_id = routing_config_snapshots.org_id
           and d.config_snapshot_hash = routing_config_snapshots.hash)`,
    batchSize,
  );

  return { bodies, requests, decisionLogs, snapshots };
}
