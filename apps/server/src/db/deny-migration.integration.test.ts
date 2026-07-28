import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { makeTestApp, type TestHarness } from '../../test/helpers/app.js';

/**
 * B0.5 exit-gate: the 16 §10 deny→governance_policies migration is behavior-preserving —
 * enabled/disabled + reason carried, migrated as `enforce` (un-shadowable now), deny routing
 * rules deleted, non-deny rewrite rules untouched. (0019 already ran as a 0-row no-op on the
 * fresh template; here we seed deny rules then run the same SQL to prove the semantics.)
 */
describe('deny → governance_policies migration (16 §10, B0.5)', () => {
  let h: TestHarness;
  const org = randomUUID();

  beforeAll(async () => {
    h = await makeTestApp();
    await h.adminSql`INSERT INTO orgs (id, name, slug) VALUES (${org}, 'D', ${'d-' + org.slice(0, 8)})`;
    await h.adminSql`INSERT INTO routing_rules (org_id, priority, match, action, enabled) VALUES
      (${org}, 10, '{"models":["gpt-5.5"]}'::jsonb, '{"type":"deny","reason":"blocked-5.5"}'::jsonb, true),
      (${org}, 20, '{}'::jsonb, '{"type":"deny"}'::jsonb, false),
      (${org}, 30, '{}'::jsonb, '{"type":"rewrite_model","model":"gpt-4o"}'::jsonb, true)`;
  });
  afterAll(async () => {
    await h.close();
  });

  it('carries enabled + reason, migrates as enforce, deletes deny rules, keeps rewrites', async () => {
    await h.adminSql.unsafe(`
      INSERT INTO governance_policies
        (id, org_id, name, description, effect, reason, match,
         condition_cel, condition_program, condition_cost,
         enforcement, enabled, effect_config, revision, created_by, created_at, updated_at)
      SELECT gen_random_uuid(), rr.org_id, 'migrated-deny-p'||rr.priority,
             'Migrated from routing_rules deny (priority '||rr.priority||')', 'deny',
             COALESCE(rr.action->>'reason','model_blocked_by_policy'), rr.match,
             NULL, NULL, NULL, 'enforce', rr.enabled, '{}', 1, NULL, now(), now()
      FROM routing_rules rr WHERE rr.action->>'type' = 'deny';
      DELETE FROM routing_rules WHERE action->>'type' = 'deny';
    `);

    const pols = await h.adminSql<
      { name: string; effect: string; enforcement: string; enabled: boolean; reason: string }[]
    >`SELECT name, effect, enforcement, enabled, reason FROM governance_policies WHERE org_id = ${org} ORDER BY name`;
    expect(pols).toHaveLength(2);
    expect(pols[0]).toMatchObject({
      name: 'migrated-deny-p10',
      effect: 'deny',
      enforcement: 'enforce',
      enabled: true,
      reason: 'blocked-5.5',
    });
    expect(pols[1]).toMatchObject({
      name: 'migrated-deny-p20',
      enabled: false,
      reason: 'model_blocked_by_policy', // default carried
    });

    const rules = await h.adminSql<{ priority: number }[]>`
      SELECT priority FROM routing_rules WHERE org_id = ${org}`;
    expect(rules.map((r) => Number(r.priority))).toEqual([30]); // deny rules gone, rewrite survives
  });
});
