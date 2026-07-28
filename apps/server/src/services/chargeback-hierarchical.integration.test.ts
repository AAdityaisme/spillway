import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { makeTestApp, type TestHarness } from '../../test/helpers/app.js';
import { generateHierarchicalStatement, type ChargebackTeamNode } from './chargeback.js';

/**
 * Hierarchical chargeback statement (20 §2.1): org → team → key → model, name-enriched, with the
 * ADR-035 dual reconciliation. Seeds a consistent ledger (each request's cost == its single attempt's
 * cost, org month counter == the sum) across two teams + an Unassigned bucket, and asserts the tree
 * nests + totals + reconciles to the cent.
 */
describe('hierarchical chargeback (20 §2.1)', () => {
  let h: TestHarness;
  const orgId = randomUUID();
  const teamA = randomUUID();
  const teamB = randomUUID();
  const kA = randomUUID();
  const kB = randomUUID();
  const kU = randomUUID();
  const month = new Date().toISOString().slice(0, 7);

  async function seed(
    vkId: string,
    teamId: string | null,
    model: string,
    cost: string,
  ): Promise<void> {
    const id = randomUUID();
    await h.adminSql`INSERT INTO requests (id, org_id, team_id, virtual_key_id, model, requested_model, endpoint, status, cost_usd, input_tokens, output_tokens)
      VALUES (${id}, ${orgId}, ${teamId}, ${vkId}, ${model}, ${model}, 'chat_completions', 'ok', ${cost}, 100, 50)`;
    await h.adminSql`INSERT INTO request_attempts (request_id, attempt_number, org_id, outcome, cost_usd)
      VALUES (${id}, 0, ${orgId}, 'ok', ${cost})`;
  }

  beforeEach(async () => {
    h = await makeTestApp();
    await h.adminSql`INSERT INTO orgs (id, name, slug) VALUES (${orgId}, 'Acme', ${'a-' + orgId.slice(0, 8)})`;
    await h.adminSql`INSERT INTO teams (id, org_id, name, slug) VALUES
      (${teamA}, ${orgId}, 'Engineering', 'eng'), (${teamB}, ${orgId}, 'Product', 'product')`;
    const mkKey = (id: string, name: string, team: string | null): Promise<unknown> =>
      h.adminSql`INSERT INTO virtual_keys (id, org_id, team_id, name, key_hash, key_prefix, status)
        VALUES (${id}, ${orgId}, ${team}, ${name}, ${Buffer.from(id)}, ${'mk-' + name}, 'active')`;
    await mkKey(kA, 'eng-key', teamA);
    await mkKey(kB, 'prod-key', teamB);
    await mkKey(kU, 'orphan-key', null);

    await seed(kA, teamA, 'gpt-4o', '0.100000'); // team A / eng-key / gpt-4o
    await seed(kA, teamA, 'claude-3', '0.200000'); // team A / eng-key / claude-3
    await seed(kB, teamB, 'gpt-4o', '0.050000'); // team B / prod-key / gpt-4o
    await seed(kU, null, 'gpt-4o', '0.030000'); // Unassigned / orphan-key / gpt-4o
    // org month counter == the sum (0.38) so the counter arm reconciles.
    await h.adminSql`INSERT INTO spend_counters (org_id, scope_type, scope_id, period_key, spent_usd)
      VALUES (${orgId}, 'org', ${orgId}, ${month}, 0.380000)`;
  });
  afterEach(async () => {
    await h.close();
  });

  const teamBy = (teams: ChargebackTeamNode[], name: string): ChargebackTeamNode =>
    teams.find((t) => t.teamName === name)!;

  it('nests org → team → key → model with per-level totals, reconciled to the cent', async () => {
    const s = await generateHierarchicalStatement(h.db, orgId, month);

    expect(s.totalUsd).toBe('0.380000');
    expect(s.reconciliation.consistent).toBe(true);
    expect(s.reconciliation.attemptsUsd).toBe('0.380000');
    expect(s.reconciliation.counterUsd).toBe('0.380000');
    expect(s.warnings).toEqual([]); // clean data → no billing-error detectors fire

    expect(s.teams.map((t) => t.teamName).sort()).toEqual(['Engineering', 'Product', 'Unassigned']);

    const eng = teamBy(s.teams, 'Engineering');
    expect(eng.totalUsd).toBe('0.300000'); // 0.10 + 0.20
    expect(eng.keys).toHaveLength(1);
    expect(eng.keys[0]!.keyName).toBe('eng-key');
    expect(eng.keys[0]!.keyPrefix).toBe('mk-eng-key');
    expect(eng.keys[0]!.models.map((m) => m.model).sort()).toEqual(['claude-3', 'gpt-4o']);
    const claude = eng.keys[0]!.models.find((m) => m.model === 'claude-3')!;
    expect(claude.totalUsd).toBe('0.200000');
    expect(claude.inputTokens).toBe(100);

    const unassigned = teamBy(s.teams, 'Unassigned');
    expect(unassigned.teamId).toBeNull();
    expect(unassigned.totalUsd).toBe('0.030000');
    expect(unassigned.keys[0]!.keyName).toBe('orphan-key');
  });

  it('flags a reconciliation drift when the counter disagrees with the ledger', async () => {
    await h.adminSql`UPDATE spend_counters SET spent_usd = 0.500000
      WHERE org_id = ${orgId} AND scope_type = 'org' AND period_key = ${month}`;
    const s = await generateHierarchicalStatement(h.db, orgId, month);
    expect(s.reconciliation.consistent).toBe(false);
    expect(s.reconciliation.deltaCounterUsd).toBe('0.120000'); // 0.50 - 0.38
  });

  it('flags billing-error detectors D2 (zero-output-billed) + D3 (retry storm) (§2.7)', async () => {
    // D2: a served chat request billed with zero output tokens.
    const z = randomUUID();
    await h.adminSql`INSERT INTO requests (id, org_id, virtual_key_id, model, requested_model, endpoint, status, cost_usd, input_tokens, output_tokens)
      VALUES (${z}, ${orgId}, ${kA}, 'gpt-4o', 'gpt-4o', 'chat_completions', 'ok', 0.010000, 200, 0)`;
    await h.adminSql`INSERT INTO request_attempts (request_id, attempt_number, org_id, outcome, cost_usd)
      VALUES (${z}, 0, ${orgId}, 'ok', 0.010000)`;
    // D3: one logical request with 4 billed attempts to the SAME candidate (retry storm).
    const storm = randomUUID();
    await h.adminSql`INSERT INTO requests (id, org_id, virtual_key_id, model, requested_model, endpoint, status, cost_usd, input_tokens, output_tokens)
      VALUES (${storm}, ${orgId}, ${kA}, 'gpt-4o', 'gpt-4o', 'chat_completions', 'ok', 0.040000, 100, 50)`;
    for (let i = 0; i < 4; i++)
      await h.adminSql`INSERT INTO request_attempts (request_id, attempt_number, org_id, provider, model, outcome, cost_usd)
        VALUES (${storm}, ${i}, ${orgId}, 'openai', 'gpt-4o', 'ok', 0.010000)`;

    const s = await generateHierarchicalStatement(h.db, orgId, month);
    const byKind = new Map(s.warnings.map((w) => [w.detector, w]));
    expect([...byKind.keys()].sort()).toEqual(['retry_storm_dup', 'zero_output_billed']);
    expect(byKind.get('zero_output_billed')!.affectedRequests).toBe(1);
    expect(byKind.get('zero_output_billed')!.suspectUsd).toBe('0.010000');
    const d3 = byKind.get('retry_storm_dup')!;
    expect(d3.affectedRequests).toBe(1); // one (request, candidate) group with ≥4 attempts
    expect(d3.detail.max_attempts_on_one_candidate).toBe(4);
    expect(d3.suspectUsd).toBe('0.030000'); // 4×0.01 − 0.01 (first attempt) = 0.03
  });
});
