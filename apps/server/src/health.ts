import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'drizzle-orm';
import { pingDb, type DatabaseClient } from './db/client.js';

export interface HealthPluginOptions {
  db?: DatabaseClient;
}

const HOUR_MS = 3_600_000;
const PRICING_STALE_MS = 48 * HOUR_MS; // warn: prices drifting
const PRICING_VERY_STALE_MS = 72 * HOUR_MS; // degraded: pricing-sync is likely broken

type PricingStatus = 'ok' | 'stale' | 'very_stale' | 'empty' | 'unknown';

/**
 * Pricing freshness for /readyz (12-operations §3.1). Reads the newest `synced_at` in the GLOBAL
 * (RLS-exempt) model_prices table. Fail-OPEN by design: very-stale prices flag the readiness payload
 * as degraded (so monitoring pages the operator) but do NOT 503 the node — a gateway that still bills
 * with last-known prices beats one pulled out of rotation the moment pricing-sync hiccups. The one
 * true not-ready condition is an unreachable DB.
 */
async function pricingFreshness(db: DatabaseClient): Promise<PricingStatus> {
  try {
    const rows = (await db.execute(
      sql`SELECT max(synced_at) AS latest FROM model_prices`,
    )) as unknown as { latest: string | Date | null }[];
    const latest = rows[0]?.latest ?? null;
    if (!latest) return 'empty';
    const ageMs = Date.now() - new Date(latest).getTime();
    if (ageMs > PRICING_VERY_STALE_MS) return 'very_stale';
    if (ageMs > PRICING_STALE_MS) return 'stale';
    return 'ok';
  } catch {
    return 'unknown';
  }
}

/**
 * Liveness + readiness (02-architecture §6, 12-operations §3.1).
 * `/healthz` is pure liveness (process up) — what Fly's health check hits, so a
 * degraded-but-alive process is never restarted. `/readyz` reports DB
 * reachability (and, from M2, pricing freshness) and is monitored separately.
 */
export const healthPlugin: FastifyPluginAsync<HealthPluginOptions> = async (fastify, opts) => {
  fastify.get('/healthz', async () => ({ status: 'ok' as const }));

  fastify.get('/readyz', async (_req, reply) => {
    const dbOk = opts.db ? await pingDb(opts.db) : false;
    const pricing = dbOk && opts.db ? await pricingFreshness(opts.db) : 'unknown';
    // Only an unreachable DB makes the node not-ready (503); pricing staleness degrades the payload
    // for monitoring but keeps the node serving (fail-open — see pricingFreshness).
    const degraded = !dbOk || pricing === 'very_stale' || pricing === 'unknown';
    return reply.code(dbOk ? 200 : 503).send({
      status: degraded ? 'degraded' : 'ok',
      checks: { db: dbOk ? 'ok' : 'unreachable', pricing },
    });
  });
};
