import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { makeTestApp, type TestHarness } from '../../test/helpers/app.js';

/**
 * spillway_jobs privilege boundary (expanded-audit MED).
 *
 * The _jobs RLS policies are unconditional (`FOR ALL TO spillway_jobs USING (current_user =
 * 'spillway_jobs')`) — they do NOT scope by org. What actually bounds the background-worker blast
 * radius is the narrow table-level GRANT set, and nothing enforced it: an over-broad `GRANT` on a new
 * table would silently give jobs all-org DML. This test snapshots spillway_jobs' grants against a
 * frozen allow-list, so widening the boundary requires a deliberate, reviewed change to EXPECTED_GRANTS
 * below (mirrors the GRANTs in 0005/0011/0014/0017 + init-roles). Update this together with the grant.
 */
const EXPECTED_GRANTS: Record<string, string[]> = {
  // M1 read path (0001_grant_roles.sql): SELECT on the M1 tables for reporting/insights. Table-level
  // GRANT only — cross-tenant row access is still gated by whether the table has a _jobs RLS policy
  // (most M1 tables don't, so RLS denies jobs rows despite the GRANT). Not org-scoped: orgs, users.
  orgs: ['SELECT'],
  users: ['SELECT'],
  org_members: ['SELECT'],
  teams: ['SELECT'],
  virtual_keys: ['SELECT'],
  admin_api_keys: ['SELECT'],
  provider_keys: ['SELECT'],
  job_runs: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
  requests: ['SELECT', 'DELETE'],
  request_bodies: ['SELECT', 'DELETE'],
  request_attempts: ['SELECT'],
  audit_log: ['INSERT'],
  spend_counters: ['SELECT'],
  model_aliases: ['SELECT'],
  routing_rules: ['SELECT'],
  decision_logs: ['SELECT', 'DELETE'],
  routing_config_snapshots: ['SELECT', 'DELETE'],
  automation_runs: ['SELECT'],
  workflow_timers: ['SELECT', 'UPDATE'],
  // 0025_alerts_jobs_read.sql: the error-rate/anomaly producers read enabled alerts cross-org under
  // the jobs role (fetchEnabledErrorRateAlerts) — SELECT only, gated by the alerts_jobs _jobs policy.
  alerts: ['SELECT'],
  alert_events: ['SELECT', 'INSERT', 'UPDATE'],
  savings_insights: ['SELECT', 'INSERT', 'UPDATE'],
  model_prices: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
  price_overrides: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
  // 0027_model_registry.sql: the registry sync job (spillway_jobs) owns writes to the global registry
  // tables; the active-view is SELECT-only. app reads; no org_id → no RLS (model_prices precedent).
  model_registry: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
  model_registry_params: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
  v_model_registry_active: ['SELECT'],
  // 0029_price_catalog_ledger.sql: the sync job appends immutable versions + snapshots (INSERT only —
  // append-only, no UPDATE/DELETE); the app reads them for historical reproduction.
  price_catalog_versions: ['SELECT', 'INSERT'],
  price_catalog_snapshots: ['SELECT', 'INSERT'],
  // 0030_certifier_results.sql: the nightly smoke job writes results; the app reads them for /v1/models.
  certifier_results: ['SELECT', 'INSERT'],
};

const norm = (privs: string[]): string => [...new Set(privs)].sort().join(',');

describe('spillway_jobs privilege boundary — grants match the frozen allow-list', () => {
  let h: TestHarness;
  let actual: Record<string, string[]>;

  beforeAll(async () => {
    h = await makeTestApp();
    const rows = await h.adminSql<{ table_name: string; privilege_type: string }[]>`
      SELECT table_name, privilege_type
        FROM information_schema.role_table_grants
       WHERE grantee = 'spillway_jobs' AND table_schema = 'public'`;
    actual = {};
    for (const r of rows) (actual[r.table_name] ??= []).push(r.privilege_type);
  });
  afterAll(async () => {
    await h.close();
  });

  it('grants no privilege on any table outside the allow-list', () => {
    const unexpected = Object.keys(actual)
      .filter((t) => !(t in EXPECTED_GRANTS))
      .sort();
    expect(
      unexpected,
      `spillway_jobs was granted access to unlisted table(s): ${unexpected.join(', ')}. ` +
        `A new _jobs grant widens the background-worker blast radius — add it to EXPECTED_GRANTS ` +
        `only after confirming the job that needs it.`,
    ).toEqual([]);
  });

  it('every table in the allow-list has EXACTLY the expected privileges (no silent widening)', () => {
    for (const [table, expected] of Object.entries(EXPECTED_GRANTS)) {
      expect(actual[table], `spillway_jobs is missing all grants on ${table}`).toBeDefined();
      expect(norm(actual[table] ?? []), `spillway_jobs privileges on ${table} drifted`).toBe(
        norm(expected),
      );
    }
  });
});
