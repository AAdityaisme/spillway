-- 0025: let the error-rate alert producer (M5.3) read alert configs cross-org.
-- The producer runs on the anomaly-scan lease (spillway_jobs role). `alerts` was intentionally
-- app-role-only (0017); the error_rate producer must enumerate enabled error_rate alerts across orgs
-- to evaluate + fire them. Add a SELECT-only `_jobs` RLS policy + GRANT, mirroring alert_events_jobs.
-- SELECT only: the producer never mutates alert configs — the narrow GRANT is the privilege boundary.
CREATE POLICY alerts_jobs ON alerts AS PERMISSIVE FOR SELECT TO spillway_jobs
  USING (current_user = 'spillway_jobs');
GRANT SELECT ON alerts TO spillway_jobs;
