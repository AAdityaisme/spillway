import { loadConfig, workosIssuer } from '../apps/server/src/config.js';
import { makeDb } from '../apps/server/src/db/client.js';
import { mintDevToken } from '../apps/server/src/auth/dev-jwks.js';
import { users, orgs, orgMembers } from '../apps/server/src/db/schema.js';

/**
 * Dev auth helper (pairs with the dev-only local-JWKS seam in index.ts). Ensures a dev user + org +
 * owner membership exist, then mints a 24h JWT the dev server (running WITHOUT WorkOS) will verify
 * against the local test JWKS. Paste the printed JWT + org id into the dashboard dev-auth bar.
 *
 * Refuses to run in production — the whole local-JWKS path is unreachable there anyway.
 */
const DEV_SUB = 'user_dev0000000000000000000001';
const DEV_EMAIL = 'dev@spillway.dev';

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.NODE_ENV === 'production') {
    console.error('Refusing: NODE_ENV=production (dev auth is dev-only).');
    process.exit(1);
  }
  // Bootstrapping the dev user + org + owner membership writes rows RLS normally reserves for the
  // auth hook / API path, so it needs the privileged (superuser/owner) connection — the same one
  // migrate.ts uses. Falls back to DATABASE_URL, which works only if that role can bypass RLS.
  const adminUrl = process.env.MIGRATION_DATABASE_URL ?? config.DATABASE_URL;
  const handle = makeDb(adminUrl, 2);
  const db = handle.db;

  await db
    .insert(users)
    .values({ id: DEV_SUB, email: DEV_EMAIL, name: 'Dev User' })
    .onConflictDoNothing();
  const [org] = await db
    .insert(orgs)
    .values({ name: 'Dev Org', slug: 'dev' })
    .onConflictDoUpdate({ target: orgs.slug, set: { name: 'Dev Org' } })
    .returning({ id: orgs.id });
  await db
    .insert(orgMembers)
    .values({ orgId: org!.id, userId: DEV_SUB, role: 'owner' })
    .onConflictDoNothing();

  const token = await mintDevToken({
    issuer: workosIssuer(config),
    sub: DEV_SUB,
    email: DEV_EMAIL,
    expiresInSeconds: 86_400,
  });

  console.log('\n=== Spillway dev auth (dev-only local JWKS) ===');
  console.log('Paste into the dashboard dev-auth bar:\n');
  console.log(`  JWT:    ${token}\n`);
  console.log(`  Org id: ${org!.id}\n`);
  console.log('curl smoke test:');
  console.log(
    `  curl -s localhost:${config.PORT}/api/kpi/overview -H "authorization: Bearer ${token}" -H "x-spillway-org: ${org!.id}"\n`,
  );
  await handle.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
