-- RLS + grants for Part II §16 governance tables (M3; ADR-034/041). Mirrors 0006_rls_m2 incl. the
-- mandatory nullif GUC guard (ADR-026(1)): a pooled postgres-js conn reverts a tx-local
-- set_config to '' and a bare ''::uuid throws instead of deny-by-default.
--
-- governance_policies: app-role only (never job-touched → no _jobs policy/grant).
-- decision_logs + routing_config_snapshots: additionally a _jobs policy for the cross-tenant
-- retention sweeper / snapshot-GC (§6.6/§7.5). The _jobs POLICY is FOR ALL (row scope), but the
-- privilege boundary is the narrow GRANT below (SELECT, DELETE only) — the 0006 convention.

ALTER TABLE governance_policies      ENABLE ROW LEVEL SECURITY;
ALTER TABLE governance_policies      FORCE  ROW LEVEL SECURITY;
ALTER TABLE decision_logs            ENABLE ROW LEVEL SECURITY;
ALTER TABLE decision_logs            FORCE  ROW LEVEL SECURITY;
ALTER TABLE routing_config_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE routing_config_snapshots FORCE  ROW LEVEL SECURITY;

-- governance_policies — app org isolation only
CREATE POLICY governance_policies_org_isolation ON governance_policies AS PERMISSIVE FOR ALL TO spillway_app
  USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

-- decision_logs — app org isolation + jobs read/delete (retention sweeper, §6.6)
CREATE POLICY decision_logs_org_isolation ON decision_logs AS PERMISSIVE FOR ALL TO spillway_app
  USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
CREATE POLICY decision_logs_jobs ON decision_logs AS PERMISSIVE FOR ALL TO spillway_jobs
  USING (current_user = 'spillway_jobs');
GRANT SELECT, DELETE ON decision_logs TO spillway_jobs;

-- routing_config_snapshots — app org isolation + jobs read/delete (snapshot GC, §7.5)
CREATE POLICY routing_config_snapshots_org_isolation ON routing_config_snapshots AS PERMISSIVE FOR ALL TO spillway_app
  USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
CREATE POLICY routing_config_snapshots_jobs ON routing_config_snapshots AS PERMISSIVE FOR ALL TO spillway_jobs
  USING (current_user = 'spillway_jobs');
GRANT SELECT, DELETE ON routing_config_snapshots TO spillway_jobs;
