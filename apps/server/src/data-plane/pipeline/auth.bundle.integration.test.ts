import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { makeTestApp, type TestHarness } from '../../../test/helpers/app.js';
import { loadBundle } from './auth.js';
import { BufbuildConditionEvaluator } from '../policy/condition-evaluator.js';

const evaluator = new BufbuildConditionEvaluator();

/**
 * B1.1 exit-gate: loadBundle v2 hydrates the fat bundle (vk limits + provider keys + compiled
 * aliases/rules/policies/budgets + config-snapshot hash) in one withOrg round-trip; the hash is
 * stable across identical config and the snapshot row is upserted exactly once.
 */
const sha = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest();

describe('loadBundle v2 — fat bundle in one round-trip (B1.1)', () => {
  let h: TestHarness;
  const org = randomUUID();
  const vkId = randomUUID();
  const raw = 'mk-live-test-b11';

  beforeAll(async () => {
    h = await makeTestApp();
    await h.adminSql`INSERT INTO orgs (id, name, slug) VALUES (${org}, 'B11', ${'b11-' + org.slice(0, 8)})`;
    await h.adminSql`INSERT INTO virtual_keys
      (id, org_id, name, key_hash, key_prefix, status, rpm_limit, tpm_limit, max_parallel)
      VALUES (${vkId}, ${org}, 'k', ${sha(raw)}, 'mk-live-xxxx', 'active', 100, 200, 8)`;
    await h.adminSql`INSERT INTO provider_keys
      (org_id, provider, label, key_prefix, key_ciphertext, key_iv, key_tag, enc_version, status)
      VALUES (${org}, 'openai', 'o', 'sk-x', ${Buffer.from('c')}, ${Buffer.from('i')}, ${Buffer.from('t')}, 1, 'active')`;
    await h.adminSql`INSERT INTO model_aliases (org_id, alias, targets)
      VALUES (${org}, 'fast', '[{"provider":"openai","model":"gpt-4o-mini"}]'::jsonb)`;
    await h.adminSql`INSERT INTO routing_rules (org_id, priority, match, action, enabled)
      VALUES (${org}, 10, '{}'::jsonb, '{"type":"rewrite_model","to":{"provider":"openai","model":"gpt-4o"}}'::jsonb, true)`;
    await h.adminSql`INSERT INTO governance_policies (org_id, name, effect, reason)
      VALUES (${org}, 'block-x', 'deny', 'nope')`;
    await h.adminSql`INSERT INTO budgets (org_id, scope_type, scope_id, period, limit_usd)
      VALUES (${org}, 'org', ${org}, 'day', 100)`;
  });
  afterAll(async () => {
    await h.close();
  });

  it('loads vk limits + provider keys + compiled config + snapshot hash', async () => {
    const b = await loadBundle(sha(raw), h.db, evaluator);
    expect(b).not.toBeNull();
    expect(b!.orgId).toBe(org);
    expect(b!.rpmLimit).toBe(100);
    expect(b!.tpmLimit).toBe(200);
    expect(b!.maxParallel).toBe(8);
    expect(b!.providerKeys).toHaveLength(1);
    expect(b!.aliases).toHaveLength(1);
    expect(b!.aliases[0]!.alias).toBe('fast');
    expect(b!.routingRules).toHaveLength(1);
    expect(b!.governancePolicies).toHaveLength(1);
    expect(b!.budgets).toHaveLength(1);
    expect(b!.configSnapshotHash).toMatch(/^[0-9a-f]{32}$/);
  });

  it('configSnapshotHash stable across identical config; snapshot row upserted once', async () => {
    const b1 = await loadBundle(sha(raw), h.db, evaluator);
    const b2 = await loadBundle(sha(raw), h.db, evaluator);
    expect(b1!.configSnapshotHash).toBe(b2!.configSnapshotHash);
    const snaps = await h.adminSql<
      { hash: string }[]
    >`SELECT hash FROM routing_config_snapshots WHERE org_id = ${org}`;
    expect(snaps).toHaveLength(1); // one hash, upserted once despite N loads
    expect(snaps[0]!.hash).toBe(b1!.configSnapshotHash);
  });
});
