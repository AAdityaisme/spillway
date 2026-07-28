import { makeDb } from '../../apps/server/src/db/client.js';
import { withOrg } from '../../apps/server/src/db/tenancy.js';
import { orgs, virtualKeys, providerKeys, modelPrices } from '../../apps/server/src/db/schema.js';
import { generateVirtualKey } from '../../apps/server/src/auth/keys.js';
import { Encryptor } from '../../apps/server/src/services/encryptor.js';
import { capabilitiesFor } from '../../packages/pricing/src/capabilities.js';

/**
 * Dev bootstrap seed — the minimum to make a fresh local stack usable without hand-SQL:
 * a dev org, one virtual key (plaintext printed ONCE), an OpenAI provider key when
 * OPENAI_API_KEY is set, and fallback model prices when the pricing table is empty.
 *
 * The full "Acme AI" demo dataset (teams, budgets, 30-day traffic history — 12-operations
 * §1.4) is a separate M7 deliverable; this script deliberately stays a bootstrap.
 * Idempotent-ish: re-running reuses the org, mints a NEW virtual key, never duplicates
 * the provider key or prices. Refuses to run in production.
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
    const encKeyB64 = process.env.SPILLWAY_ENC_KEY_V1;
    if (!encKeyB64) {
      console.error('SPILLWAY_ENC_KEY_V1 not set — cannot seal the provider key');
      process.exit(1);
    }
    const encryptor = new Encryptor(new Map([[1, Buffer.from(encKeyB64, 'base64')]]), 1);
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

  // Fallback prices so budgets meter before the first `pnpm pricing:sync` (which supersedes these).
  const priced = await db.select({ provider: modelPrices.provider }).from(modelPrices).limit(1);
  let pricesNote = 'present — untouched';
  if (priced.length === 0) {
    await db.insert(modelPrices).values([
      {
        provider: 'openai',
        model: 'gpt-4o',
        inputUsdPerM: '2.5',
        outputUsdPerM: '10',
        cacheReadUsdPerM: '1.25',
        capabilities: capabilitiesFor('openai', 'gpt-4o'),
        source: 'litellm',
        syncedAt: new Date(),
      },
      {
        provider: 'openai',
        model: 'gpt-4.1',
        inputUsdPerM: '2',
        outputUsdPerM: '8',
        cacheReadUsdPerM: '0.5',
        capabilities: capabilitiesFor('openai', 'gpt-4.1'),
        source: 'litellm',
        syncedAt: new Date(),
      },
    ]);
    pricesNote = 'seeded gpt-4o + gpt-4.1 fallbacks — run `pnpm pricing:sync` for the full table';
  }

  console.log(`\nDev seed complete
  org:          Dev Org (slug 'dev', id ${org.id})
  virtual key:  ${key.plaintext}   ← shown ONCE, hash-only in the DB
  provider key: ${providerKeyNote}
  model prices: ${pricesNote}

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
