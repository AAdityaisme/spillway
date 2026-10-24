import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { makeTestApp, type TestHarness } from '../../test/helpers/app.js';
import type { DatabaseClient } from '../db/client.js';
import { Encryptor, providerKeyAad, type Sealed } from '../services/encryptor.js';
import { resealProviderKeys } from './reseal-provider-keys.js';

/**
 * Encryption-key rotation v1 → v2 against real RLS Postgres (ADR-014, 10-security §3).
 *
 * The claim being proved is ZERO DOWNTIME: during the window where v2 is current and v1 is still
 * loaded, rows at either version work — old rows decrypt, new writes seal at v2 — and the re-seal
 * moves the stragglers forward without a moment where a key is unreadable. Plus the failure
 * direction, which matters more: a row whose key version is NOT loaded fails closed with a named
 * error instead of producing garbage.
 *
 * Every key here is a throwaway generated in-process. Nothing reads the real environment.
 */

const V1 = randomBytes(32);
const V2 = randomBytes(32);

/** Before rotation: one key, sealing at v1. */
const encBefore = new Encryptor(new Map([[1, V1]]), 1);
/** The rotation window: seals at v2, still opens v1. This is the zero-downtime configuration. */
const encRotating = new Encryptor(
  new Map([
    [1, V1],
    [2, V2],
  ]),
  2,
);
/** After V1 is retired from the environment. Doubles as proof a row is genuinely ON the new key. */
const encRetired = new Encryptor(new Map([[2, V2]]), 2);

let h: TestHarness;
const orgA = randomUUID();
const orgB = randomUUID();

interface KeyRow {
  org_id: string;
  key_ciphertext: Buffer;
  key_iv: Buffer;
  key_tag: Buffer;
  enc_version: number;
}

async function insertKey(
  orgId: string,
  plaintext: string,
  enc: Encryptor,
  opts: { aad?: boolean } = {},
): Promise<string> {
  const id = randomUUID();
  const sealed = enc.encrypt(plaintext, opts.aad === false ? undefined : providerKeyAad(orgId, id));
  await h.adminSql`
    INSERT INTO provider_keys (id, org_id, provider, label, key_prefix,
                               key_ciphertext, key_iv, key_tag, enc_version)
    VALUES (${id}, ${orgId}, 'openai', 'k', 'sk-x',
            ${sealed.ciphertext}, ${sealed.iv}, ${sealed.tag}, ${sealed.version})`;
  return id;
}

async function readKey(id: string): Promise<KeyRow> {
  const rows = await h.adminSql<KeyRow[]>`
    SELECT org_id, key_ciphertext, key_iv, key_tag, enc_version FROM provider_keys WHERE id = ${id}`;
  const row = rows[0];
  if (!row) throw new Error(`provider key ${id} vanished`);
  return row;
}

const asSealed = (row: KeyRow): Sealed => ({
  ciphertext: row.key_ciphertext,
  iv: row.key_iv,
  tag: row.key_tag,
  version: row.enc_version,
});

/** Decrypt a stored row exactly the way the dispatch path does (data-plane/dispatch.ts). */
async function openAsDispatchWould(id: string, enc: Encryptor): Promise<string> {
  const row = await readKey(id);
  return enc.decrypt(asSealed(row), providerKeyAad(row.org_id, id));
}

const reseal = (enc: Encryptor, pageSize?: number) =>
  resealProviderKeys({ jobsDb: h.jobsDb, db: h.db, encryptor: enc, pageSize });

beforeAll(async () => {
  h = await makeTestApp();
  await h.adminSql`INSERT INTO orgs (id, name, slug)
    VALUES (${orgA}, 'A', ${'rk-a-' + orgA.slice(0, 8)}),
           (${orgB}, 'B', ${'rk-b-' + orgB.slice(0, 8)})`;
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.adminSql`TRUNCATE provider_keys`;
});

