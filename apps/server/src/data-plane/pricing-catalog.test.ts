import { describe, it, expect, beforeEach } from 'vitest';
import { getActiveCatalogVersionId, resetCatalogVersionCache } from './pricing-catalog.js';
import type { DatabaseClient } from '../db/client.js';

/**
 * part-3/04: the active catalog version is a NULLABLE provenance stamp read on the reconcile spend-write
 * path. The invariant these tests pin (red-team part-3 #3): a transient read failure must degrade to null,
 * never throw — a throw here aborts the whole settle and drops the spend row (violates nothing-lost).
 */

const dbThatThrows = {
  execute: () => Promise.reject(new Error('connection reset')),
} as unknown as DatabaseClient;

const dbThatReturns = (id: string): DatabaseClient =>
  ({ execute: () => Promise.resolve([{ id }]) }) as unknown as DatabaseClient;

describe('getActiveCatalogVersionId (money-path provenance)', () => {
  beforeEach(() => resetCatalogVersionCache());

  it('fails SOFT: a transient read error resolves to null, never throws', async () => {
    await expect(getActiveCatalogVersionId(dbThatThrows, 1000)).resolves.toBeNull();
  });

  it('does not poison the cache on failure — the next reconcile re-reads and recovers', async () => {
    // A failed read must NOT cache null: the next call (same TTL window) re-queries, so once the DB
    // recovers the real version id is picked up rather than a sticky null.
    await expect(getActiveCatalogVersionId(dbThatThrows, 2000)).resolves.toBeNull();
    await expect(getActiveCatalogVersionId(dbThatReturns('v-42'), 2000)).resolves.toBe('v-42');
  });

  it('caches a successful read within the 60s TTL (a throwing DB is never consulted while warm)', async () => {
    await expect(getActiveCatalogVersionId(dbThatReturns('v-1'), 3000)).resolves.toBe('v-1');
    await expect(getActiveCatalogVersionId(dbThatThrows, 3500)).resolves.toBe('v-1');
  });

  it('returns null when the ledger is empty (legacy-safe)', async () => {
    const empty = { execute: () => Promise.resolve([]) } as unknown as DatabaseClient;
    await expect(getActiveCatalogVersionId(empty, 4000)).resolves.toBeNull();
  });
});
