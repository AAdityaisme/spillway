import type { DatabaseClient } from './client.js';
import type { Tx } from './tenancy.js';

/**
 * Cross-org job scope (Part II §18 §3.3). Runs `fn` in a transaction on the spillway_jobs connection,
 * which sees rows across ALL orgs — the `_jobs` RLS policies are `USING (current_user = 'spillway_jobs')`
 * (not the org GUC), so NO `set_config('app.current_org_id', …)` is issued. This is the ONLY sanctioned
 * cross-org read path (the scan half of the poller / timers sweep); the per-event APPLY switches back
 * to `withOrg` on the app role. The narrow `_jobs` GRANTs are the privilege boundary.
 */
export async function asJobs<T>(jobsDb: DatabaseClient, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return jobsDb.transaction(fn);
}
