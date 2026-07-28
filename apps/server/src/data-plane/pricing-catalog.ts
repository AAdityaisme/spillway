import { sql } from 'drizzle-orm';
import type { DatabaseClient } from '../db/client.js';

/**
 * The active price-catalog version id (part-3/04) — stamped onto each request so its cost re-derives
 * from the immutable snapshot, not the mutable live table. The latest APPROVED/auto-approved version by
 * effective_from. Process-cached (60 s; the ledger changes only on a sync run) so reconcile pays at most
 * one read per window. NULL when the ledger is empty (legacy-safe — model_prices is still authoritative).
 */

const TTL_MS = 60_000;
let cache: { id: string | null; at: number } | null = null;

/** Test seam — drop the cache so a freshly-written version is picked up on the next call. */
export function resetCatalogVersionCache(): void {
  cache = null;
}

export async function getActiveCatalogVersionId(
  db: DatabaseClient,
  now: number,
): Promise<string | null> {
  if (cache && now - cache.at < TTL_MS) return cache.id;
  let rows: { id: string }[];
  try {
    rows = (await db.execute(sql`
      SELECT id FROM price_catalog_versions
       WHERE approval_state IN ('auto_approved','approved') AND effective_from <= now()
       ORDER BY effective_from DESC LIMIT 1`)) as unknown as { id: string }[];
  } catch {
    // Fail-SOFT on the money path (part-3/04): this id is a NULLABLE provenance stamp — the column
    // is null-until-first-sync anyway. A transient read blip must NOT propagate, or it would abort the
    // whole reconcile settle and drop the spend row (violating nothing-lost). Degrade to null and leave
    // the cache untouched so the very next reconcile re-reads (never poison the cache with an error).
    return null;
  }
  const id = rows[0]?.id ?? null;
  cache = { id, at: now };
  return id;
}
