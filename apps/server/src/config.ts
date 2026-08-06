import { z } from 'zod';

/**
 * The single source of environment configuration (02-architecture §6).
 * Every `process.env` read in the app goes through this schema. Boot fails
 * loudly, listing every missing/invalid var, before anything else runs.
 *
 * Stack (ADR-022/023): Postgres host = Neon (just a connection string — ADR-004
 * keeps us host-agnostic); human auth = WorkOS AuthKit (JWT verified via JWKS,
 * SAML/SCIM-ready). Local dev + tests use Dockerized Postgres; WorkOS vars are
 * optional in dev/test (no auth runs until M1) and required in production.
 *
 * Full variable reference: 12-operations §1.2 (.env.example).
 */

const base64Bytes = (n: number) =>
  z.string().refine(
    (v) => {
      try {
        // L46: validate canonicality, not just decoded length. Buffer.from silently discards
        // invalid chars, so a truncated/padded/newline-contaminated value can decode to n bytes
        // but produce a different key than intended — or a different key than a peer instance
        // that received the same string pre-strip.  Re-encoding and comparing catches all of those.
        const buf = Buffer.from(v, 'base64');
        return buf.length === n && buf.toString('base64') === v;
      } catch {
        return false;
      }
    },
    {
      message: `must be canonical base64 for ${n} bytes, no padding/whitespace variants (generate: openssl rand -base64 ${n})`,
    },
  );

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

    // Database (Neon in prod, Dockerized Postgres locally — host-agnostic, ADR-004)
    DATABASE_URL: z.string().min(1),
    DATABASE_URL_JOBS: z.string().min(1),
    // Superuser connection used ONLY by drizzle-kit migrate (grants + RLS need
    // owner/superuser privileges the app role lacks). Falls back to DATABASE_URL.
    MIGRATION_DATABASE_URL: z.string().optional(),
    DB_POOL_MAX: z.coerce.number().int().positive().default(15),
    // Number of app instances behind the LB. The policy cache is per-instance (ADR-016); >1
    // instance risks stale-bundle skew up to the TTL until the Redis swap (17 §3.6 startup guard).
    SPILLWAY_INSTANCE_COUNT: z.coerce.number().int().positive().default(1),

    // Auth — WorkOS AuthKit (ADR-023). JWTs verified via JWKS (RS256) in M1.
    // Optional in dev/test (no auth runs until M1); required in production.
    WORKOS_API_KEY: z.string().optional(),
    WORKOS_CLIENT_ID: z.string().optional(),
    // Defaults to WorkOS's hosted AuthKit issuer. Set this to the custom AuthKit
    // domain when one is configured; issuer matching is exact JWT validation.
    WORKOS_JWT_ISSUER: z.string().url().optional(),
    // Enforce the JWT `aud` claim when set. WorkOS AuthKit access tokens don't carry a stable
    // audience on every plan, so this stays opt-in: set it (usually to the client id) once the
    // WorkOS dashboard confirms the value, and every token missing/mismatching it 401s.
    WORKOS_JWT_AUD: z.string().min(1).optional(), // min(1): "" must NOT silently disable enforcement (red-team) — omit the var to opt out
    // AuthKit hosted-login flow (M4-auth). The sealed session cookie is encrypted with this
    // password by the WorkOS SDK, so it is a real secret: rotating it logs everyone out.
    // 32 chars is the SDK's floor. Generate: openssl rand -base64 32
    WORKOS_COOKIE_PASSWORD: z.string().min(32).optional(),
    // Must match a redirect URI registered in the WorkOS dashboard EXACTLY, or the callback 400s.
    // Defaults to PUBLIC_URL + /auth/callback so local dev needs no extra config.
    WORKOS_REDIRECT_URI: z.string().url().optional(),

    // Encryption (ADR-014)
    SPILLWAY_ENC_KEY_V1: base64Bytes(32),

    // Approval action links (ADR-019i) — 32-byte hex HMAC key (openssl rand -hex 32)
    SPILLWAY_ACTION_TOKEN_SECRET: z
      .string()
      .regex(/^[0-9a-f]{64}$/, 'must be 64 lowercase hex chars (openssl rand -hex 32)')
      .optional(),

    // Background jobs (18 §3.3 poller lease + 19 §2.2 anomaly-scan). Off in test — the
    // integration suite drives job cycles explicitly; a live cadence would race the assertions.
    JOBS_ENABLED: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),

    // Alert delivery (all optional; silently disabled if unset)
    SLACK_WEBHOOK_URL: z.string().url().optional(),
    // A single shared SLACK_WEBHOOK_URL must NOT receive multiple tenants' alerts (cross-tenant leak).
    // Until per-org channel delivery ships, the shared sink delivers ONLY this operator org's events;
    // fail-closed (unset → the shared sink delivers nothing). See services/alerts/delivery.ts.
    ALERT_OPERATOR_ORG_ID: z.string().uuid().optional(),
    RESEND_API_KEY: z.string().optional(),
    ALERT_FROM_EMAIL: z.string().email().optional(),

    // Domain / CORS
    PUBLIC_URL: z.string().url().default('http://localhost:3000'),
    DASHBOARD_ORIGIN: z.string().url().optional(),

    // Observability
    METRICS_TOKEN: z.string().optional(),

    // Ops
    BACKUP_S3_BUCKET: z.string().optional(),
    ENABLE_TEST_SEEDER: z
      .enum(['true', 'false'])
      .optional()
      .transform((v) => v === 'true'),

    // Fixture recording (local only)
    FIXTURE_OPENAI_API_KEY: z.string().optional(),
    FIXTURE_ANTHROPIC_API_KEY: z.string().optional(),
    FIXTURE_GEMINI_API_KEY: z.string().optional(),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.NODE_ENV === 'production') {
      const requiredInProd: Array<[keyof typeof cfg, string]> = [
        ['WORKOS_API_KEY', 'required in production (WorkOS AuthKit secret key)'],
        ['WORKOS_CLIENT_ID', 'required in production (WorkOS client id; JWKS issuer)'],
        [
          'WORKOS_COOKIE_PASSWORD',
          'required in production (seals the AuthKit session cookie; ≥32 chars)',
        ],
        ['SPILLWAY_ACTION_TOKEN_SECRET', 'required in production (approval action-link HMAC)'],
        ['DASHBOARD_ORIGIN', 'required in production (CORS allowed origin for the dashboard SPA)'],
        ['METRICS_TOKEN', 'required in production (gates GET /metrics)'],
      ];
      for (const [key, message] of requiredInProd) {
        if (!cfg[key]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message });
      }
      // PUBLIC_URL drives the AuthKit redirect URI AND the session cookie's Secure flag, so a
      // default of http://localhost:3000 in production is both a broken login and an insecure
      // cookie. Require it, and require TLS.
      if (!cfg.PUBLIC_URL || cfg.PUBLIC_URL.startsWith('http://')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['PUBLIC_URL'],
          message:
            'required in production and must be https (drives the AuthKit redirect URI and the session cookie Secure flag)',
        });
      }
      if (cfg.ENABLE_TEST_SEEDER) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['ENABLE_TEST_SEEDER'],
          message: 'ENABLE_TEST_SEEDER must NEVER be set in production',
        });
      }
    }
  });

