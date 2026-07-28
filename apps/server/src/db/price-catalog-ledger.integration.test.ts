import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { makeTestApp, type TestHarness } from '../../test/helpers/app.js';
import { writeCatalogVersion } from './pricing-sync.js';
import {
  getActiveCatalogVersionId,
  resetCatalogVersionCache,
} from '../data-plane/pricing-catalog.js';

/**
 * part-3/04 reproducibility ledger: a sync run freezes an immutable snapshot of the live model_prices
 * table as a catalog version. A request stamped with that version re-derives its exact cost from the
 * snapshot even after model_prices later changes.
 */
describe('price catalog ledger (0029)', () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = await makeTestApp();
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await h.adminSql`TRUNCATE model_prices, price_catalog_versions CASCADE`;
    resetCatalogVersionCache();
  });

  it('snapshots the live table into an immutable version that survives a later rate change', async () => {
    await h.adminSql`INSERT INTO model_prices (provider, model, input_usd_per_m, output_usd_per_m, cache_read_usd_per_m, source, synced_at)
      VALUES ('openai', 'gpt-4o', 2.5, 10, 1.25, 'litellm', now())`;
    const v1 = await writeCatalogVersion(h.jobsDb, {
      sourceName: 'litellm_vendored',
      syncedAt: new Date(),
    });

    // The live rate later changes; the frozen snapshot must NOT.
    await h.adminSql`UPDATE model_prices SET input_usd_per_m = 99 WHERE provider='openai' AND model='gpt-4o'`;
    const [snap] = await h.adminSql<{ input_usd_per_m: string }[]>`
      SELECT input_usd_per_m FROM price_catalog_snapshots WHERE catalog_version_id = ${v1} AND model='gpt-4o'`;
    expect(Number(snap!.input_usd_per_m)).toBe(2.5); // reproducible — the live table is now 99
  });

  it('getActiveCatalogVersionId returns the latest approved version (NULL when empty)', async () => {
    expect(await getActiveCatalogVersionId(h.db, Date.now())).toBeNull(); // empty ledger → legacy-safe

    await h.adminSql`INSERT INTO model_prices (provider, model, input_usd_per_m, output_usd_per_m, cache_read_usd_per_m, source, synced_at)
      VALUES ('openai', 'gpt-4o', 2.5, 10, 1.25, 'litellm', now())`;
    const v1 = await writeCatalogVersion(h.jobsDb, {
      sourceName: 'litellm_vendored',
      syncedAt: new Date(),
    });
    resetCatalogVersionCache();
    expect(await getActiveCatalogVersionId(h.db, Date.now())).toBe(v1);
  });

  it('a rejected version is never active', async () => {
    await h.adminSql`INSERT INTO price_catalog_versions (source_name, approval_state) VALUES ('manual', 'rejected')`;
    resetCatalogVersionCache();
    expect(await getActiveCatalogVersionId(h.db, Date.now())).toBeNull();
  });
});
