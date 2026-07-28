-- apps/server/src/db/migrations/init-roles.sql
-- Creates the two least-privilege roles expected by tenancy.ts and RLS policies.
-- Safe to re-run: uses CREATE ROLE IF NOT EXISTS.
DO $$
BEGIN
  -- password MUST equal what the app connects with (db.ts withCredentials + testcontainers
  -- APP_ROLE_SQL both use 'spillway_app'). A mismatch makes every app-role query fail auth in
  -- CI → 503 (data-plane fail-closed) / 500 (control-plane), while local testcontainers pass.
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'spillway_app') THEN
    CREATE ROLE spillway_app LOGIN PASSWORD 'spillway_app';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'spillway_jobs') THEN
    CREATE ROLE spillway_jobs LOGIN PASSWORD 'spillway_jobs';
  END IF;
END
$$;
-- CONNECT grant uses current_database() to avoid hardcoding 'spillway_dev'
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO spillway_app, spillway_jobs', current_database());
END
$$;
-- Table-level grants run via drizzle-kit migrations (separate grant migration file).
