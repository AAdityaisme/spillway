import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { createLocalJWKSet } from 'jose';
import { mintTestJwt, getTestJwks } from '@spillway/shared/test-utils/mint-jwt';
import type { JWTVerifyGetKey } from 'jose';
import { parseConfig } from '../config.js';
import { makeAuthHook } from './workos-plugin.js';
import type { DatabaseClient } from '../db/client.js';

/**
 * Unit tests for makeAuthHook (workos-plugin.ts).
 *
 * M25: mirrorUser failure must NOT propagate — auth availability must not depend
 *      on DB write availability. A failing upsert logs an error but the request
 *      proceeds (fire-and-forget semantics).
 * L29: A startup console.warn is emitted when WORKOS_JWT_AUD is unset in production
 *      so operators know audience enforcement is disabled.
 */

const ISSUER = 'https://api.workos.com/';

// Minimal config factory — avoids touching process.env in tests.
function cfg(overrides: NodeJS.ProcessEnv = {}) {
  return parseConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://x:x@localhost/x',
    DATABASE_URL_JOBS: 'postgres://x:x@localhost/x',
    SPILLWAY_ENC_KEY_V1: Buffer.alloc(32).toString('base64'),
    ...overrides,
  });
}

function prodCfg(overrides: NodeJS.ProcessEnv = {}) {
  return parseConfig({
    NODE_ENV: 'production',
    DATABASE_URL: 'postgres://x:x@localhost/x',
    DATABASE_URL_JOBS: 'postgres://x:x@localhost/x',
    SPILLWAY_ENC_KEY_V1: Buffer.alloc(32).toString('base64'),
    SPILLWAY_ACTION_TOKEN_SECRET: 'a'.repeat(64),
    WORKOS_API_KEY: 'sk_live_fake',
    WORKOS_CLIENT_ID: 'client_prod',
    DASHBOARD_ORIGIN: 'https://app.example.com',
    METRICS_TOKEN: 'secret',
    ...overrides,
  });
}

// Build a mock FastifyRequest with the given authorization header.
function mockRequest(authorization?: string) {
  return {
    headers: { authorization },
    log: { error: vi.fn(), warn: vi.fn() },
  } as unknown as Parameters<ReturnType<typeof makeAuthHook>>[0];
}

let jwks: JWTVerifyGetKey;
const VERIFY_OPTS = { issuer: ISSUER };

beforeAll(async () => {
  jwks = createLocalJWKSet(await getTestJwks());
});

afterEach(() => {
  vi.restoreAllMocks();
});

// Stub DatabaseClient with a mirrorUser-compatible insert chain.
function makeDb(fail: boolean): DatabaseClient {
  const chain = {
    values: vi.fn().mockReturnThis(),
    onConflictDoUpdate: fail
      ? vi.fn().mockRejectedValue(new Error('DB write error'))
      : vi.fn().mockResolvedValue(undefined),
  };
  return { insert: vi.fn().mockReturnValue(chain) } as unknown as DatabaseClient;
}

// ── M25: mirrorUser failure must not propagate ─────────────────────────────────

describe('M25 — mirrorUser fire-and-forget (auth must not fail on DB write error)', () => {
  it('authenticates successfully even when mirrorUser throws', async () => {
    const db = makeDb(true /* fail */);
    const token = await mintTestJwt({ issuer: ISSUER, sub: 'user_m25' });
    const hook = makeAuthHook({ config: cfg(), db, jwks, verifyOpts: VERIFY_OPTS });
    const req = mockRequest(`Bearer ${token}`);

    // Must resolve (not throw) despite the mirror write failing.
    await expect(hook(req)).resolves.toBeUndefined();
    // The authenticated user is attached regardless.
    expect((req as { user?: { sub: string } }).user?.sub).toBe('user_m25');
    // Allow the microtask queue to drain so the fire-and-forget promise settles.
    await new Promise((r) => setTimeout(r, 0));
    // Error is logged (observable), not silently dropped.
    expect(req.log.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining('mirrorUser failed'),
    );
  });

  it('proceeds normally when mirrorUser succeeds', async () => {
    const db = makeDb(false /* ok */);
    const token = await mintTestJwt({ issuer: ISSUER, sub: 'user_m25_ok' });
    const hook = makeAuthHook({ config: cfg(), db, jwks, verifyOpts: VERIFY_OPTS });
    const req = mockRequest(`Bearer ${token}`);

    await expect(hook(req)).resolves.toBeUndefined();
    expect((req as { user?: { sub: string } }).user?.sub).toBe('user_m25_ok');
    await new Promise((r) => setTimeout(r, 0));
    expect(req.log.error).not.toHaveBeenCalled();
  });

  it('throws 401 on missing bearer — mirrorUser never called', async () => {
    const db = makeDb(false);
    const hook = makeAuthHook({ config: cfg(), db, jwks, verifyOpts: VERIFY_OPTS });
    const req = mockRequest(undefined);

    await expect(hook(req)).rejects.toMatchObject({ code: 'unauthenticated', httpStatus: 401 });
    // insert should never have been called
    expect(db.insert).not.toHaveBeenCalled();
  });
});

// ── L29: WORKOS_JWT_AUD startup warning ────────────────────────────────────────

describe('L29 — WORKOS_JWT_AUD startup warning', () => {
  it('emits a console.warn in production when WORKOS_JWT_AUD is unset', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const db = makeDb(false);
    makeAuthHook({
      config: prodCfg({ WORKOS_CLIENT_ID: 'client_prod' /* no WORKOS_JWT_AUD */ }),
      db,
      jwks,
      verifyOpts: VERIFY_OPTS,
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/WORKOS_JWT_AUD/);
    expect(warn.mock.calls[0]![0]).toMatch(/audience/);
  });

  it('does NOT warn in test/dev (aud enforcement is intentionally opt-in)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const db = makeDb(false);
    makeAuthHook({ config: cfg(/* NODE_ENV=test */), db, jwks, verifyOpts: VERIFY_OPTS });
    expect(warn).not.toHaveBeenCalled();
  });

  it('does NOT warn when WORKOS_JWT_AUD is set in production', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const db = makeDb(false);
    makeAuthHook({
      config: prodCfg({ WORKOS_JWT_AUD: 'client_prod' }),
      db,
      jwks,
      verifyOpts: VERIFY_OPTS,
    });
    expect(warn).not.toHaveBeenCalled();
  });
});
