import { sql } from 'drizzle-orm';
import { parseUsd } from '@spillway/pricing';
import { withOrg } from '../../db/tenancy.js';
import type { DatabaseClient } from '../../db/client.js';
import type { CounterTuple } from './resolver.js';

/**
 * The hoisted counter read (17 §3.1, ADR-038). ONE indexed PK-lookup batched over the ≤8 calendar
 * tuples (+1 per rolling budget) of resolveBudgetBundle, under the org GUC (RLS'd table). Feeds
 * BUDGET (§2) as a pure compare and spend-conditioned DENY (16) — both need FRESH spend (a hard
 * block must be exact; stale spend = overspend/compliance breach, §3.2).
 *
 * Absent tuples → 0n (lazy counter). Refit to V2's withOrg + drizzle (the lab used raw postgres).
 */

export type SpendSnapshot = ReadonlyMap<string, bigint>;

interface CounterRow {
  scope_type: string;
  scope_id: string;
  period_key: string;
  spent_usd: string;
}

export async function readSpendSnapshot(
  db: DatabaseClient,
  orgId: string,
  tuples: CounterTuple[],
): Promise<SpendSnapshot> {
  if (tuples.length === 0) return new Map();

  // Single jsonb param (robust across the drizzle/postgres-js array-binding path) → recordset join.
  const tuplesJson = JSON.stringify(
    tuples.map((t) => ({
      scope_type: t.scopeType,
      scope_id: t.scopeId,
      period_key: t.periodKey,
    })),
  );

  return withOrg(db, orgId, async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT c.scope_type, c.scope_id, c.period_key, c.spent_usd
      FROM spend_counters c
      JOIN jsonb_to_recordset(${tuplesJson}::jsonb)
        AS t(scope_type text, scope_id uuid, period_key text)
        ON c.scope_type = t.scope_type
       AND c.scope_id = t.scope_id
       AND c.period_key = t.period_key`)) as unknown as CounterRow[];

    const map = new Map<string, bigint>();
    for (const r of rows) {
      map.set(`${r.scope_type}:${r.scope_id}:${r.period_key}`, parseUsd(r.spent_usd));
    }
    return map;
  });
}
