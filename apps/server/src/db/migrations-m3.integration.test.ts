import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { makeTestApp, type TestHarness } from '../../test/helpers/app.js';
import { withOrg } from './tenancy.js';

/**
 * B0.1 exit-gate proof: the M3 governance tables (governance_policies, decision_logs,
 * routing_config_snapshots) are org-isolated for the app role, and decision_logs +
 * routing_config_snapshots are readable/deletable by spillway_jobs (retention sweeper / GC).
 */
describe('M3 governance migrations (B0.1) — RLS isolation + _jobs grants', () => {
  let h: TestHarness;
  const orgA = randomUUID();
  const orgB = randomUUID();

  beforeAll(async () => {
    h = await makeTestApp();
    await h.adminSql`INSERT INTO orgs (id, name, slug) VALUES
      (${orgA}, 'A', ${'a-' + orgA.slice(0, 8)}),
      (${orgB}, 'B', ${'b-' + orgB.slice(0, 8)})`;
  });
  afterAll(async () => {
    await h.close();
  });

  it('governance_policies: app role sees only its own org', async () => {
    await withOrg(h.db, orgA, (tx) =>
      tx.execute(
        sql`INSERT INTO governance_policies (org_id, name, effect, reason) VALUES (${orgA}, 'p1', 'deny', 'blocked')`,
      ),
    );
    const asB = await withOrg(h.db, orgB, (tx) =>
      tx.execute(sql`SELECT id FROM governance_policies`),
    );
    expect(asB).toHaveLength(0); // cross-org invisible
    const asA = await withOrg(h.db, orgA, (tx) =>
      tx.execute(sql`SELECT id FROM governance_policies`),
    );
    expect(asA).toHaveLength(1);
    const all = await h.adminSql`SELECT id FROM governance_policies`;
    expect(all).toHaveLength(1); // superuser bypasses RLS
  });

  it('decision_logs + routing_config_snapshots: org-isolated for app, jobs can SELECT + DELETE', async () => {
    await withOrg(h.db, orgA, (tx) =>
      tx.execute(
        sql`INSERT INTO routing_config_snapshots (hash, org_id, config) VALUES ('h1', ${orgA}, '{}'::jsonb)`,
      ),
    );
    await withOrg(h.db, orgA, (tx) =>
      tx.execute(
        sql`INSERT INTO decision_logs (decision_id, org_id, effect, enforcement, config_snapshot_hash, input_snapshot)
            VALUES (${randomUUID()}, ${orgA}, 'deny', 'enforce', 'h1', '{}'::jsonb)`,
      ),
    );

    // app role in a different org sees neither
    const dlB = await withOrg(h.db, orgB, (tx) => tx.execute(sql`SELECT 1 FROM decision_logs`));
    expect(dlB).toHaveLength(0);
    const snB = await withOrg(h.db, orgB, (tx) =>
      tx.execute(sql`SELECT 1 FROM routing_config_snapshots`),
    );
    expect(snB).toHaveLength(0);

    // spillway_jobs (retention sweeper) reads cross-tenant + can DELETE
    await h.adminSql.begin(async (tx) => {
      await tx`SET LOCAL ROLE spillway_jobs`;
      const logs = await tx`SELECT decision_id FROM decision_logs`;
      expect(logs.length).toBeGreaterThanOrEqual(1);
      const snaps = await tx`SELECT hash FROM routing_config_snapshots`;
      expect(snaps.length).toBeGreaterThanOrEqual(1);
      await tx`DELETE FROM decision_logs`;
      await tx`DELETE FROM routing_config_snapshots`;
    });
    expect(await h.adminSql`SELECT 1 FROM decision_logs`).toHaveLength(0);
    expect(await h.adminSql`SELECT 1 FROM routing_config_snapshots`).toHaveLength(0);
  });

  it('approval_decisions is append-only: app role can INSERT but not UPDATE (B0.3)', async () => {
    const approvalId = randomUUID();
    await withOrg(h.db, orgA, (tx) =>
      tx.execute(
        sql`INSERT INTO approval_decisions (org_id, approval_id, step_index, decided_by, decision)
            VALUES (${orgA}, ${approvalId}, 0, 'user_owner', 'approve')`,
      ),
    );
    // UPDATE by the app role must be permission-denied (REVOKE UPDATE, DELETE)
    await expect(
      withOrg(h.db, orgA, (tx) =>
        tx.execute(
          sql`UPDATE approval_decisions SET decision = 'deny' WHERE approval_id = ${approvalId}`,
        ),
      ),
    ).rejects.toThrow();
  });

  it('automation_rules priority swap in one tx does not 23505 (DEFERRABLE, B0.3)', async () => {
    const a = randomUUID();
    const b = randomUUID();
    await withOrg(h.db, orgA, (tx) =>
      tx.execute(
        sql`INSERT INTO automation_rules (id, org_id, priority, name, trigger_type, condition, action)
            VALUES (${a}, ${orgA}, 1, 'ra', 'alert_fired', '{}'::jsonb, '{}'::jsonb),
                   (${b}, ${orgA}, 2, 'rb', 'alert_fired', '{}'::jsonb, '{}'::jsonb)`,
      ),
    );
    // swap priorities within one tx — the intermediate (both=2) would 23505 without DEFERRABLE
    await expect(
      withOrg(h.db, orgA, async (tx) => {
        await tx.execute(sql`UPDATE automation_rules SET priority = 2 WHERE id = ${a}`);
        await tx.execute(sql`UPDATE automation_rules SET priority = 1 WHERE id = ${b}`);
      }),
    ).resolves.not.toThrow();
    const rows = await h.adminSql<
      { id: string; priority: number }[]
    >`SELECT id, priority FROM automation_rules WHERE org_id = ${orgA} ORDER BY priority`;
    expect(rows.map((r) => r.id)).toEqual([b, a]); // b now p1, a now p2
  });

  it('alert_events dedupes synthetic (alert_id NULL) events via NULLS NOT DISTINCT (B0.4 / N-1)', async () => {
    const dedupe = 'auto:rule1:evt1';
    const ins = (): Promise<unknown> =>
      withOrg(h.db, orgA, (tx) =>
        tx.execute(
          sql`INSERT INTO alert_events (org_id, alert_id, fired_at, dedupe_key, payload)
              VALUES (${orgA}, NULL, now(), ${dedupe}, '{}'::jsonb)
              ON CONFLICT (alert_id, dedupe_key) DO NOTHING`,
        ),
      );
    await ins();
    await ins(); // second insert must be a no-op (NULLS NOT DISTINCT → NULL alert_id collides)
    const rows =
      await h.adminSql`SELECT id FROM alert_events WHERE org_id = ${orgA} AND dedupe_key = ${dedupe}`;
    expect(rows).toHaveLength(1); // exactly-once inbox holds for NULL-alert_id events
  });
});
