import { describe, it, expect, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { testConfig } from '../../../test/helpers/config.js';

/** /metrics (12-ops §3.2): open without METRICS_TOKEN, bearer-gated with it. No DB needed. */
describe('GET /metrics', () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app.close();
  });

  it('serves prometheus text when no token is configured (dev)', async () => {
    app = await buildApp({ config: testConfig() });
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('spillway_reconcile_duration_ms');
    expect(res.body).toContain('spillway_spend_write_lost_total');
    expect(res.body).toContain('spillway_job_runs_total');
    expect(res.body).toContain('spillway_policy_cache_singleton_violated');
  });

  it('401s a wrong/missing bearer when METRICS_TOKEN is set; accepts the right one', async () => {
    app = await buildApp({ config: testConfig({ METRICS_TOKEN: 'scrape-secret' }) });
    expect((await app.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/metrics',
          headers: { authorization: 'Bearer nope' },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/metrics',
          headers: { authorization: 'Bearer scrape-secret' },
        })
      ).statusCode,
    ).toBe(200);
  });
});
