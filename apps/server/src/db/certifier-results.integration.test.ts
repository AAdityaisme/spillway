import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { makeTestApp, type TestHarness } from '../../test/helpers/app.js';
import { getCatalogCapabilities } from '../data-plane/certification.js';

/**
 * part-3/06 certifier_results (0030) — the nightly smoke ledger + the /v1/models catalog resolver.
 * A capability appears only if declared AND smoke-passed within 72h; a stale/failed pass is demoted;
 * a provider with no smoke result falls back to the fixture-certified DECLARED_CAPS.
 */
describe('certifier_results + catalog resolver (0030)', () => {
  let h: TestHarness;

  const record = (
    provider: string,
    capability: string,
    status: string,
    ageHours = 0,
  ): Promise<unknown> =>
    h.adminSql`INSERT INTO certifier_results (run_id, provider, capability, model, status, created_at)
      VALUES (${randomUUID()}, ${provider}, ${capability}, 'm', ${status}, now() - (${ageHours} * interval '1 hour'))`;

  beforeAll(async () => {
    h = await makeTestApp();
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await h.adminSql`TRUNCATE certifier_results`;
  });

  it('a provider with no smoke result falls back to DECLARED_CAPS (fixture-certified)', async () => {
    const caps = await getCatalogCapabilities(h.db, 'openai');
    expect(caps.has('CHAT_NONSTREAM')).toBe(true);
    expect(caps.has('VISION')).toBe(true); // declared, no smoke yet → still catalogued
  });

  it('intersects DECLARED_CAPS with a recent passing smoke run; demotes an un-passed declared cap', async () => {
    await record('openai', 'CHAT_NONSTREAM', 'PASS');
    await record('openai', 'VISION', 'FAIL'); // declared but smoke-failed → demoted
    const caps = await getCatalogCapabilities(h.db, 'openai');
    expect(caps.has('CHAT_NONSTREAM')).toBe(true);
    expect(caps.has('VISION')).toBe(false); // failed smoke → not in the catalog
    expect(caps.has('EMBEDDINGS')).toBe(false); // declared but no pass in this run → demoted
  });

  it('a passing result older than 72h does not count', async () => {
    await record('openai', 'CHAT_NONSTREAM', 'PASS', 100); // 100h ago
    const caps = await getCatalogCapabilities(h.db, 'openai');
    // Only the stale row exists → treated as "no recent smoke" → DECLARED_CAPS fallback.
    expect(caps.has('CHAT_NONSTREAM')).toBe(true);
    expect(caps.has('VISION')).toBe(true); // fallback restores the full declared set
  });

  it('the status CHECK rejects an invalid status', async () => {
    await expect(record('openai', 'CHAT_NONSTREAM', 'MAYBE')).rejects.toThrow(/status|check/i);
  });
});
