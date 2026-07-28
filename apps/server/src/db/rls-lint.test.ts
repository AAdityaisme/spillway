/**
 * RLS lint (unit, no DB).
 *
 * Rule: every exported pgTable that has an `org_id` column MUST be listed in
 * RLS_COVERED_TABLES (i.e. an RLS policy was authored for it in 0002_rls_policies.sql)
 * OR explicitly declared as exempt in RLS_EXEMPT_TABLES.
 *
 * This catches the "developer adds a new org-scoped table but forgets the RLS
 * migration" mistake before it reaches CI / prod.
 *
 * Tables without org_id (users, orgs, job_runs) are not subject to org-isolation RLS
 * and are correctly ignored by this lint.
 */

import { describe, it, expect } from 'vitest';
import { getTableName, getTableColumns } from 'drizzle-orm';
import * as schema from './schema.js';
import { RLS_COVERED_TABLES } from './schema.js';
import type { PgTable } from 'drizzle-orm/pg-core';

/** Type guard: is this export a Drizzle pgTable? */
function isPgTable(v: unknown): v is PgTable {
  return (
    typeof v === 'object' &&
    v !== null &&
    // Drizzle tables carry an internal Symbol('drizzle:IsDrizzleTable') flag
    // accessible via getTableName without throwing.
    (() => {
      try {
        const name = getTableName(v as PgTable);
        return typeof name === 'string' && name.length > 0;
      } catch {
        return false;
      }
    })()
  );
}

/** Returns true when the table has an org_id column. */
function hasOrgIdColumn(table: PgTable): boolean {
  const cols = getTableColumns(table);
  return 'orgId' in cols || 'org_id' in cols;
}

describe('RLS lint — every org_id table must be RLS-covered or explicitly exempt', () => {
  const tableEntries = Object.entries(schema).filter(([, v]) => isPgTable(v)) as Array<
    [string, PgTable]
  >;

  it('schema exports at least the 9 M1 tables', () => {
    expect(tableEntries.length).toBeGreaterThanOrEqual(9);
  });

  it('RLS_COVERED_TABLES and RLS_EXEMPT_TABLES are disjoint', () => {
    for (const name of RLS_COVERED_TABLES) {
      expect(schema.RLS_EXEMPT_TABLES.has(name)).toBe(false);
    }
  });

  // One test per table with an org_id column — makes failures easy to diagnose.
  for (const [exportName, table] of tableEntries) {
    if (!hasOrgIdColumn(table)) continue;

    const tableName = getTableName(table);
    it(`${exportName} (${tableName}) is RLS-covered or exempt`, () => {
      const covered = RLS_COVERED_TABLES.has(tableName);
      const exempt = schema.RLS_EXEMPT_TABLES.has(tableName);
      expect(
        covered || exempt,
        `Table "${tableName}" (exported as ${exportName}) has an org_id column but is ` +
          `neither in RLS_COVERED_TABLES nor in RLS_EXEMPT_TABLES. ` +
          `Add a policy to 0002_rls_policies.sql (or a later migration) and add the table ` +
          `name to RLS_COVERED_TABLES in this file, OR add it to RLS_EXEMPT_TABLES in ` +
          `schema.ts with a comment explaining why RLS is intentionally skipped.`,
      ).toBe(true);
    });
  }
});
