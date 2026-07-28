-- RLS for M2 org-scoped tables (mirrors 0002, incl the nullif GUC guard from ADR-026).
-- model_prices / price_overrides are GLOBAL reference data (no org_id) — intentionally
-- NOT covered (rls-lint only flags org_id tables).

ALTER TABLE requests        ENABLE ROW LEVEL SECURITY;
ALTER TABLE requests        FORCE  ROW LEVEL SECURITY;
ALTER TABLE request_bodies  ENABLE ROW LEVEL SECURITY;
ALTER TABLE request_bodies  FORCE  ROW LEVEL SECURITY;
ALTER TABLE spend_counters  ENABLE ROW LEVEL SECURITY;
ALTER TABLE spend_counters  FORCE  ROW LEVEL SECURITY;
ALTER TABLE model_aliases   ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_aliases   FORCE  ROW LEVEL SECURITY;
ALTER TABLE routing_rules   ENABLE ROW LEVEL SECURITY;
ALTER TABLE routing_rules   FORCE  ROW LEVEL SECURITY;

-- requests
CREATE POLICY requests_org_isolation ON requests AS PERMISSIVE FOR ALL TO spillway_app
  USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
CREATE POLICY requests_jobs ON requests AS PERMISSIVE FOR ALL TO spillway_jobs
  USING (current_user = 'spillway_jobs');

-- request_bodies
CREATE POLICY request_bodies_org_isolation ON request_bodies AS PERMISSIVE FOR ALL TO spillway_app
  USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
CREATE POLICY request_bodies_jobs ON request_bodies AS PERMISSIVE FOR ALL TO spillway_jobs
  USING (current_user = 'spillway_jobs');

-- spend_counters
CREATE POLICY spend_counters_org_isolation ON spend_counters AS PERMISSIVE FOR ALL TO spillway_app
  USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
CREATE POLICY spend_counters_jobs ON spend_counters AS PERMISSIVE FOR ALL TO spillway_jobs
  USING (current_user = 'spillway_jobs');

-- model_aliases
CREATE POLICY model_aliases_org_isolation ON model_aliases AS PERMISSIVE FOR ALL TO spillway_app
  USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
CREATE POLICY model_aliases_jobs ON model_aliases AS PERMISSIVE FOR ALL TO spillway_jobs
  USING (current_user = 'spillway_jobs');

-- routing_rules
CREATE POLICY routing_rules_org_isolation ON routing_rules AS PERMISSIVE FOR ALL TO spillway_app
  USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
CREATE POLICY routing_rules_jobs ON routing_rules AS PERMISSIVE FOR ALL TO spillway_jobs
  USING (current_user = 'spillway_jobs');
