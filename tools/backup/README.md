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

## GitHub Actions wiring (`.github/workflows/backup-weekly.yml`)

Until real object storage is provisioned, the workflow points `BACKUP_S3_BUCKET` at a
runner-local path and uploads that directory as a GitHub Actions artifact — the artifact
IS the Phase-0 offsite tier. Anyone with read access to the repo can download a workflow
artifact, so the dump is **encrypted with `age`** before upload: the workflow only ever
holds the `age` **public** key (repo secret `BACKUP_AGE_PUBLIC_KEY`), so a compromised
runner or a leaked artifact yields ciphertext only.

The corresponding **`age` private key must be stored OUTSIDE this repo** — in a password
manager, not in a GitHub secret, an env file, or anywhere else a CI job or a repo
collaborator could reach it. Losing that private key means losing every backup this
workflow has ever produced: there is no recovery path for an `age`-encrypted file without
its matching private key. Generate the keypair once with `age-keygen`, save the private
key to the password manager immediately, and set only the public key as
`BACKUP_AGE_PUBLIC_KEY`.
