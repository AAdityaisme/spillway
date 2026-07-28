import { makeDb } from '../../apps/server/src/db/client.js';
import { withOrg } from '../../apps/server/src/db/tenancy.js';
import {
  users,
  orgs,
  orgMembers,
  teams,
  virtualKeys,
  requests,
  spendCounters,
  budgets,
  approvalPolicies,
  approvalRequests,
  approvalSteps,
} from '../../apps/server/src/db/schema.js';
import { generateVirtualKey } from '../../apps/server/src/auth/keys.js';

/**
 * "Acme AI" demo seed (12-operations §1.4) — a reproducible governance org with ~30 days of realistic
 * traffic for screenshots + the 4-min demo (01-product §7). Deterministic (mulberry32 seed) so it's
 * repeatable. Generates `requests` rows and accumulates the matching `spend_counters` INLINE (org/team/
 * key × day/month), so counters reconcile to the row sums without a separate rebuild step. Includes the
 * two demo set-pieces: an anomaly day (Data Science 4× baseline) and a blocked-budget cluster.
 *
 * The DEV user (user_dev…, same as `pnpm dev:token`) is added as OWNER so the dev-auth bar can view it —
 * the printed org id is what you paste alongside the dev token. Refuses to run in production.
 */

const DEV_SUB = 'user_dev0000000000000000000001';
// Second admin so the approvals demo works: the requester can never approve their own request, so a
// single-member org 422s (`approval_chain_unsatisfiable`) the moment anyone asks for a budget increase.
const SECOND_SUB = 'user_dev0000000000000000000002';
const DAYS = 30;
const BASELINE_PER_DAY = 250;

