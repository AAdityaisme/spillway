-- M2 table grants for spillway_jobs (background workers). spillway_app is already
-- covered by the ALTER DEFAULT PRIVILEGES in 0001 (new tables auto-grant to app);
-- spillway_jobs was NOT in those defaults, so its access is granted explicitly here.

-- reporting / insights (read-only)
GRANT SELECT ON requests, spend_counters, model_aliases, routing_rules TO spillway_jobs;

-- retention sweeper deletes expired bodies
GRANT SELECT, DELETE ON request_bodies TO spillway_jobs;

-- pricing-sync job maintains the global price tables (no RLS — global reference data)
GRANT SELECT, INSERT, UPDATE, DELETE ON model_prices, price_overrides TO spillway_jobs;
