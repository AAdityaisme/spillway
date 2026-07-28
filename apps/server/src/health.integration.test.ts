import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeTestApp, type TestHarness } from '../test/helpers/app.js';

/**
 * /readyz pricing freshness (12-operations §3.1). Fail-open: stale pricing degrades the payload for
 * monitoring but never 503s a node that can still bill with last-known prices; only DB-down is 503.
 */
describe('readyz pricing freshness (12-ops §3.1)', () => {
  let h: TestHarness;
  beforeEach(async () => {
    h = await makeTestApp();
  });
  afterEach(async () => {
    await h.close();
  });

  it('empty model_prices → ready(200), pricing "empty"', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ checks: { pricing: string } }>().checks.pricing).toBe('empty');
  });

  it('fresh prices → ok; very-stale → still 200 but degraded (fail-open)', async () => {
    await h.adminSql`
      INSERT INTO model_prices (provider, model, input_usd_per_m, output_usd_per_m, source, synced_at)
      VALUES ('openai', 'gpt-freshness-probe', 1, 1, 'test', now())`;
    const fresh = await h.app
      .inject({ method: 'GET', url: '/readyz' })
      .then((r) => r.json<{ status: string; checks: { pricing: string } }>());
    expect(fresh.checks.pricing).toBe('ok');
    expect(fresh.status).toBe('ok');

    await h.adminSql`UPDATE model_prices SET synced_at = now() - interval '80 hours'`;
    const stale = await h.app.inject({ method: 'GET', url: '/readyz' });
    expect(stale.statusCode).toBe(200); // fail-open: still serving
    const body = stale.json<{ status: string; checks: { pricing: string } }>();
    expect(body.checks.pricing).toBe('very_stale');
    expect(body.status).toBe('degraded');
  });
});