/** Deterministic PRNG (mulberry32) — seeded so every run produces the same demo dataset. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MODELS = [
  {
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    share: 0.3,
    inMicroPerK: 3000,
    outMicroPerK: 15000,
  },
  { provider: 'openai', model: 'gpt-4.1', share: 0.2, inMicroPerK: 2000, outMicroPerK: 8000 },
  {
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    share: 0.2,
    inMicroPerK: 800,
    outMicroPerK: 4000,
  },
  { provider: 'openai', model: 'gpt-4.1-nano', share: 0.1, inMicroPerK: 100, outMicroPerK: 400 },
  {
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    share: 0.1,
    inMicroPerK: 300,
    outMicroPerK: 1200,
  },
  {
    provider: 'anthropic',
    model: 'claude-opus-4-8',
    share: 0.1,
    inMicroPerK: 15000,
    outMicroPerK: 75000,
  },
];

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    console.error('Refusing to seed demo data: NODE_ENV=production');
    process.exit(1);
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL not set — run `pnpm db:up` and keep it in .env');
    process.exit(1);
  }
  const handle = makeDb(url, 2);
  const db = handle.db;
  const rng = mulberry32(42);

  await db
    .insert(users)
    .values([
      { id: DEV_SUB, email: 'dev@spillway.dev', name: 'Dev User' },
      { id: SECOND_SUB, email: 'dev2@spillway.dev', name: 'Second Admin' },
    ])
    .onConflictDoNothing();
  const [org] = await db
    .insert(orgs)
    .values({ name: 'Acme AI', slug: 'acme-ai', plan: 'governance' })
    .onConflictDoUpdate({ target: orgs.slug, set: { name: 'Acme AI', plan: 'governance' } })
    .returning({ id: orgs.id });
  const orgId = org!.id;

  const now = new Date();
  const todayMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const dayStart = (i: number): number => todayMidnight - (DAYS - 1 - i) * 86_400_000;
  const monthKey = (ms: number): string => new Date(ms).toISOString().slice(0, 7);
  const dayKey = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

  await withOrg(db, orgId, async (tx) => {
    await tx
      .insert(orgMembers)
      .values([
        { orgId, userId: DEV_SUB, role: 'owner' },
        { orgId, userId: SECOND_SUB, role: 'admin' },
      ])
      .onConflictDoNothing();
    // approval_decisions is append-only for the app role (audit trail — no DELETE grant) and carries
    // no FK back to requests, so old decision rows stay behind harmlessly; the UI reads them per-approval.
    for (const t of [
      approvalSteps,
      approvalRequests,
      approvalPolicies,
      requests,
      spendCounters,
      budgets,
      virtualKeys,
      teams,
    ])
      await tx.delete(t);

    const teamRows = await tx
      .insert(teams)
      .values([
        { orgId, name: 'Engineering', slug: 'eng' },
        { orgId, name: 'Product', slug: 'product' },
        { orgId, name: 'Data Science', slug: 'data-science' },
      ])
      .returning({ id: teams.id, slug: teams.slug });
    const teamBySlug = Object.fromEntries(teamRows.map((r) => [r.slug, r.id])) as Record<
      string,
      string
    >;

    const keySpec = [
      { name: 'eng-backend', team: 'eng' },
      { name: 'eng-frontend', team: 'eng' },
      { name: 'eng-agents', team: 'eng', rpmLimit: 60 },
      { name: 'prod-copilot', team: 'product' },
      { name: 'prod-research', team: 'product' },
      { name: 'ds-notebooks', team: 'data-science', tpmLimit: 500_000 },
      { name: 'ds-pipeline', team: 'data-science' },
      { name: 'orphan-key', team: null },
    ] as { name: string; team: string | null; rpmLimit?: number; tpmLimit?: number }[];
    const keyRows = await tx
      .insert(virtualKeys)
      .values(
        keySpec.map((k) => {
          const g = generateVirtualKey();
          return {
            orgId,
            teamId: k.team ? teamBySlug[k.team]! : null,
            name: k.name,
            keyHash: g.hash,
            keyPrefix: g.prefix,
            rpmLimit: k.rpmLimit ?? null,
            tpmLimit: k.tpmLimit ?? null,
            lastUsedAt: new Date(todayMidnight),
          };
        }),
      )
      .returning({ id: virtualKeys.id, name: virtualKeys.name, teamId: virtualKeys.teamId });
    const keyByName = Object.fromEntries(keyRows.map((r) => [r.name, r])) as Record<
      string,
      { id: string; teamId: string | null }
    >;

    const counters = new Map<string, { spent: bigint; req: number; blocked: number }>();
    const bump = (st: string, sid: string, pk: string, micro: bigint, blocked: boolean): void => {
      const k = `${st}:${sid}:${pk}`;
      const c = counters.get(k) ?? { spent: 0n, req: 0, blocked: 0 };
      if (blocked) c.blocked += 1;
      else {
        c.spent += micro;
        c.req += 1;
      }
      counters.set(k, c);
    };

    const pickModel = (): (typeof MODELS)[number] => {
      let r = rng();
      for (const m of MODELS) {
        if (r < m.share) return m;
        r -= m.share;
      }
      return MODELS[0]!;
    };
    // Team volume weighting: Engineering ~40%, Data Science ~35%, Product ~20%, orphan ~5%.
    const keyPool: string[] = [
      ...Array(40).fill('eng-backend'),
      ...Array(20).fill('eng-frontend'),
      ...Array(20).fill('eng-agents'),
      ...Array(12).fill('prod-copilot'),
      ...Array(8).fill('prod-research'),
      ...Array(18).fill('ds-notebooks'),
      ...Array(17).fill('ds-pipeline'),
      ...Array(5).fill('orphan-key'),
    ];

    const gauss = (mean: number, sd: number): number => {
      const u = Math.max(1e-9, rng());
      return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
    };

    const rows: (typeof requests.$inferInsert)[] = [];
    const emit = (keyName: string, atMs: number, blocked = false): void => {
      const key = keyByName[keyName]!;
      const m = pickModel();
      const agent = keyName === 'eng-agents';
      const inTok = Math.floor(agent ? 2000 + rng() * 14000 : 500 + rng() * 3500);
      const outTok = Math.floor(100 + rng() * 700);
      const micro = blocked
        ? 0n
        : BigInt(Math.round((inTok / 1000) * m.inMicroPerK + (outTok / 1000) * m.outMicroPerK));
      const latency = Math.min(5000, Math.max(200, Math.round(gauss(800, 200))));
      const stream = rng() < 0.6;
      rows.push({
        orgId,
        virtualKeyId: key.id,
        teamId: key.teamId,
        provider: m.provider,
        model: blocked ? null : m.model,
        requestedModel: m.model,
        endpoint: 'chat_completions',
        status: blocked ? 'blocked' : 'ok',
        blockReason: blocked ? 'budget_exceeded' : null,
        blockScopeType: blocked ? 'virtual_key' : null,
        blockScopeId: blocked ? key.id : null,
        blockPeriod: blocked ? 'day' : null,
        costUsd: blocked ? null : (Number(micro) / 1e6).toFixed(6),
        inputTokens: blocked ? null : inTok,
        outputTokens: blocked ? null : outTok,
        stream,
        ttftMs: stream && !blocked ? Math.round(latency * (0.1 + rng() * 0.2)) : null,
        latencyMs: latency,
        createdAt: new Date(atMs),
      });
      const mk = monthKey(atMs);
      const dk = dayKey(atMs);
      bump('org', orgId, mk, micro, blocked);
      bump('org', orgId, dk, micro, blocked);
      if (key.teamId) {
        bump('team', key.teamId, mk, micro, blocked);
        bump('team', key.teamId, dk, micro, blocked);
      }
      bump('virtual_key', key.id, mk, micro, blocked);
      bump('virtual_key', key.id, dk, micro, blocked);
    };

    for (let d = 0; d < DAYS; d++) {
      const base = dayStart(d);
      const spread = (): number => base + Math.floor(rng() * 86_400_000);
      if (d === DAYS - 2) {
        for (let i = 0; i < 800; i++) emit('ds-pipeline', spread()); // anomaly: ds-pipeline 4× burst
        for (let i = 0; i < 200; i++) emit('ds-notebooks', spread());
      } else if (d === DAYS - 1) {
        for (let i = 0; i < BASELINE_PER_DAY; i++)
          emit(keyPool[Math.floor(rng() * keyPool.length)]!, spread());
        for (let i = 0; i < 40; i++)
          emit('eng-agents', base + 14 * 3_600_000 + Math.floor(rng() * 10 * 3_600_000), true); // budget block cluster
      } else {
        for (let i = 0; i < BASELINE_PER_DAY; i++)
          emit(keyPool[Math.floor(rng() * keyPool.length)]!, spread());
      }
    }

    for (let i = 0; i < rows.length; i += 500)
      await tx.insert(requests).values(rows.slice(i, i + 500));

    const counterRows = [...counters.entries()].map(([k, v]) => {
      const [scopeType, scopeId, periodKey] = k.split(':') as [string, string, string];
      return {
        orgId,
        scopeType,
        scopeId,
        periodKey,
        spentUsd: (Number(v.spent) / 1e6).toFixed(6),
        requestCount: v.req,
        blockedCount: v.blocked,
      };
    });
    for (let i = 0; i < counterRows.length; i += 500)
      await tx.insert(spendCounters).values(counterRows.slice(i, i + 500));

    await tx.insert(budgets).values([
      {
        orgId,
        scopeType: 'team',
        scopeId: teamBySlug.eng!,
        period: 'month',
        limitUsd: '400.000000',
        mode: 'enforce',
      },
      {
        orgId,
        scopeType: 'team',
        scopeId: teamBySlug.eng!,
        period: 'day',
        limitUsd: '30.000000',
        mode: 'alert',
      },
      {
        orgId,
        scopeType: 'team',
        scopeId: teamBySlug.product!,
        period: 'month',
        limitUsd: '200.000000',
        mode: 'enforce',
      },
      {
        orgId,
        scopeType: 'team',
        scopeId: teamBySlug['data-science']!,
        period: 'month',
        limitUsd: '300.000000',
        mode: 'enforce',
      },
      {
        orgId,
        scopeType: 'virtual_key',
        scopeId: keyByName['eng-agents']!.id,
        period: 'day',
        limitUsd: '20.000000',
        mode: 'enforce',
      },
    ]);

    // Default approval chain: any budget_increase / key_unpause needs one owner/admin sign-off. With
    // the second admin above, the full block → request → approve → unblock demo beat works out of the box.
    await tx.insert(approvalPolicies).values({
      orgId,
      name: 'Spend approvals',
      kind: '*',
      definition: {
        tiers: [
          { min_amount_usd: '0', steps: [{ approvers: { roles: ['owner', 'admin'] }, quorum: 1 }] },
        ],
        expiry_hours: 24,
      },
      createdBy: DEV_SUB,
    });

    const monthSpent = counters.get(`org:${orgId}:${monthKey(todayMidnight)}`)?.spent ?? 0n;
    console.log('\n=== Acme AI demo seeded (12-ops §1.4) ===');
    console.log(`  org id:        ${orgId}  (slug acme-ai, plan governance)`);
    console.log(`  owner:         ${DEV_SUB} (use \`pnpm dev:token\` + this org id)`);
    console.log(`  2nd admin:     ${SECOND_SUB} (approves what the owner requests)`);
    console.log(
      `  requests:      ${rows.length} over ${DAYS} days (anomaly day-${DAYS - 1}, blocked cluster day-${DAYS})`,
    );
    console.log(`  teams: 3, keys: ${keyRows.length}, budgets: 5, approval policy: 1`);
    console.log(`  this-month org spend: $${(Number(monthSpent) / 1e6).toFixed(2)}\n`);
  });

  await handle.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
