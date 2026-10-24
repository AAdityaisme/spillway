#!/usr/bin/env bash
#
# init-roles-prod.sh — create the two least-privilege DB roles with GENERATED passwords.
#
# WHY THIS EXISTS: apps/server/src/db/migrations/init-roles.sql hardcodes each role's password
# to its own name (spillway_app / spillway_app). That is deliberate and correct for local Docker
# and CI, where the database is disposable and unreachable. Running it against a production Neon
# endpoint would put a publicly-reachable Postgres behind a guessable credential.
#
# This script does the same thing with real secrets, prints the connection strings once, and
# never writes them to disk.
#
#   MIGRATION_DATABASE_URL='postgres://<owner>:<pw>@<ep>.neon.tech/neondb?sslmode=require' \
#     ./tools/db/init-roles-prod.sh
#
# Re-running rotates both passwords (ALTER ROLE), which is the intended way to rotate: run it,
# then update the Fly secrets, then redeploy.
#
set -euo pipefail

: "${MIGRATION_DATABASE_URL:?set MIGRATION_DATABASE_URL to the Neon OWNER/superuser connection string}"

command -v psql >/dev/null || { echo "psql not found (brew install libpq)" >&2; exit 1; }

# 32 URL-safe bytes. Base64 is avoided: +/= need percent-encoding inside a connection string and
# a mis-encoded password fails as an opaque auth error at boot.
# Bound the INPUT, not the output. `tr … < /dev/urandom | head -c 40` looks fine and is fatal here:
# head closes the pipe after 40 bytes, tr dies on SIGPIPE (141), `pipefail` propagates it and
# `set -e` kills the script at the FIRST assignment below — silently, before any output. Measured
# 100/100 aborts on bash 3.2. This script is step 1 of the production runbook and the only thing
# that ever puts a real generated secret on the prod roles, so "it appears to do nothing" is the
# worst possible failure: the operator's next move is to run init-roles.sql instead, which sets
# password == role name on a publicly-reachable Neon endpoint — exactly what this file exists to
# prevent. Reading a fixed 4096 bytes lets tr finish writing, and the shell slices.
gen() {
  local raw
  raw=$(LC_ALL=C tr -dc 'A-Za-z0-9' < <(head -c 4096 /dev/urandom))
  printf '%s' "${raw:0:40}"
}
APP_PW="$(gen)"
JOBS_PW="$(gen)"

echo "==> creating/rotating roles"
psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -v app_pw="$APP_PW" -v jobs_pw="$JOBS_PW" <<'SQL'
SELECT format(
  $f$
  DO $$
  BEGIN
    -- Set the password unconditionally: this script's whole job is to install a freshly
    -- generated one.
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'spillway_app') THEN
      CREATE ROLE spillway_app LOGIN PASSWORD %L;
    ELSE
      ALTER ROLE spillway_app LOGIN PASSWORD %L;
    END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'spillway_jobs') THEN
      CREATE ROLE spillway_jobs LOGIN PASSWORD %L;
    ELSE
      ALTER ROLE spillway_jobs LOGIN PASSWORD %L;
    END IF;
  END
  $$;
  $f$, :'app_pw', :'app_pw', :'jobs_pw', :'jobs_pw') \gexec

-- CONNECT uses current_database() so this is host- and db-name-agnostic.
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO spillway_app, spillway_jobs', current_database());
END
$$;
SQL

# Rebuild the two app URLs from the owner URL, swapping only the credentials.
BASE="${MIGRATION_DATABASE_URL#*@}"

echo
echo "==> Set these as Fly secrets. They are NOT stored anywhere — copy them now."
echo
echo "DATABASE_URL=postgres://spillway_app:${APP_PW}@${BASE}"
echo "DATABASE_URL_JOBS=postgres://spillway_jobs:${JOBS_PW}@${BASE}"
echo
echo "Then, in this order:"
echo "  1. fly secrets set DATABASE_URL='…' DATABASE_URL_JOBS='…' MIGRATION_DATABASE_URL='…'"
echo "  2. pnpm db:migrate      # grants + RLS; needs the OWNER url"
echo
echo "The app roles are intentionally non-superuser and subject to RLS — do not swap in the"
echo "owner URL to 'fix' a permissions error; that silently disables tenant isolation."
