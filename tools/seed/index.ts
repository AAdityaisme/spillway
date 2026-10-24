import { makeDb } from '../../apps/server/src/db/client.js';
import { withOrg } from '../../apps/server/src/db/tenancy.js';
import { orgs, virtualKeys, providerKeys } from '../../apps/server/src/db/schema.js';
import { generateVirtualKey } from '../../apps/server/src/auth/keys.js';
import { Encryptor } from '../../apps/server/src/services/encryptor.js';
import { ENC_KEY_FIELDS } from '../../apps/server/src/config.js';
import { syncPricesFromEnv } from '../../apps/server/src/db/pricing-sync.js';

/**
 * Dev bootstrap seed — the minimum to make a fresh local stack usable without hand-SQL:
 * a dev org, one virtual key (plaintext printed ONCE), and an OpenAI provider key when
 * OPENAI_API_KEY is set. Model prices are loaded first through `syncPricesFromEnv`, which connects as the
 * migration owner: the app role has no write access to model_prices (migration 0007). The production
 * refusal runs before that sync, so a refused seed writes nothing.
 *
 * The full "Acme AI" demo dataset (teams, budgets, 30-day traffic history — 12-operations
 * §1.4) is a separate M7 deliverable; this script deliberately stays a bootstrap.
 * Idempotent-ish: re-running reuses the org, mints a NEW virtual key, never duplicates
 * the provider key. Refuses to run in production.
 */
async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    console.error('Refusing to seed: NODE_ENV=production');
    process.exit(1);
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL not set — run `pnpm db:up` and keep it in .env');
    process.exit(1);
  }
  await syncPricesFromEnv();

  const handle = makeDb(url, 2);
  const db = handle.db;

  const org = (
    await db
      .insert(orgs)
      .values({ name: 'Dev Org', slug: 'dev' })
      .onConflictDoUpdate({ target: orgs.slug, set: { name: 'Dev Org' } })
      .returning({ id: orgs.id })
  )[0]!;

  const key = generateVirtualKey();
  await withOrg(db, org.id, async (tx) => {
    await tx.insert(virtualKeys).values({
      orgId: org.id,
      name: `dev (seeded ${new Date().toISOString().slice(0, 10)})`,
      keyHash: key.hash,
      keyPrefix: key.prefix,
    });
  });

  let providerKeyNote = 'skipped — set OPENAI_API_KEY in .env to seed one';
  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey) {
    // Driven off config.ts's ENC_KEY_FIELDS rather than hardcoding v1: after a completed
    // rotation V1 is unset by design, and a v1-only seed would refuse to run against a
    // perfectly healthy environment.
    const encKeys = new Map<number, Buffer>();
    for (const [version, field] of ENC_KEY_FIELDS) {
      const b64 = process.env[field];
      if (b64) encKeys.set(version, Buffer.from(b64, 'base64'));
    }
    // Seal under the CONFIGURED current version, mirroring makeEncryptor — not the newest key
    // present. Those differ in the intended pre-cutover state (V2 staged so every instance can
    // decrypt an already-flipped peer's writes, CURRENT still 1): sealing under the highest key
    // would write a v2 row while the server is still sealing at v1, and aborting the rotation by
    // unsetting V2 would then leave that provider key permanently undecryptable.
    const currentVersion = Number(process.env.SPILLWAY_ENC_KEY_CURRENT ?? 1);
    if (!encKeys.has(currentVersion)) {
      console.error(
        `SPILLWAY_ENC_KEY_CURRENT is ${currentVersion}, but SPILLWAY_ENC_KEY_V${currentVersion} is not set — cannot seal the provider key`,
      );
      process.exit(1);
    }
    const encryptor = new Encryptor(encKeys, currentVersion);
    await withOrg(db, org.id, async (tx) => {
      // no drizzle-orm helper imports here — tools/ resolves a different hoisted instance
      // than apps/server and the mixed SQL objects fail to typecheck; filter in JS instead.
      const all = await tx
        .select({
          id: providerKeys.id,
          provider: providerKeys.provider,
          status: providerKeys.status,
        })
        .from(providerKeys);
      const existing = all.filter((k) => k.provider === 'openai' && k.status === 'active');
      if (existing.length > 0) {
        providerKeyNote = 'already present — left as-is';
        return;
      }
      const sealed = encryptor.encrypt(openaiKey);
      await tx.insert(providerKeys).values({
        orgId: org.id,
        provider: 'openai',
        label: 'dev-openai',
        keyPrefix: openaiKey.slice(0, 11),
        keyCiphertext: sealed.ciphertext,
        keyIv: sealed.iv,
        keyTag: sealed.tag,
        encVersion: sealed.version,
      });
      providerKeyNote = 'seeded from OPENAI_API_KEY';
    });
  }

  console.log(`\nDev seed complete
  org:          Dev Org (slug 'dev', id ${org.id})
  virtual key:  ${key.plaintext}   ← shown ONCE, hash-only in the DB
  provider key: ${providerKeyNote}

Try it:
  curl -s localhost:3000/v1/chat/completions \\
    -H 'authorization: Bearer ${key.plaintext}' \\
    -H 'content-type: application/json' \\
    -d '{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}'
`);
  await handle.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