export type Config = z.infer<typeof schema>;

/**
 * Parse + validate `process.env`. On failure, prints every issue and exits 1.
 * Call exactly once, at the top of boot (apps/server/src/index.ts).
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = schema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    console.error(`\nFATAL: invalid environment configuration:\n${issues}\n`);
    process.exit(1);
  }
  return result.data;
}

/** Parse + validate an env object, THROWING on failure (no process.exit). For tests. */
export function parseConfig(env: NodeJS.ProcessEnv): Config {
  return schema.parse(env);
}

/** WorkOS AuthKit JWKS endpoint (RS256 verification of session JWTs, ADR-023). M1 wires verification. */
export function workosJwksUrl(cfg: Config): string {
  return `https://api.workos.com/sso/jwks/${cfg.WORKOS_CLIENT_ID}`;
}

/**
 * Expected `iss` claim on WorkOS AuthKit access tokens. WorkOS's hosted AuthKit
 * issuer is `https://api.workos.com/`; custom AuthKit domains must be supplied
 * explicitly so a production token is never rejected by an implicit guess.
 *
 * L47: WorkOS always emits a trailing slash in the `iss` claim. Normalise the
 * configured value the same way so a one-character env typo ('https://auth.example.com'
 * vs. 'https://auth.example.com/') cannot cause a 100%-auth-outage.  The resolved issuer
 * is logged at startup by workos-plugin.ts so ops can diff it against a real token's iss.
 */
export function workosIssuer(cfg: Config): string {
  const raw = cfg.WORKOS_JWT_ISSUER ?? 'https://api.workos.com/';
  return raw.endsWith('/') ? raw : `${raw}/`;
}
