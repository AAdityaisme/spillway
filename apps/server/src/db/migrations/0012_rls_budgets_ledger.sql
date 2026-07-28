-- RLS + grants for Part II §17 budgets/ledger (M3; ADR-035/036). Mirrors 0006 (nullif GUC guard).
-- budgets: app-role only (CRUD). request_attempts: app org isolation + a _jobs SELECT policy/grant
-- for the reporting/chargeback reads (§7). spend_counters already had RLS (0006) — the new
-- cost_source_filter column inherits it, no change here.

ALTER TABLE budgets          ENABLE ROW LEVEL SECURITY;
ALTER TABLE budgets          FORCE  ROW LEVEL SECURITY;
ALTER TABLE request_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE request_attempts FORCE  ROW LEVEL SECURITY;

-- budgets — app org isolation only
CREATE POLICY budgets_org_isolation ON budgets AS PERMISSIVE FOR ALL TO spillway_app
  USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

-- request_attempts — app org isolation + jobs SELECT (chargeback/reporting reads)
CREATE POLICY request_attempts_org_isolation ON request_attempts AS PERMISSIVE FOR ALL TO spillway_app
  USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
CREATE POLICY request_attempts_jobs ON request_attempts AS PERMISSIVE FOR ALL TO spillway_jobs
  USING (current_user = 'spillway_jobs');
GRANT SELECT ON request_attempts TO spillway_jobs;
