import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { makeTestApp, type TestHarness } from '../../../test/helpers/app.js';
import { withOrg } from '../../db/tenancy.js';
import {
  evaluateAndFireBudgetThresholds,
  type ThresholdBudget,
  type PostCounter,
} from './threshold.js';

/**
 * M3 exit gate (13-build-order §M3): "an artificial spend storm fires exactly one 80% alert and one
 * 100% block alert (dedupe proven)". This drives the reconcile-side threshold hook (§17 §5) against a
 * real DB: a budget + an org-wide budget_threshold alert, then pre/post counter snapshots simulating
 * spend climbing past each band. Proves the crossing detection, alert matching, payload, and the
 * UNIQUE(alert_id, dedupe_key) dedupe end to end.
 */
describe('budget threshold alerting — spend storm (M3 exit gate)', () => {
  let h: TestHarness;
  let orgId: string;
  const month = new Date().toISOString().slice(0, 7);

  beforeEach(async () => {
    h = await makeTestApp();
    orgId = randomUUID();
    await h.adminSql`INSERT INTO orgs (id, name, slug) VALUES (${orgId}, 'Acme', ${'a-' + orgId.slice(0, 8)})`;
  });
  afterEach(async () => {
    await h.close();
  });

  const budget: () => ThresholdBudget = () => ({
    id: randomUUID(),
    scopeType: 'org',
    scopeId: orgId,
    period: 'month',
    limitUsd: '1.000000', // $1 org-month cap
    mode: 'enforce',
    onExceed: 'block',
    createdAt: new Date(),
  });

  async function seedOrgWideAlert(): Promise<string> {
    const id = randomUUID();
    await h.adminSql`
      INSERT INTO alerts (id, org_id, name, kind, scope_type, scope_id, config, channels, enabled)
      VALUES (${id}, ${orgId}, 'budget', 'budget_threshold', NULL, NULL,
              ${h.adminSql.json({})}, ${h.adminSql.json([])}, true)`;
    return id;
  }

  const post = (spentMicro: bigint): PostCounter[] => [
    { scopeType: 'org', scopeId: orgId, periodKey: month, spentMicro },
  ];

  async function events(): Promise<{ pct: number; severity: string; event_type: string }[]> {
    const rows = (await h.adminSql`
      SELECT payload FROM alert_events WHERE org_id = ${orgId} ORDER BY (payload->>'pct')::int`) as unknown as {
      payload: { pct: number; severity: string; event_type: string };
    }[];
    return rows.map((r) => r.payload);
  }

  it('fires exactly one 80% and one 100% event across a climbing spend storm, then dedupes', async () => {
    const b = budget();
    await seedOrgWideAlert();
    const now = new Date();
    const fire = (spentMicro: bigint, deltaMicro: bigint): Promise<number> =>
      withOrg(h.db, orgId, (tx) =>
        evaluateAndFireBudgetThresholds(tx, {
          orgId,
          budgets: [b],
          postCounters: post(spentMicro),
          deltaMicro,
          now,
        }),
      );

    // Storm step 1: 0 → $0.85 crosses 80% only.
    expect(await fire(850_000n, 850_000n)).toBe(1);
    // Storm step 2: $0.85 → $1.05 crosses 100% only (80 already crossed).
    expect(await fire(1_050_000n, 200_000n)).toBe(1);

    const ev = await events();
    expect(ev.map((e) => e.pct)).toEqual([80, 100]);
    expect(ev.find((e) => e.pct === 80)!.severity).toBe('warning');
    expect(ev.find((e) => e.pct === 100)!.severity).toBe('critical');
    expect(ev.every((e) => e.event_type === 'budget_threshold')).toBe(true);

    // Dedupe: a later request that would re-cross 80 (pre 0 → post 0.9) fires nothing new.
    expect(await fire(900_000n, 900_000n)).toBe(0);
    // Dedupe: re-crossing 100 fires nothing new either.
    expect(await fire(1_200_000n, 200_000n)).toBe(0);
    expect((await events()).length).toBe(2);
  });

  it('F8: a band crossed by an earlier fallback attempt is detected ONLY with the request-total delta', async () => {
    // reconcile fires this hook once (final attempt) with the committed post. The pre it derives (post -
    // delta) must subtract the WHOLE request's spend, not just the final attempt's — else a band crossed
    // by an earlier billed fallback attempt is invisible. Scenario: counter $0.70; a request's fallback
    // attempt bills $0.15 → $0.85 (crosses the 80% band at $0.80), its final attempt bills $0.10 → $0.95.
    const b = budget();
    await seedOrgWideAlert();
    const now = new Date();
    const fire = (spentMicro: bigint, deltaMicro: bigint): Promise<number> =>
      withOrg(h.db, orgId, (tx) =>
        evaluateAndFireBudgetThresholds(tx, {
          orgId,
          budgets: [b],
          postCounters: post(spentMicro),
          deltaMicro,
          now,
        }),
      );
    // WRONG (pre-fix) delta = final attempt only ($0.10): pre = $0.85 ≥ $0.80 → looks already-crossed → 0.
    expect(await fire(950_000n, 100_000n)).toBe(0);
    // RIGHT (post-fix) delta = request total ($0.25): pre = $0.70 < $0.80 ≤ $0.95 → the 80% band fires.
    expect(await fire(950_000n, 250_000n)).toBe(1);
    expect((await events()).map((e) => e.pct)).toEqual([80]);
  });

  it('a single large request that jumps over both bands fires both, once', async () => {
    const b = budget();
    await seedOrgWideAlert();
    const fired = await withOrg(h.db, orgId, (tx) =>
      evaluateAndFireBudgetThresholds(tx, {
        orgId,
        budgets: [b],
        postCounters: post(1_500_000n), // 0 → $1.50 in one shot
        deltaMicro: 1_500_000n,
        now: new Date(),
      }),
    );
    expect(fired).toBe(2);
    expect((await events()).map((e) => e.pct)).toEqual([80, 100]);
  });

  it('an alert scoped to a different team does not catch an org-budget crossing', async () => {
    const b = budget();
    // alert scoped to some team, not org-wide → must NOT match the org-scope budget.
    const otherTeam = randomUUID();
    await h.adminSql`
      INSERT INTO alerts (id, org_id, name, kind, scope_type, scope_id, config, channels, enabled)
      VALUES (${randomUUID()}, ${orgId}, 't', 'budget_threshold', 'team', ${otherTeam},
              ${h.adminSql.json({})}, ${h.adminSql.json([])}, true)`;
    const fired = await withOrg(h.db, orgId, (tx) =>
      evaluateAndFireBudgetThresholds(tx, {
        orgId,
        budgets: [b],
        postCounters: post(900_000n),
        deltaMicro: 900_000n,
        now: new Date(),
      }),
    );
    expect(fired).toBe(0);
    expect((await events()).length).toBe(0);
  });

  it('a monitor-mode budget never fires', async () => {
    const b: ThresholdBudget = { ...budget(), mode: 'monitor' };
    await seedOrgWideAlert();
    const fired = await withOrg(h.db, orgId, (tx) =>
      evaluateAndFireBudgetThresholds(tx, {
        orgId,
        budgets: [b],
        postCounters: post(1_500_000n),
        deltaMicro: 1_500_000n,
        now: new Date(),
      }),
    );
    expect(fired).toBe(0);
  });
});
