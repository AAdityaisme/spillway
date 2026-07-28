-- RLS + grants for Part II §19 alerts/insights (M3; ADR-040/009). Mirrors 0006 (nullif GUC guard).
-- alerts: app-role only (CRUD). alert_events + savings_insights: app org_isolation + a _jobs policy
-- for the anomaly-scan / alert-delivery / insights jobs (they INSERT/UPDATE cross-tenant, and the
-- delivery job SELECTs undelivered events). _jobs policy FOR ALL (row scope); GRANT is the boundary.
-- model_prices / price_overrides stay GLOBAL (no org_id, no RLS) — the new tier columns inherit that.

ALTER TABLE alerts           ENABLE ROW LEVEL SECURITY;
ALTER TABLE alerts           FORCE  ROW LEVEL SECURITY;
ALTER TABLE alert_events     ENABLE ROW LEVEL SECURITY;
ALTER TABLE alert_events     FORCE  ROW LEVEL SECURITY;
ALTER TABLE savings_insights ENABLE ROW LEVEL SECURITY;
ALTER TABLE savings_insights FORCE  ROW LEVEL SECURITY;

-- alerts — app org isolation only
CREATE POLICY alerts_org_isolation ON alerts AS PERMISSIVE FOR ALL TO spillway_app
  USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

-- alert_events — app org isolation + jobs read/insert/update (anomaly-scan produces; delivery marks)
CREATE POLICY alert_events_org_isolation ON alert_events AS PERMISSIVE FOR ALL TO spillway_app
  USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
CREATE POLICY alert_events_jobs ON alert_events AS PERMISSIVE FOR ALL TO spillway_jobs
  USING (current_user = 'spillway_jobs');
GRANT SELECT, INSERT, UPDATE ON alert_events TO spillway_jobs;

-- savings_insights — app org isolation + jobs insert/update (insights job upsert)
CREATE POLICY savings_insights_org_isolation ON savings_insights AS PERMISSIVE FOR ALL TO spillway_app
  USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
CREATE POLICY savings_insights_jobs ON savings_insights AS PERMISSIVE FOR ALL TO spillway_jobs
  USING (current_user = 'spillway_jobs');
GRANT SELECT, INSERT, UPDATE ON savings_insights TO spillway_jobs;
