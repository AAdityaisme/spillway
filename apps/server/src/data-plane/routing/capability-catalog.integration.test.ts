import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { makeTestApp, type TestHarness } from '../../../test/helpers/app.js';
import { loadCapabilityCatalog } from './capability-catalog.js';

/**
 * 15 §5.1 catalog load — the DB-specific half of the capability hard-filter: reads the
 * `model_prices.capabilities` text[] column into the `provider:model → caps` map resolve.ts filters
 * against. The filter math itself is unit-tested in resolve.test.ts; this proves the array round-trips
 * and that NULL/empty rows are EXCLUDED (so an unpopulated catalog stays empty → filter fails open).
 */
describe('loadCapabilityCatalog (15 §5.1)', () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = await makeTestApp();
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await h.adminSql`TRUNCATE model_prices`;
  });

  const seed = (provider: string, model: string, caps: string[] | null): Promise<unknown> =>
    h.adminSql`INSERT INTO model_prices
      (provider, model, input_usd_per_m, output_usd_per_m, cache_read_usd_per_m, capabilities, source, synced_at)
      VALUES (${provider}, ${model}, 2, 8, 0.5, ${caps}, 'test', now())`;

  it('maps populated rows by provider:model and excludes NULL / empty-capability rows', async () => {
    await seed('openai', 'gpt-4o', ['tools', 'vision']);
    await seed('openai', 'gpt-4o-mini', ['vision']);
    await seed('openai', 'embed-3', null); // no advertised capabilities
    await seed('openai', 'legacy', []); // explicit empty → also excluded

    const catalog = await loadCapabilityCatalog(h.db);

    expect(catalog.get('openai:gpt-4o')).toEqual(['tools', 'vision']);
    expect(catalog.get('openai:gpt-4o-mini')).toEqual(['vision']);
    expect(catalog.has('openai:embed-3')).toBe(false);
    expect(catalog.has('openai:legacy')).toBe(false);
    expect(catalog.size).toBe(2);
  });

  it('an entirely unpopulated catalog loads empty (drives resolve.ts fail-open)', async () => {
    await seed('openai', 'gpt-4o', null);
    const catalog = await loadCapabilityCatalog(h.db);
    expect(catalog.size).toBe(0);
  });
});
