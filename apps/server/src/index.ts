import { loadConfig, workosIssuer } from './config.js';
import { makeDb } from './db/client.js';
import { buildApp, type AppOptions } from './app.js';
import { startScheduler, type SchedulerHandle } from './jobs/scheduler.js';
import { makeHttpChannelSink } from './services/alerts/delivery.js';
import { makeResendEmailSender } from './services/alerts/resend.js';

/**
 * Boot sequence (13-build-order §M0.4): env validation (zod) → build app →
 * listen → scheduler. Production migrations run via the Fly release command
 * (migrate.ts), not at boot. The DB client is lazy, so boot succeeds without a
 * live Postgres; `/readyz` reports reachability.
 *
 * v2 seam (12-operations §6.5): @opentelemetry/sdk-node initializes here, before
 * Fastify starts. `request_id` maps to `trace.id`; adding OTel is additive.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const dbHandle = makeDb(config.DATABASE_URL, config.DB_POOL_MAX);

  // DEV-ONLY auth seam. In development WITHOUT WorkOS configured, verify session JWTs against a LOCAL
  // JWKS (the same dev keypair `pnpm dev:token` mints with) instead of WorkOS's remote JWKS — so the
  // dashboard is usable locally without a WorkOS tenant. This is doubly unreachable in production:
  // NODE_ENV must be 'development' AND WORKOS_CLIENT_ID must be unset, yet config's superRefine already
  // REQUIRES WORKOS_CLIENT_ID whenever NODE_ENV==='production'. The dynamic import keeps the test-utils
  // keypair out of the production module graph.
  let auth: AppOptions['auth'];
  const devAuth = config.NODE_ENV === 'development' && !config.WORKOS_CLIENT_ID;
  if (devAuth) {
    const { devJwks } = await import('./auth/dev-jwks.js');
    auth = {
      jwks: await devJwks(),
      verifyOpts: { issuer: workosIssuer(config) },
    };
  }

  const app = await buildApp({
    config,
    db: dbHandle.db,
    logger: { level: config.LOG_LEVEL },
    auth,
  });

  if (devAuth)
    app.log.warn(
      'DEV AUTH MODE — session JWTs verified against a LOCAL dev JWKS, not WorkOS. NEVER run this configuration in production.',
    );

  const address = await app.listen({ port: config.PORT, host: '0.0.0.0' });
  app.log.info(`Spillway listening on ${address} (${config.NODE_ENV})`);

  // Background jobs (18 §3.3 / 19 §2.2): poller lease every 15s, anomaly-scan hourly.
  // Own connection pool on the spillway_jobs role — the cross-org privilege boundary.
  let jobsHandle: ReturnType<typeof makeDb> | null = null;
  let scheduler: SchedulerHandle | null = null;
  if (config.JOBS_ENABLED) {
    jobsHandle = makeDb(config.DATABASE_URL_JOBS, 5);
    scheduler = startScheduler({
      jobsDb: jobsHandle.db,
      db: dbHandle.db,
      log: app.log,
      // Per-org channel router (§20 §5): each event delivers to its own org's configured channels, so
      // there's no shared single-tenant webhook. Email is env-gated: it needs BOTH the Resend key and
      // a verified from-address; with either missing, email channels dead-letter with a clear error
      // while Slack + HMAC webhook keep working.
      sink: makeHttpChannelSink({
        fetch: fetch as unknown as (
          url: string,
          init: Record<string, unknown>,
        ) => Promise<{ ok: boolean; status: number }>,
        email:
          config.RESEND_API_KEY && config.ALERT_FROM_EMAIL
            ? makeResendEmailSender(config.RESEND_API_KEY, config.ALERT_FROM_EMAIL)
            : undefined,
      }),
    });
    app.log.info('job scheduler started (poller 15s, anomaly-scan hourly)');
  }

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`${signal} received — shutting down`);
    await scheduler?.stop();
    await app.close();
    await jobsHandle?.close();
    await dbHandle.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
