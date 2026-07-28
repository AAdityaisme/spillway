-- Least-privilege (red-team: schema): model_prices / price_overrides are GLOBAL,
-- un-RLS'd reference data that feeds computeCost for EVERY tenant. The online
-- request-path role (spillway_app) only needs to READ them; it got blanket DML via
-- the 0001 ALTER DEFAULT PRIVILEGES. Revoke writes so a request-path bug/injection
-- cannot tamper with all-tenant pricing. Writes stay with spillway_jobs (pricing-sync).
REVOKE INSERT, UPDATE, DELETE ON model_prices, price_overrides FROM spillway_app;
