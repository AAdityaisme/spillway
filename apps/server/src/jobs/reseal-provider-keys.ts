import { and, asc, eq, gt, lt, sql } from 'drizzle-orm';
import { loadConfig } from '../config.js';
import { makeDb, type DatabaseClient } from '../db/client.js';
import { asJobs } from '../db/jobs.js';
import { providerKeys } from '../db/schema.js';
import { withOrg } from '../db/tenancy.js';
import { makeEncryptor, providerKeyAad, type Encryptor } from '../services/encryptor.js';

/**
 * PROVIDER-KEY RE-SEAL — the write half of encryption-key rotation (ADR-014, 10-security §3).
 *
 * Walks every `provider_keys` row whose `enc_version` is below the encryptor's current version,
 * decrypts it with the key that sealed it, re-encrypts under the current key with the canonical
 * `providerKeyAad(org_id, id)`, and writes ciphertext/iv/tag/enc_version back in one statement.
 * Operator-triggered, NOT on the scheduler: rotation is a deliberate act, and a cadence job that
 * silently re-seals is a cadence job that silently re-seals with a mis-set current version.
 *
 * OPERATOR RUNBOOK (v1 → v2, zero downtime):
 *   1. `openssl rand -base64 32` → set SPILLWAY_ENC_KEY_V2 on EVERY instance. Leave
 *      SPILLWAY_ENC_KEY_CURRENT at 1. Deploy. Nothing changes yet; every instance can now
 *      decrypt v2 but still writes v1.
 *   2. Set SPILLWAY_ENC_KEY_CURRENT=2 (keep V1 AND V2 set). Deploy. New provider keys seal at v2;
 *      existing v1 rows keep decrypting under V1. Both key versions are live, so a half-rolled
 *      deploy is safe in either direction — this is the step that buys the zero downtime.
 *   3. `pnpm keys:reseal`. Idempotent and resumable — safe to re-run, safe to kill halfway.
 *      Exits non-zero if any row failed; re-run after fixing, it picks up where it stopped.
 *   4. Confirm nothing is left behind: `select enc_version, count(*) from provider_keys group by 1`
 *      must show only version 2.
 *   5. Only then unset SPILLWAY_ENC_KEY_V1 and deploy — the compromised key is now out of the
 *      environment. Do NOT do this before step 4 reads clean: a straggler v1 row would fail closed
 *      (`provider_key_decrypt_failed`, 502) on every request that routes through it.
 *
 * ROLES. Two connections, the same split the scheduler uses (jobs/scheduler.ts):
 *   - `jobsDb` (spillway_jobs) does the cross-org SCAN. It is the only sanctioned cross-tenant read
 *     path (db/jobs.ts), and it already holds SELECT on provider_keys — no new grant, so the frozen
 *     allow-list in db/jobs-grants.integration.test.ts is untouched.
 *   - `db` (spillway_app) does the per-row WRITE, inside `withOrg`, because spillway_jobs
 *     deliberately has no UPDATE on provider_keys and widening that would hand the background-worker
 *     blast radius write access to every tenant's secrets forever, to buy one rare operator task.
 *   NEVER MIGRATION_DATABASE_URL. That connection is owner/superuser: superuser bypasses RLS
 *   outright, and the owner sees zero rows under the app role's policies — so pointing this job at
 *   it either ignores tenancy or silently re-seals nothing. main() asserts both roles for that
 *   reason, rather than trusting the URL to be the one the operator meant.
 */

export interface ResealFailure {
  providerKeyId: string;
  orgId: string;
  encVersion: number;
  reason: string;
}

export interface ResealResult {
  scanned: number;
  resealed: number;
  /** Row was already re-sealed by a concurrent writer between the scan and the update. */
  skipped: number;
  failures: ResealFailure[];
}

export interface ResealDeps {
  jobsDb: DatabaseClient; // spillway_jobs — cross-org scan
  db: DatabaseClient; // spillway_app — per-org write under withOrg
  encryptor: Encryptor;
  log?: (message: string) => void;
  pageSize?: number;
}

const PAGE_SIZE = 200;

/**
 * Re-seals one row and writes it back. The read is already done; this owns the crypto + the write.
 *
 * The decrypt passes the AAD even though the stored blob may predate AAD binding — `decrypt` falls
 * back to the no-AAD path for those (encryptor.ts:77-80), which is exactly how a legacy row gets
 * upgraded. The re-encrypt always binds, so the row that lands is AAD-authenticated and the legacy
 * fallback no longer applies to it.
 *
 * The `enc_version = <the version we read>` predicate makes the write a compare-and-set. Without it,
 * a re-seal racing a concurrent rotation (or a second copy of this job) could clobber a newer
 * ciphertext with one derived from a stale read. Zero rows updated means someone else got there
 * first, which is a skip, not a failure.
 */
