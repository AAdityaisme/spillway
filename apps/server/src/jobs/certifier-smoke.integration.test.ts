import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { makeTestApp, type TestHarness } from '../../test/helpers/app.js';
import { runSmoke } from './certifier-smoke.js';

/**
 * part-3/06 layer-2 smoke — the env-gated orchestration (no live calls in the harness). With no provider
 * keys in the environment, every provider is skipped and zero results are written — the guard that keeps
 * the nightly job from failing (or spending) when secrets are absent. The live probe path itself is only
 * exercised in the nightly CI job with real credentials.
 */
describe('certifier-smoke (env-gated)', () => {
  let h: TestHarness;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    h = await makeTestApp();
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await h.adminSql`TRUNCATE certifier_results`;
    // Ensure no provider keys leak in from the environment for this deterministic test.
    for (const k of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY']) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  it('writes zero results and never calls a provider when no API keys are set', async () => {
    const { written } = await runSmoke(h.jobsDb);
    expect(written).toBe(0);
    const rows = await h.adminSql`SELECT 1 FROM certifier_results`;
    expect(rows).toHaveLength(0);
    for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
  });
});
