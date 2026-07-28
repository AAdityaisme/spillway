-- Grant least-privilege access to the two application roles (03-data-model §1.x).
-- Requires a superuser connection (MIGRATION_DATABASE_URL).
-- Uses current_database() where applicable so this migration is host-agnostic
-- (Neon, local Docker, etc.) — no hardcoded database name.

-- CONNECT on the current database (dynamic, avoids hardcoding 'spillway_dev')
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO spillway_app, spillway_jobs', current_database());
END
$$;

-- ── spillway_app: online request path ─────────────────────────────────────────
GRANT USAGE ON SCHEMA public TO spillway_app;

-- Full DML on all currently existing tables
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO spillway_app;

-- Sequence access (bigint identity on audit_log, future sequences)
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO spillway_app;

-- audit_log is append-only from the app role (no UPDATE or DELETE allowed)
REVOKE UPDATE, DELETE ON audit_log FROM spillway_app;

-- Future tables/sequences inherit the same grants automatically
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO spillway_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO spillway_app;

-- ── spillway_jobs: background workers ──────────────────────────────────────────
GRANT USAGE ON SCHEMA public TO spillway_jobs;

-- Read access for M1 tables (cross-tenant access gated by targeted RLS policies)
GRANT SELECT ON orgs, org_members, teams, virtual_keys, admin_api_keys, provider_keys, users
  TO spillway_jobs;

-- job_runs: workers record their own heartbeat/result
GRANT INSERT, UPDATE ON job_runs TO spillway_jobs;

-- audit_log: jobs may append audit events
GRANT INSERT ON audit_log TO spillway_jobs;
