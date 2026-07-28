import { timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import type { Config } from '../../config.js';
import { registry } from '../../observability/metrics.js';

/** Constant-time bearer compare (red-team: `!==` was a timing oracle on METRICS_TOKEN). */
function bearerOk(authorization: string | undefined, token: string): boolean {
  const expected = Buffer.from(`Bearer ${token}`);
  const got = Buffer.from(authorization ?? '');
  return got.length === expected.length && timingSafeEqual(got, expected);
}

/**
 * GET /metrics (12-operations §3.2) — prom-client scrape endpoint. Registered OUTSIDE the
 * control-plane auth hook: the scraper authenticates with the static METRICS_TOKEN bearer,
 * not a WorkOS JWT. Without the token set (dev), the endpoint is open — §3.2 requires it in
 * production (config superRefine does not force it; the runbook does).
 */
export const metricsRoute: FastifyPluginAsync<{ config?: Config }> = async (fastify, opts) => {
  fastify.get('/metrics', async (req, reply) => {
    const token = opts.config?.METRICS_TOKEN;
    if (token && !bearerOk(req.headers.authorization, token)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    reply.header('content-type', registry.contentType);
    return registry.metrics();
  });
};
