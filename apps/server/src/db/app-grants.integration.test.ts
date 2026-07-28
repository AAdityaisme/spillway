import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { makeTestApp, type TestHarness } from '../../test/helpers/app.js';

/**
 * spillway_app privilege boundary on GLOBAL reference/ledger tables (red-team money/isolation audit).
 *
 * These tables have no org_id, so RLS does NOT gate them — the table-level GRANT is the only boundary.
 * 0001's `ALTER DEFAULT PRIVILEGES ... GRANT SELECT,INSERT,UPDATE,DELETE ... TO spillway_app` auto-grants
 * the online request-path role blanket DML on every future table, and the creating migrations
 * (0027/0029/0030) GRANTed only SELECT without revoking the inherited writes. 0031 revokes them (mirroring
 * 0007 for model_prices/price_overrides). The request-path role MUST be read-only on all of them: a write
 * here would let a request-path bug/injection forge model_registry rows (routing/residency/pricing),
 * tamper the immutable price-catalog ledger (reproducible billing), or forge a PASS certifier_results row
 * (/v1/models would advertise + route to a non-certified model). Writes belong to spillway_jobs only.
 */
const READ_ONLY_FOR_APP = [
  'model_prices',
  'price_overrides',
  'model_registry',
  'model_registry_params',
  'price_catalog_versions',
  'price_catalog_snapshots',
  'certifier_results',
];

describe('spillway_app privilege boundary — read-only on global reference/ledger tables', () => {
  let h: TestHarness;
  let grants: Record<string, Set<string>>;

  beforeAll(async () => {
    h = await makeTestApp();
    const rows = await h.adminSql<{ table_name: string; privilege_type: string }[]>`
      SELECT table_name, privilege_type
        FROM information_schema.role_table_grants
       WHERE grantee = 'spillway_app' AND table_schema = 'public'
         AND table_name = ANY(${READ_ONLY_FOR_APP})`;
    grants = {};
    for (const r of rows) (grants[r.table_name] ??= new Set()).add(r.privilege_type);
  });
  afterAll(async () => {
    await h.close();
  });

  it.each(READ_ONLY_FOR_APP)('%s: spillway_app can SELECT but has no write DML', (table) => {
    const privs = grants[table] ?? new Set<string>();
    expect(privs.has('SELECT')).toBe(true); // request path still reads
    for (const w of ['INSERT', 'UPDATE', 'DELETE']) expect(privs.has(w)).toBe(false);
  });
});
