import Fastify, { type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { JWTVerifyGetKey } from 'jose';
import type { Dispatcher } from 'undici';
import type { Config } from './config.js';
import type { DatabaseClient } from './db/client.js';
import type { VerifyOptions } from './auth/workos-jwt.js';
import { healthPlugin } from './health.js';
import { metricsRoute } from './control-plane/routes/metrics.js';
import { staticPlugin } from './static.js';
import { dataPlanePlugin } from './data-plane/plugin.js';
import { controlPlanePlugin } from './control-plane/plugin.js';
import { actionLinksPlugin } from './action-links.js';
import { addSecurityHeaders } from './security-headers.js';

/**
 * Pino redaction (10-security §7.3): secrets must never reach the log stream even if a handler logs a
 * whole request/config object. Covers auth material, provider-key ciphertext components, key plaintext,
 * and webhook URLs (which carry Slack/webhook tokens in the path).
 */
const LOG_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["x-spillway-org"]',
  '*.authorization',
  '*.apiKey',
  '*.api_key',
  '*.key',
  '*.plaintext',
  '*.key_ciphertext',
  '*.key_iv',
  '*.key_tag',
  '*.access_token',
  '*.webhook_url',
  '*.webhookUrl',
];

/** Request body ceiling (10-security §7.2). Generous enough for long-context chat bodies, not unbounded. */
const BODY_LIMIT_BYTES = 16 * 1024 * 1024;

/**
 * The build seam (02-architecture §3, 11-testing §1.2). `buildApp()` accepts
 * injectable dependencies so integration tests can drive the full plugin tree
 * via `fastify.inject()` without binding a socket. `db` is the raw Drizzle
 * client (what `createTestDb()` returns). M1+ extends `AppOptions` with
 * `encryptor`, `rateLimiter`, `undiciDispatcher`, and `clock`.
 */
export interface AppOptions {
  config?: Config;
  db?: DatabaseClient;
  logger?: boolean | object;
  /** Test seam: inject a local JWKS + verify options so integration tests skip WorkOS. */
  auth?: { jwks?: JWTVerifyGetKey; verifyOpts?: VerifyOptions };
  /** Test seam (05 §11): injectable undici dispatcher for the data-plane upstream fetch. */
  dispatcher?: Dispatcher;
}

export async function buildApp(opts: AppOptions = {}): Promise<FastifyInstance> {
  // Fold the secret-redaction list into whatever logger config was injected (or a plain enabled logger).
  const logger =
    opts.logger === undefined || opts.logger === false
      ? false
      : typeof opts.logger === 'object'
        ? { redact: LOG_REDACT_PATHS, ...opts.logger }
        : { redact: LOG_REDACT_PATHS };

  const fastify = Fastify({
    logger,
    genReqId: () => randomUUID(), // M1: swap to UUIDv7 (x-spillway-request-id, 12-ops §6.5)
    trustProxy: true,
    // Hardening (10-security §7.2). requestTimeout bounds time-to-receive the REQUEST (not the response),
    // so it is safe for long streaming responses. bodyLimit caps upload size; keepAlive bounds idle sockets.
    bodyLimit: BODY_LIMIT_BYTES,
    requestTimeout: 60_000,
    keepAliveTimeout: 72_000,
  });

  // Security response headers on every response — a ROOT hook so it wraps all plugins (10-sec §7.1).
  addSecurityHeaders(fastify);

  // CORS is registered PER-PLANE inside each plugin (10-security §5.5): the data
  // plane is permissive (`*`, SDK clients from any origin); the control plane is
  // locked to DASHBOARD_ORIGIN. Health + static need no CORS.
  await fastify.register(healthPlugin, { db: opts.db });
  // /metrics (12-ops §3.2): outside the control-plane auth hook — the scraper auths with
  // the static METRICS_TOKEN bearer, not a WorkOS JWT.
  await fastify.register(metricsRoute, { config: opts.config });
  // Signed action links (§18 §6) — HMAC-token-authed, no session. Registered BEFORE the /api control
  // plane so its /api/v1/approval-actions route isn't shadowed by the control plane's /api not-found scope.
  if (opts.db) await fastify.register(actionLinksPlugin, { db: opts.db, config: opts.config });
  await fastify.register(dataPlanePlugin, {
    prefix: '/v1',
    config: opts.config,
    db: opts.db,
    dispatcher: opts.dispatcher,
  });
  await fastify.register(controlPlanePlugin, {
    config: opts.config,
    db: opts.db,
    auth: opts.auth,
    prefix: '/api',
  });
  await fastify.register(staticPlugin);

  return fastify;
}
