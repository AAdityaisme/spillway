import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { makeTestApp, type TestHarness } from '../../test/helpers/app.js';
import { syncRegistry } from './registry-sync.js';
import { findCapabilityDrift, type RegistryCapRow } from './registry-certify.js';

/**
 * Overlap-3 anti-drift lock (part-3 certification): the registry may never claim a capability the
 * adapter can't deliver. A synced registry matches by construction (sync seeds cap_* from the adapter);
 * a MANUAL over-claim is caught.
 */
describe('registry ↔ adapter capability drift (0027)', () => {
  let h: TestHarness;

  const capCols = async (): Promise<RegistryCapRow[]> =>
    (await h.adminSql`SELECT canonical_id, provider, provider_model_id, cap_streaming, cap_tools,
       cap_structured_output, cap_vision, cap_audio_input, cap_audio_output, cap_embeddings, cap_batch,
       cap_reasoning, cap_prompt_cache FROM model_registry`) as unknown as RegistryCapRow[];

  beforeAll(async () => {
    h = await makeTestApp();
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await h.adminSql`TRUNCATE model_registry, model_prices CASCADE`;
  });

  it('a synced registry has ZERO drift (cap_* seeded from the adapter)', async () => {
    await h.adminSql`INSERT INTO model_prices (provider, model, input_usd_per_m, output_usd_per_m, cache_read_usd_per_m, source, synced_at)
      VALUES ('openai', 'gpt-4o', 2.5, 10, 1.25, 'litellm', now()),
             ('openai', 'text-embedding-3-small', 0.02, 0, 0, 'litellm', now())`;
    await syncRegistry(h.jobsDb);
    expect(findCapabilityDrift(await capCols())).toEqual([]);
  });

  it('catches a manual row over-claiming a capability the adapter denies', async () => {
    // Ops hand-curates an embeddings model but wrongly flips cap_tools true — the adapter says false.
    await h.adminSql`INSERT INTO model_registry (canonical_id, provider_model_id, provider, lifecycle, source, cap_tools)
      VALUES ('openai/text-embedding-3-small', 'text-embedding-3-small', 'openai', 'beta', 'manual', true)`;
    const drift = findCapabilityDrift(await capCols());
    expect(drift).toHaveLength(1);
    expect(drift[0]).toMatchObject({ feature: 'tools', capColumn: 'cap_tools' });
  });
});
