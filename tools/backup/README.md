# tools/backup

Weekly logical dump to object storage (12-operations §5.2), independent of the
managed-Postgres PITR. `backup-weekly.sh` runs `pg_dump | gzip | rclone`, excludes
`request_bodies` (opt-in / PII-sensitive / covered by PITR), and prunes dumps >90 days.

## Usage

```bash
export DATABASE_URL='postgres://…'            # source DB
export BACKUP_S3_BUCKET='r2:spillway-backups' # rclone remote:path (R2 / S3 / B2)
tools/backup/backup-weekly.sh
```

Requires `pg_dump`, `gzip`, and a configured `rclone` remote. The script fails loudly
if a required env var or binary is missing, and always removes the local dump on exit.

## Scheduling

Stand this up before any customer data lands — do NOT wait for M6 (PITR needs portal
access and can take ~an hour to restore; this logical dump is the portable escape hatch).
Wire it via any of: a Fly scheduled machine, a GitHub Actions scheduled workflow, or a
launchd/systemd timer on a separate host. Weekly cadence; verify a restore quarterly (§5.3).
