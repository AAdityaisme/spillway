#!/usr/bin/env bash
#
# tools/backup/backup-weekly.sh — weekly logical dump to object storage (12-operations §5.2).
#
# A portable backup independent of the managed-Postgres PITR (which needs portal access and can take
# ~an hour to restore). This is the escape hatch: pg_dump | gzip | rclone → R2/S3, pruned to 90 days.
# `request_bodies` is excluded (opt-in, PII-sensitive, covered by PITR, and dominates dump size).
#
# Run weekly via cron / a Fly scheduled machine / a GitHub Actions scheduled workflow / a launchd or
# systemd timer on a separate host. Do NOT gate this on M6 — stand it up before any customer data lands.
#
# Requires: pg_dump, gzip, rclone (rclone remote pre-configured for the target bucket).
# Env: DATABASE_URL (source), BACKUP_S3_BUCKET (rclone remote:path, e.g. r2:spillway-backups).
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required (the database to dump)}"
: "${BACKUP_S3_BUCKET:?BACKUP_S3_BUCKET is required (rclone remote:path, e.g. r2:spillway-backups)}"

for bin in pg_dump gzip rclone; do
  command -v "$bin" >/dev/null 2>&1 || { echo "FATAL: '$bin' not found in PATH" >&2; exit 1; }
done

TIMESTAMP="$(date -u +"%Y%m%dT%H%M%SZ")"
DUMP_FILE="$(mktemp -t "spillway-${TIMESTAMP}.XXXXXX.sql.gz")"
# Always remove the local dump, even on failure — it may contain live data.
trap 'rm -f "${DUMP_FILE}"' EXIT

echo "Dumping Postgres → ${DUMP_FILE} ..."
pg_dump "${DATABASE_URL}" \
  --no-owner \
  --no-acl \
  --exclude-table='request_bodies' \
  | gzip > "${DUMP_FILE}"

echo "Uploading → ${BACKUP_S3_BUCKET}/weekly/${TIMESTAMP}.sql.gz ..."
rclone copyto "${DUMP_FILE}" "${BACKUP_S3_BUCKET}/weekly/${TIMESTAMP}.sql.gz"

echo "Pruning weekly backups older than 90 days ..."
rclone delete "${BACKUP_S3_BUCKET}/weekly/" --min-age 90d

echo "Backup complete: ${TIMESTAMP}"
