import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { makeTestApp, type TestHarness } from '../../test/helpers/app.js';
import { syncRegistry } from './registry-sync.js';

/**
 * part-3/02 registry sync (against real Postgres): seeds model_registry from model_prices + adapter
 * caps, and — critically — NEVER overwrites a manually-curated (source='manual') row.
 */
describe('syncRegistry (0027)', () => {
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

  it('upserts a registry row per priced model with adapter-derived capabilities', async () => {
    await h.adminSql`INSERT INTO model_prices (provider, model, input_usd_per_m, output_usd_per_m, cache_read_usd_per_m, source, synced_at)
      VALUES ('openai', 'gpt-4o', 2.5, 10, 1.25, 'litellm', now()),
             ('openai', 'text-embedding-3-small', 0.02, 0, 0, 'litellm', now())`;

    const res = await syncRegistry(h.jobsDb);
    expect(res.upserted).toBe(2);

    const rows = await h.adminSql<
      { canonical_id: string; cap_tools: boolean; cap_embeddings: boolean }[]
    >`
      SELECT canonical_id, cap_tools, cap_embeddings FROM model_registry ORDER BY canonical_id`;
    expect(rows.map((r) => r.canonical_id)).toEqual([
      'openai/gpt-4o',
      'openai/text-embedding-3-small',
    ]);
    const gpt4o = rows.find((r) => r.canonical_id === 'openai/gpt-4o')!;
    expect(gpt4o.cap_tools).toBe(true);
    expect(gpt4o.cap_embeddings).toBe(false);
  });

  it('never overwrites a manually-curated row (source=manual)', async () => {
    await h.adminSql`INSERT INTO model_prices (provider, model, input_usd_per_m, output_usd_per_m, cache_read_usd_per_m, source, synced_at)
      VALUES ('openai', 'gpt-4o', 2.5, 10, 1.25, 'litellm', now())`;
    // A hand-curated registry row (e.g. ops disabled it) with source='manual'.
    await h.adminSql`INSERT INTO model_registry (canonical_id, provider_model_id, provider, lifecycle, source)
      VALUES ('openai/gpt-4o', 'gpt-4o', 'openai', 'disabled', 'manual')`;

    await syncRegistry(h.jobsDb);

    const [row] = await h.adminSql<{ lifecycle: string; source: string }[]>`
      SELECT lifecycle, source FROM model_registry WHERE canonical_id = 'openai/gpt-4o'`;
    expect(row!.lifecycle).toBe('disabled'); // sync did NOT flip it back to production
    expect(row!.source).toBe('manual');
  });
});
