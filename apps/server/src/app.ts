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
import { authKitRoutes } from './auth/authkit-routes.js';
import type { AuthKit } from './auth/authkit.js';
import { addSecurityHeaders } from './security-headers.js';
import { setErrorsDocsUrl } from '@spillway/shared';

/**
 * Secret-bearing property names. Anything matching one of these is redacted wherever it appears in a
 * log object, not just where we happened to expect it.
 */
const SECRET_LEAVES = [
  'authorization',
  'apiKey',
  'api_key',
  'key',
  'plaintext',
  'key_ciphertext',
  'key_iv',
  'key_tag',
  'access_token',
  'accessToken',
  'refresh_token',
  'refreshToken',
  'id_token',
  'sealedSession',
  'sealed_session',
  'password',
  'secret',
  'token',
  'webhook_url',
  'webhookUrl',
];

/** How many object levels down a secret leaf is still caught. Beyond this, log something flatter. */
const REDACT_DEPTH = 4;

/**
 * Pino redaction (10-security §7.3): secrets must never reach the log stream even if a handler logs a
 * whole request/config object. Covers auth material, provider-key ciphertext components, key plaintext,
 * session material, and webhook URLs (which carry Slack/webhook tokens in the path).
 *
 * WHY THE EXPANSION: pino's `*` matches EXACTLY ONE level. The old list was `*.access_token` only, so a
 * TOP-level `{ access_token }` — precisely what /auth/session returns — and anything nested two deep
 * (`{ res: { body: { data: { access_token } } } }`) both logged in the clear. Fixed by emitting every
 * depth from 0 to REDACT_DEPTH for each leaf name; fast-redact supports multiple wildcards per path.
 * `res.headers["set-cookie"]` is explicit: the sealed WorkOS session rides in that header.
 */
export const LOG_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["x-spillway-org"]',
  'res.headers["set-cookie"]',
  ...SECRET_LEAVES.flatMap((leaf) =>
    Array.from({ length: REDACT_DEPTH + 1 }, (_, depth) => `${'*.'.repeat(depth)}${leaf}`),
  ),
];

/** Request body ceiling (10-security §7.2). Generous enough for long-context chat bodies, not unbounded. */
const BODY_LIMIT_BYTES = 16 * 1024 * 1024;

/**
 * How many reverse proxies sit in front of this process. NOT `true`.
 *
 * `trustProxy: true` trusts the ENTIRE x-forwarded-for chain, so `req.ip` becomes the leftmost entry —
 * which the client writes. Every IP-keyed control (the control-plane rate limiter, the failed-JWT
 * lockout, abuse attribution in the audit log) was therefore defeated by one spoofed header, and an
 * attacker could rotate a fresh "IP" per request forever.
 *
 * A hop COUNT trusts only the N addresses closest to us: `1` means "trust our own socket peer (Fly's
 * proxy) and take the last XFF entry" — the one Fly appends and a client cannot forge. Anything the
 * client prepended is ignored.
 *
 * Raise this by one for each additional trusted proxy you put in front (e.g. Cloudflare → 2). Setting
 * it too HIGH re-opens the spoof; too LOW just attributes traffic to the proxy. Fail in that direction.
 */
const TRUST_PROXY_HOPS = (() => {
  const parsed = Number.parseInt(process.env.TRUST_PROXY_HOPS ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 1;
})();

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
  /** Test seam (M4-auth): injectable AuthKit so the login flow is drivable without WorkOS. */
  authKit?: AuthKit;
}

export async function buildApp(opts: AppOptions = {}): Promise<FastifyInstance> {
  // Every SpillwayError's docs_url is computed lazily off shared module state, not per-request —
  // wire the configured host once per app build. Tests that omit `config` keep the shared default.
  if (opts.config) setErrorsDocsUrl(opts.config.SPILLWAY_DOCS_URL);

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
    trustProxy: TRUST_PROXY_HOPS,
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
  // AuthKit hosted login (M4-auth). Registered BEFORE the /api control plane and outside its
  // auth hook — a logged-out browser has to reach these to get a session in the first place.
  await fastify.register(authKitRoutes, { config: opts.config, authKit: opts.authKit });
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
    dispatcher: opts.dispatcher,
    prefix: '/api',
  });
  await fastify.register(staticPlugin);

  return fastify;
}
