-- RLS + grants for Part II §18 approvals/automation/timers (M3; ADR-039). Mirrors 0006 (nullif
-- GUC guard). Poller model (18 §3.3): SCAN as spillway_jobs (targeted _jobs SELECT), APPLY as
-- spillway_app under withOrg. _jobs policies are FOR ALL (row scope); the narrow GRANT is the
-- privilege boundary (0006 convention).

ALTER TABLE approval_requests    ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_requests    FORCE  ROW LEVEL SECURITY;
ALTER TABLE approval_policies    ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_policies    FORCE  ROW LEVEL SECURITY;
ALTER TABLE approval_steps       ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_steps       FORCE  ROW LEVEL SECURITY;
ALTER TABLE approval_decisions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_decisions   FORCE  ROW LEVEL SECURITY;
ALTER TABLE approver_delegations ENABLE ROW LEVEL SECURITY;
ALTER TABLE approver_delegations FORCE  ROW LEVEL SECURITY;
ALTER TABLE automation_rules     ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_rules     FORCE  ROW LEVEL SECURITY;
ALTER TABLE automation_runs      ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_runs      FORCE  ROW LEVEL SECURITY;
ALTER TABLE workflow_timers      ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_timers      FORCE  ROW LEVEL SECURITY;

-- app org_isolation (all eight)
CREATE POLICY approval_requests_org_isolation ON approval_requests AS PERMISSIVE FOR ALL TO spillway_app
  USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
CREATE POLICY approval_policies_org_isolation ON approval_policies AS PERMISSIVE FOR ALL TO spillway_app
  USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
CREATE POLICY approval_steps_org_isolation ON approval_steps AS PERMISSIVE FOR ALL TO spillway_app
  USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
CREATE POLICY approval_decisions_org_isolation ON approval_decisions AS PERMISSIVE FOR ALL TO spillway_app
  USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
CREATE POLICY approver_delegations_org_isolation ON approver_delegations AS PERMISSIVE FOR ALL TO spillway_app
  USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
CREATE POLICY automation_rules_org_isolation ON automation_rules AS PERMISSIVE FOR ALL TO spillway_app
  USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
CREATE POLICY automation_runs_org_isolation ON automation_runs AS PERMISSIVE FOR ALL TO spillway_app
  USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
CREATE POLICY workflow_timers_org_isolation ON workflow_timers AS PERMISSIVE FOR ALL TO spillway_app
  USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

-- approval_decisions is append-only from the app role (audit posture, §2.1.4)
REVOKE UPDATE, DELETE ON approval_decisions FROM spillway_app;

-- automation_runs — jobs SELECT (scan cursor / rate-cap count; §3.3)
CREATE POLICY automation_runs_jobs ON automation_runs AS PERMISSIVE FOR ALL TO spillway_jobs
  USING (current_user = 'spillway_jobs');
GRANT SELECT ON automation_runs TO spillway_jobs;

-- workflow_timers — jobs SELECT + UPDATE (due sweep marks fired; §4.1)
CREATE POLICY workflow_timers_jobs ON workflow_timers AS PERMISSIVE FOR ALL TO spillway_jobs
  USING (current_user = 'spillway_jobs');
GRANT SELECT, UPDATE ON workflow_timers TO spillway_jobs;
