import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { makeTestApp, type TestHarness } from '../../test/helpers/app.js';

/**
 * Part III model-registry (part-3/02) migration 0027 — proves the additive schema applies and enforces
 * its invariants: the production-caps CHECK, the residency/lifecycle enums, the v_model_registry_active
 * view (registry ⋈ live model_prices, disabled rows excluded), and the residency-input columns.
 */
describe('model_registry (0027)', () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = await makeTestApp();
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await h.adminSql`TRUNCATE model_registry, model_prices CASCADE`;
  });

  it('stores a registry row and surfaces it (joined to model_prices) in the active view', async () => {
    await h.adminSql`INSERT INTO model_prices (provider, model, input_usd_per_m, output_usd_per_m, cache_read_usd_per_m, source, synced_at)
      VALUES ('openai', 'gpt-4o', 2.5, 10, 1.25, 'litellm', now())`;
    await h.adminSql`INSERT INTO model_registry
      (canonical_id, provider_model_id, provider, lifecycle, routing_eligible, cap_tools, cap_vision,
       cap_streaming, cap_structured_output, cap_audio_input, cap_audio_output, cap_embeddings, cap_batch,
       cap_reasoning, cap_prompt_cache, context_window, max_output_tokens)
      VALUES ('openai/gpt-4o', 'gpt-4o', 'openai', 'production', true, true, true,
              true, true, false, false, false, false, false, true, 128000, 16384)`;

    const view = await h.adminSql<
      { canonical_id: string; cap_tools: boolean; input_usd_per_m: string }[]
    >`
      SELECT canonical_id, cap_tools, input_usd_per_m FROM v_model_registry_active`;
    expect(view).toHaveLength(1);
    expect(view[0]!.cap_tools).toBe(true);
    expect(Number(view[0]!.input_usd_per_m)).toBe(2.5); // priced via the live model_prices join
  });

  it('excludes disabled models from the active view (soft-delete = one UPDATE)', async () => {
    await h.adminSql`INSERT INTO model_registry (canonical_id, provider_model_id, provider, lifecycle)
      VALUES ('openai/old', 'old', 'openai', 'disabled')`;
    const view = await h.adminSql`SELECT 1 FROM v_model_registry_active`;
    expect(view).toHaveLength(0);
  });

  it('rejects a production row missing its capability matrix (production_caps CHECK)', async () => {
    await expect(
      h.adminSql`INSERT INTO model_registry (canonical_id, provider_model_id, provider, lifecycle, cap_tools)
        VALUES ('openai/incomplete', 'incomplete', 'openai', 'production', true)`,
    ).rejects.toThrow(/production_caps|check/i);
  });

  it('rejects an invalid lifecycle / residency_class enum', async () => {
    await expect(
      h.adminSql`INSERT INTO model_registry (canonical_id, provider_model_id, provider, lifecycle)
        VALUES ('x/y', 'y', 'x', 'bogus')`,
    ).rejects.toThrow(/lifecycle/i);
    await expect(
      h.adminSql`INSERT INTO model_registry (canonical_id, provider_model_id, provider, residency_class)
        VALUES ('x/z', 'z', 'x', 'mars_only')`,
    ).rejects.toThrow(/residency/i);
  });

  it('carries the residency-enforcement input columns (key + org default)', async () => {
    const org = randomUUID();
    await h.adminSql`INSERT INTO orgs (id, name, slug, default_compliance_class) VALUES (${org}, 'A', ${'a-' + org.slice(0, 8)}, 'us_only')`;
    const [row] = await h.adminSql<{ default_compliance_class: string }[]>`
      SELECT default_compliance_class FROM orgs WHERE id = ${org}`;
    expect(row!.default_compliance_class).toBe('us_only');
    // virtual_keys.compliance_class exists + defaults to NULL (inherit the org default).
    const vk = randomUUID();
    await h.adminSql`INSERT INTO virtual_keys (id, org_id, name, key_hash, key_prefix, status)
      VALUES (${vk}, ${org}, 'k', ${Buffer.from(vk)}, 'mk-x', 'active')`;
    const [k] = await h.adminSql<{ compliance_class: string | null }[]>`
      SELECT compliance_class FROM virtual_keys WHERE id = ${vk}`;
    expect(k!.compliance_class).toBeNull();
  });
});