describe('provider-key re-seal — zero-downtime v1 → v2 rotation', () => {
  it('serves both versions during the rotation window, then lands everything on v2', async () => {
    // A key written before the rotation, and one written after the cutover by an already-flipped
    // instance. Both must work the whole time — that is the zero-downtime claim.
    const legacyId = await insertKey(orgA, 'sk-written-at-v1', encBefore);
    const freshId = await insertKey(orgA, 'sk-written-at-v2', encRotating);

    expect((await readKey(legacyId)).enc_version).toBe(1);
    expect((await readKey(freshId)).enc_version).toBe(2);
    expect(await openAsDispatchWould(legacyId, encRotating)).toBe('sk-written-at-v1');
    expect(await openAsDispatchWould(freshId, encRotating)).toBe('sk-written-at-v2');

    const result = await reseal(encRotating);
    expect(result).toMatchObject({ scanned: 1, resealed: 1, skipped: 0, failures: [] });

    for (const [id, plaintext] of [
      [legacyId, 'sk-written-at-v1'],
      [freshId, 'sk-written-at-v2'],
    ] as const) {
      expect((await readKey(id)).enc_version).toBe(2);
      expect(await openAsDispatchWould(id, encRotating)).toBe(plaintext);
      // Opens under an encryptor that holds ONLY V2 — so the row is genuinely sealed with the new
      // key, not merely stamped with the new version number.
      expect(await openAsDispatchWould(id, encRetired)).toBe(plaintext);
    }
  });

  it('crosses every org and pages through more rows than one page holds', async () => {
    const ids = [
      await insertKey(orgA, 'a1', encBefore),
      await insertKey(orgA, 'a2', encBefore),
      await insertKey(orgB, 'b1', encBefore),
      await insertKey(orgB, 'b2', encBefore),
      await insertKey(orgB, 'b3', encBefore),
    ];
    const result = await reseal(encRotating, 2); // 3 pages
    expect(result).toMatchObject({ scanned: 5, resealed: 5, failures: [] });
    for (const id of ids) expect((await readKey(id)).enc_version).toBe(2);
  });

  // The AAD is what stops a ciphertext being lifted from one (org, key) onto another. A row sealed
  // before AAD binding still decrypts via the no-AAD fallback (encryptor.ts:77-80); re-sealing is
  // what retires that fallback, so this asserts the fallback is actually gone afterwards.
  it('re-seals onto the AAD path and drops the legacy no-AAD fallback', async () => {
    const id = await insertKey(orgA, 'sk-legacy', encBefore, { aad: false });
    expect(encBefore.decrypt(asSealed(await readKey(id)))).toBe('sk-legacy'); // opens with no AAD

    await reseal(encRotating);

    const row = await readKey(id);
    expect(await openAsDispatchWould(id, encRotating)).toBe('sk-legacy');
    expect(() => encRotating.decrypt(asSealed(row))).toThrow(/authentication failed/);
    expect(() => encRotating.decrypt(asSealed(row), providerKeyAad(orgB, id))).toThrow(
      /authentication failed/,
    );
    expect(() => encRotating.decrypt(asSealed(row), providerKeyAad(orgA, randomUUID()))).toThrow(
      /authentication failed/,
    );
  });

  it('is idempotent and resumable — a second run is a no-op and already-v2 rows are untouched', async () => {
    const oldId = await insertKey(orgA, 'sk-old', encBefore);
    // What a run killed halfway leaves behind: some rows already moved, the rest not.
    const doneId = await insertKey(orgA, 'sk-done', encRotating);
    const doneBefore = await readKey(doneId);

    expect(await reseal(encRotating)).toMatchObject({ scanned: 1, resealed: 1, failures: [] });
    const afterFirst = await readKey(oldId);

    expect(await reseal(encRotating)).toMatchObject({
      scanned: 0,
      resealed: 0,
      skipped: 0,
      failures: [],
    });
    // Byte-identical: the second run re-encrypted nothing, and the already-current row was never
    // rewritten by either run (a fresh IV per encrypt makes any rewrite visible here).
    expect((await readKey(oldId)).key_ciphertext.equals(afterFirst.key_ciphertext)).toBe(true);
    expect((await readKey(doneId)).key_iv.equals(doneBefore.key_iv)).toBe(true);
    expect(await openAsDispatchWould(doneId, encRetired)).toBe('sk-done');
  });

  // The write is a compare-and-set on enc_version, so a row that moved between the scan and the
  // write is left alone instead of being overwritten from a stale read. `withOrg` reaches the
  // client only through `transaction`, so standing in front of that one method is enough to land
  // the racing writer exactly in the gap the CAS exists to cover.
  it('leaves a row that another writer advanced between scan and write', async () => {
    const id = await insertKey(orgA, 'sk-raced', encBefore);
    const before = await readKey(id);
    const racingDb = {
      transaction: async (fn: Parameters<DatabaseClient['transaction']>[0]) => {
        await h.adminSql`UPDATE provider_keys SET enc_version = 2 WHERE id = ${id}`;
        return h.db.transaction(fn);
      },
    } as unknown as DatabaseClient;

    const result = await resealProviderKeys({
      jobsDb: h.jobsDb,
      db: racingDb,
      encryptor: encRotating,
    });
    expect(result).toMatchObject({ scanned: 1, resealed: 0, skipped: 1, failures: [] });
    expect((await readKey(id)).key_ciphertext.equals(before.key_ciphertext)).toBe(true);
  });
});

