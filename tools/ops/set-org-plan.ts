import { eq, sql } from 'drizzle-orm';
import { makeDb } from '../../apps/server/src/db/client.js';
import { withOrg } from '../../apps/server/src/db/tenancy.js';
import { orgs } from '../../apps/server/src/db/schema.js';
import { resolveEntitlements, PLAN_NAMES } from '../../apps/server/src/auth/entitlements.js';
import { appendAudit } from '../../apps/server/src/services/audit.js';

/**
 * Operator tool for changing an org's plan — the concierge model the dashboard already states
 * ("plans are set by the Spillway team"), minus the hand-written SQL that model currently
 * requires. `resolveEntitlements` fails CLOSED on an unknown plan (auth/entitlements.ts), so a
 * typo'd plan silently strips every governance feature instead of erroring; this script validates
 * against PLAN_NAMES (derived from the same map) so that can't happen, and prints the before/after
 * entitlement diff so the consequence is visible before it's committed.
 *
 * Usage: pnpm ops:set-plan --org <uuid|slug> --plan <free|pro|governance|enterprise> [--yes]
 * --yes is required for a DOWNGRADE (fewer entitlements after than before) — that silently breaks
 * a paying customer's existing budgets/policies/approval chains. An upgrade needs no confirmation.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Args {
  org: string;
  plan: string;
  yes: boolean;
}

/** What the locked re-read decided. `raced` carries the plan another writer left behind. */
type Outcome = { kind: 'applied' } | { kind: 'noop' } | { kind: 'raced'; from: string };

function parseArgs(argv: string[]): Args {
  let org: string | undefined;
  let plan: string | undefined;
  let yes = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--org') org = argv[++i];
    else if (argv[i] === '--plan') plan = argv[++i];
    else if (argv[i] === '--yes') yes = true;
  }
  if (!org || !plan) {
    console.error('Usage: pnpm ops:set-plan --org <uuid|slug> --plan <plan> [--yes]');
    process.exit(1);
  }
  return { org, plan, yes };
}

async function main(): Promise<void> {
  const { org: orgRef, plan, yes } = parseArgs(process.argv.slice(2));

  if (!PLAN_NAMES.includes(plan)) {
    console.error(`Unknown plan "${plan}". Valid plans: ${PLAN_NAMES.join(', ')}`);
    process.exit(1);
  }

  // No NODE_ENV=production guard, unlike tools/seed — this script's whole job is to run against
  // production (it's the replacement for hand-SQL there). The real footgun isn't the environment,
  // it's an ambiguous target: fail loudly rather than let `postgres` fall back to libpq's default
  // connection env vars (PGHOST/PGDATABASE/…) and quietly write to whatever Postgres is on PATH.
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL not set — point this at the target database explicitly.');
    process.exit(1);
  }

  const handle = makeDb(url, 2);
  const db = handle.db;

  const isUuid = UUID_RE.test(orgRef);
  const [target] = await db
    .select()
    .from(orgs)
    .where(isUuid ? eq(orgs.id, orgRef) : eq(orgs.slug, orgRef));
  if (!target) {
    console.error(`No org found for "${orgRef}" (looked up by ${isUuid ? 'id' : 'slug'}).`);
    process.exit(1);
  }

  if (target.plan === plan) {
    console.log(`No change: ${target.name} (${target.slug}) is already on "${plan}".`);
    await handle.close();
    process.exit(0);
  }

  const before = resolveEntitlements(target.plan);
  const after = resolveEntitlements(plan);
  const added = [...after].filter((e) => !before.has(e));
  const removed = [...before].filter((e) => !after.has(e));

  console.log(`Org: ${target.name} (${target.id}, slug=${target.slug})`);
  console.log(`Plan: ${target.plan} -> ${plan}`);
  console.log(`Entitlements before: ${[...before].join(', ') || '(none)'}`);
  console.log(`Entitlements after:  ${[...after].join(', ') || '(none)'}`);
  if (added.length > 0) console.log(`  + gained: ${added.join(', ')}`);
  if (removed.length > 0) console.log(`  - lost:   ${removed.join(', ')}`);

  if (removed.length > 0 && !yes) {
    console.error(
      `Refusing: this is a DOWNGRADE, removing ${removed.join(', ')}. Re-run with --yes to confirm.`,
    );
    process.exit(1);
  }

  // Everything above was decided from a read taken OUTSIDE the transaction. Acting on it directly
  // would let a concurrent operator's change slip through: the downgrade guard would have been
  // evaluated against a plan that is no longer current, and the audit row would claim a `before`
  // that never immediately preceded this write. Re-read under a row lock and re-decide.
  const result = await withOrg(db, target.id, async (tx): Promise<Outcome> => {
    const locked = (await tx.execute(
      sql`select plan from orgs where id = ${target.id} for update`,
    )) as unknown as { plan: string }[];
    const current = locked[0]!.plan;
    if (current === plan) return { kind: 'noop' };
    if (current !== target.plan) {
      const nowRemoved = [...resolveEntitlements(current)].filter((e) => !after.has(e));
      if (nowRemoved.length > 0 && !yes) return { kind: 'raced', from: current };
    }
    await tx
      .update(orgs)
      .set({ plan, updatedAt: sql`now()` })
      .where(eq(orgs.id, target.id));
    // Explicit actor (no request/session to denormalize from) — see AuditActor in services/audit.ts,
    // which exists for exactly this: system/automation writes that know their actor from parameters.
    await appendAudit(
      tx,
      {
        action: 'org.plan_change',
        target: { type: 'org', id: target.id },
        // `current`, not the pre-transaction read — the audit trail records the plan this write
        // actually replaced.
        fieldDiff: { plan: { before: current, after: plan } },
      },
      {
        orgId: target.id,
        actorType: 'system',
        actorId: 'ops:set-org-plan',
        actorName: 'set-org-plan CLI',
      },
    );
    return { kind: 'applied' };
  });

  if (result.kind === 'raced') {
    console.error(
      `Refusing: another write moved this org to "${result.from}" while this ran, and from there the change to "${plan}" is a DOWNGRADE. Nothing was changed. Re-run to see the current diff.`,
    );
    await handle.close();
    process.exit(1);
  }
  console.log(
    result.kind === 'noop'
      ? `No change: another write already moved ${target.slug} to "${plan}".`
      : `Done: ${target.slug} is now on "${plan}".`,
  );
  await handle.close();
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