async function resealRow(
  db: DatabaseClient,
  encryptor: Encryptor,
  row: {
    id: string;
    orgId: string;
    encVersion: number;
    ciphertext: Buffer;
    iv: Buffer;
    tag: Buffer;
  },
): Promise<'resealed' | 'skipped'> {
  const aad = providerKeyAad(row.orgId, row.id);
  const plaintext = encryptor.decrypt(
    { ciphertext: row.ciphertext, iv: row.iv, tag: row.tag, version: row.encVersion },
    aad,
  );
  const sealed = encryptor.encrypt(plaintext, aad);

  const updated = await withOrg(db, row.orgId, (tx) =>
    tx
      .update(providerKeys)
      .set({
        keyCiphertext: sealed.ciphertext,
        keyIv: sealed.iv,
        keyTag: sealed.tag,
        encVersion: sealed.version,
        updatedAt: new Date(),
      })
      .where(and(eq(providerKeys.id, row.id), eq(providerKeys.encVersion, row.encVersion)))
      .returning({ id: providerKeys.id }),
  );
  return updated.length === 1 ? 'resealed' : 'skipped';
}

/**
 * Re-seal every provider key below the encryptor's current version.
 *
 * Paginates by keyset on `id` rather than re-running `where enc_version < current` from the top.
 * The predicate shrinks as rows are re-sealed, which looks like it terminates on its own — until one
 * row can't be re-sealed (its key version isn't loaded, or its ciphertext is corrupt). That row
 * stays under the predicate forever and the "shrinking" loop spins on it. Keyset order guarantees
 * forward progress regardless.
 *
 * A row that fails does not abort the run: on a rotation you want the other 999 keys moved and one
 * named failure to fix, not an all-or-nothing sweep. Each row's write is its own transaction, so a
 * kill mid-run leaves a coherent mix of versions that a re-run finishes.
 */
export async function resealProviderKeys(deps: ResealDeps): Promise<ResealResult> {
  const { jobsDb, db, encryptor, log } = deps;
  const pageSize = deps.pageSize ?? PAGE_SIZE;
  const target = encryptor.currentVersion;
  const result: ResealResult = { scanned: 0, resealed: 0, skipped: 0, failures: [] };

  let afterId = '00000000-0000-0000-0000-000000000000';
  for (;;) {
    const page = await asJobs(jobsDb, (tx) =>
      tx
        .select({
          id: providerKeys.id,
          orgId: providerKeys.orgId,
          encVersion: providerKeys.encVersion,
          ciphertext: providerKeys.keyCiphertext,
          iv: providerKeys.keyIv,
          tag: providerKeys.keyTag,
        })
        .from(providerKeys)
        .where(and(lt(providerKeys.encVersion, target), gt(providerKeys.id, afterId)))
        .orderBy(asc(providerKeys.id))
        .limit(pageSize),
    );
    if (page.length === 0) break;
    afterId = page[page.length - 1]!.id;

    for (const row of page) {
      result.scanned++;
      try {
        const outcome = await resealRow(db, encryptor, row);
        result[outcome]++;
      } catch (err) {
        // The message is a crypto/DB failure reason, never key material — plaintext exists only as a
        // local in resealRow and is never passed to anything but encrypt().
        result.failures.push({
          providerKeyId: row.id,
          orgId: row.orgId,
          encVersion: row.encVersion,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
    log?.(`reseal-provider-keys: ${result.scanned} scanned, ${result.resealed} re-sealed so far`);
  }
  return result;
}

/**
 * Refuse to run on anything but the intended role. Both misconfigurations this catches are silent:
 * a superuser URL bypasses RLS entirely, and the table owner sees zero rows under the app role's
 * policies (provider_keys is FORCE ROW LEVEL SECURITY) — so the job would report a clean, empty,
 * completely wrong success.
 */
async function assertRole(db: DatabaseClient, expected: string, envVar: string): Promise<void> {
  const rows = (await db.execute(sql`select current_user as role`)) as unknown as {
    role: string;
  }[];
  const actual = rows[0]?.role;
  if (actual !== expected) {
    throw new Error(
      `${envVar} connects as '${actual ?? 'unknown'}', expected '${expected}'. Re-seal must run on the ` +
        `least-privilege roles — never the migration/owner URL, which bypasses or blanks RLS.`,
    );
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const jobs = makeDb(config.DATABASE_URL_JOBS, 2);
  const app = makeDb(config.DATABASE_URL, 2);
  try {
    await assertRole(jobs.db, 'spillway_jobs', 'DATABASE_URL_JOBS');
    await assertRole(app.db, 'spillway_app', 'DATABASE_URL');
    const encryptor = makeEncryptor(config);
    console.log(`reseal-provider-keys: target enc_version ${encryptor.currentVersion}`);
    const result = await resealProviderKeys({
      jobsDb: jobs.db,
      db: app.db,
      encryptor,
      log: (m) => console.log(m),
    });
    for (const f of result.failures) {
      console.error(
        `reseal-provider-keys: FAILED provider_key ${f.providerKeyId} (org ${f.orgId}, enc_version ${f.encVersion}): ${f.reason}`,
      );
    }
    console.log(
      `reseal-provider-keys: scanned=${result.scanned} resealed=${result.resealed} ` +
        `skipped=${result.skipped} failed=${result.failures.length}`,
    );
    if (result.failures.length > 0) process.exitCode = 1;
  } finally {
    await jobs.close();
    await app.close();
  }
}

if (process.argv[1]?.includes('reseal-provider-keys')) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