describe('provider-key re-seal — fails closed when a key version is not loaded', () => {
  it('a row at a version with no loaded key throws a named error instead of returning garbage', async () => {
    const id = await insertKey(orgA, 'sk-stranded', encBefore);
    // The hazard behind runbook step 5: V1 retired while a v1 row is still out there.
    await expect(openAsDispatchWould(id, encRetired)).rejects.toThrow(
      /no encryption key for version 1/,
    );
  });

  it('re-seal reports the stranded row and leaves it byte-for-byte alone', async () => {
    const strandedId = await insertKey(orgA, 'sk-stranded', encBefore);
    const before = await readKey(strandedId);

    // An encryptor missing V1 cannot re-seal a v1 row. It must not skip it silently, and it must
    // not half-write it.
    const result = await reseal(encRetired);
    expect(result.scanned).toBe(1);
    expect(result.resealed).toBe(0);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({
      providerKeyId: strandedId,
      orgId: orgA,
      encVersion: 1,
    });
    expect(result.failures[0]?.reason).toMatch(/no encryption key for version 1/);

    const after = await readKey(strandedId);
    expect(after.enc_version).toBe(1);
    expect(after.key_ciphertext.equals(before.key_ciphertext)).toBe(true);
    expect(after.key_tag.equals(before.key_tag)).toBe(true);
  });

  it('one unreadable row does not stall the sweep or block the readable ones', async () => {
    // Corrupt at rest under a key version that IS loaded: fails the GCM tag, not the key lookup.
    const corrupt = await insertKey(orgA, 'sk-corrupt', encBefore);
    await h.adminSql`UPDATE provider_keys
                        SET key_ciphertext = key_ciphertext || '\\x00'::bytea
                      WHERE id = ${corrupt}`;
    const healthyA = await insertKey(orgA, 'sk-healthy-a', encBefore);
    const healthyB = await insertKey(orgB, 'sk-healthy-b', encBefore);

    const result = await reseal(encRotating);
    expect(result.scanned).toBe(3);
    expect(result.resealed).toBe(2);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.providerKeyId).toBe(corrupt);
    expect(result.failures[0]?.reason).toMatch(/authentication failed/);
    expect(await openAsDispatchWould(healthyA, encRetired)).toBe('sk-healthy-a');
    expect(await openAsDispatchWould(healthyB, encRetired)).toBe('sk-healthy-b');
    expect((await readKey(corrupt)).enc_version).toBe(1);
  });
});
