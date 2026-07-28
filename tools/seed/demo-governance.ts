import { sql } from 'drizzle-orm';
import { makeDb } from '../../apps/server/src/db/client.js';
import { withOrg } from '../../apps/server/src/db/tenancy.js';
import {
  orgs,
  teams,
  virtualKeys,
  budgets,
  modelAliases,
  routingRules,
  governancePolicies,
  alerts,
  approvalRequests,
  approvalSteps,
} from '../../apps/server/src/db/schema.js';

/**
 * Governance layer for the Acme AI demo org (additive companion to demo.ts — run AFTER it).
 * Backfills the request_attempts ledger so the chargeback statement reconciles to the cent,
 * and seeds the surfaces demo.ts doesn't cover: a pending approval the dev user can decide,
 * alerts (incl. the budget_forecast differentiator), guardrail policies, and a routing
 * rule + alias. Idempotent: re-running replaces its own rows. Refuses to run in production.
 */

const DEV_USER = 'user_dev0000000000000000000001';
const REQUESTER = 'user_demo_platform_lead0001'; // distinct requester so the dev user may approve

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    console.error('Refusing to seed demo data: NODE_ENV=production');
    process.exit(1);
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL not set');
    process.exit(1);
  }
  const handle = makeDb(url, 2);
  const db = handle.db;

  const org = (
    await db
      .select({ id: orgs.id })
      .from(orgs)
      .where(sql`slug = 'acme-ai'`)
  )[0];
  if (!org) {
    console.error("Org 'acme-ai' not found — run `pnpm seed:demo` first.");
    process.exit(1);
  }
  const orgId = org.id;

  await withOrg(db, orgId, async (tx) => {
    // Own rows only — never demo.ts's traffic/counters.
    await tx.delete(approvalSteps);
    await tx.delete(approvalRequests);
    await tx.delete(alerts);
    await tx.delete(governancePolicies);
    await tx.delete(routingRules);
    await tx.delete(modelAliases);

    // 1. Attempts ledger mirroring billable requests — the reconciled-to-the-cent proof.
    await tx.execute(sql`
      INSERT INTO request_attempts
        (request_id, attempt_number, org_id, provider, model, outcome, input_tokens,
         output_tokens, cost_usd, elapsed_ms, settled_at)
      SELECT r.id, 0, r.org_id, r.provider, r.model,
             CASE WHEN r.status = 'error' THEN 'error' ELSE 'ok' END,
             r.input_tokens, r.output_tokens, r.cost_usd, r.latency_ms, r.created_at
      FROM requests r
      WHERE r.status IN ('ok', 'error')
      ON CONFLICT (request_id, attempt_number) DO UPDATE
        SET cost_usd = EXCLUDED.cost_usd, outcome = EXCLUDED.outcome
    `);

    const teamRows = await tx.select({ id: teams.id, slug: teams.slug }).from(teams);
    const eng = teamRows.find((t) => t.slug === 'eng')?.id ?? null;
    const keyRows = await tx
      .select({ id: virtualKeys.id, name: virtualKeys.name })
      .from(virtualKeys);
    const agents = keyRows.find((k) => k.name === 'eng-agents') ?? keyRows[0]!;
    const staging = keyRows.find((k) => k.name === 'eng-frontend') ?? keyRows[0]!;

    // 2. Routing story: one alias + one rewrite rule.
    const [rule] = await tx
      .insert(routingRules)
      .values({
        orgId,
        priority: 100,
        description: 'Frontend traffic serves the cheap tier',
        match: { virtual_key_ids: [staging.id] },
        action: { type: 'rewrite_model', to: { provider: 'openai', model: 'gpt-4.1-nano' } },
      })
      .returning({ id: routingRules.id });
    await tx.insert(modelAliases).values({
      orgId,
      alias: 'spillway/cheap',
      targets: [
        { provider: 'openai', model: 'gpt-4.1-nano' },
        { provider: 'anthropic', model: 'claude-haiku-4-5' },
      ],
    });
    void rule;

    // 3. Alerts — the forecast alert is a differentiator, keep it first.
    await tx.insert(alerts).values([
      {
        orgId,
        name: 'Org on pace to exceed month budget',
        kind: 'budget_forecast',
        scopeType: null,
        scopeId: null,
        config: { pct: 100 },
        channels: [{ type: 'slack', webhook_url: 'https://hooks.slack.com/services/demo' }],
      },
      {
        orgId,
        name: 'Engineering at 80% of monthly budget',
        kind: 'budget_threshold',
        scopeType: eng ? 'team' : null,
        scopeId: eng,
        config: { pct: 80 },
        channels: [{ type: 'email', to: 'finops@acme.dev' }],
      },
      {
        orgId,
        name: 'Gateway error rate above 5%',
        kind: 'error_rate',
        scopeType: null,
        scopeId: null,
        config: { pct: 5, window_min: 15 },
        channels: [{ type: 'email', to: 'platform@acme.dev' }],
      },
    ]);

    // 4. Guardrail policies (structured match only — nothing to compile).
    await tx.insert(governancePolicies).values([
      {
        orgId,
        name: 'Frontier models need a human',
        description: 'Opus-tier calls outside Engineering require approval.',
        effect: 'require_approval',
        reason: 'Frontier-tier usage requires platform approval.',
        match: { models: ['claude-opus-4-8'] },
        enforcement: 'shadow',
      },
      {
        orgId,
        name: 'Block unapproved providers',
        description: 'Only the vetted provider list may serve traffic.',
        effect: 'deny',
        reason: 'Provider not on the approved list.',
        match: { models: ['sora-hd'] },
        enforcement: 'enforce',
      },
    ]);

    // 5. A live pending approval the dev user can decide in the demo.
    const agentsBudget = (
      await tx
        .select({ limitUsd: budgets.limitUsd })
        .from(budgets)
        .where(sql`scope_type = 'virtual_key' AND scope_id = ${agents.id} AND period = 'month'`)
    )[0];
    const current = Number(agentsBudget?.limitUsd ?? 500);
    const requested = (current * 1.6).toFixed(6);
    const [appr] = await tx
      .insert(approvalRequests)
      .values({
        orgId,
        kind: 'budget_increase',
        requestedBy: REQUESTER,
        scopeType: 'virtual_key',
        scopeId: agents.id,
        currentValue: { period: 'month', limit_usd: current.toFixed(6), mode: 'enforce' },
        requestedValue: { period: 'month', limit_usd: requested, mode: 'enforce' },
        justification:
          'eng-agents is pacing over its cap after the retrieval rollout; requesting headroom through month end.',
        amountUsd: requested,
        expiresAt: new Date(Date.now() + 72 * 3600_000),
      })
      .returning({ id: approvalRequests.id });
    await tx.insert(approvalSteps).values({
      orgId,
      approvalId: appr!.id,
      stepIndex: 0,
      quorum: '1',
      requiredApproverIds: [DEV_USER],
    });

    console.log('\n=== governance layer seeded (Acme AI) ===');
    console.log('  attempts ledger backfilled (chargeback reconciles)');
    console.log(
      '  1 pending approval (decide as the dev user) · 3 alerts · 2 policies · 1 rule + 1 alias\n',
    );
  });

  await handle.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
