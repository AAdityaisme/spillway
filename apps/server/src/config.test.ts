import { describe, expect, it } from 'vitest';
import { parseConfig, workosIssuer } from './config.js';

const base = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://spillway_app:password@localhost:5432/test',
  DATABASE_URL_JOBS: 'postgres://spillway_jobs:password@localhost:5432/test',
  SPILLWAY_ENC_KEY_V1: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  WORKOS_CLIENT_ID: 'client_test',
};

/** Minimal prod-valid env (all required-in-prod vars present). */
const prodBase = {
  ...base,
  NODE_ENV: 'production',
  WORKOS_API_KEY: 'sk-prod',
  WORKOS_CLIENT_ID: 'client_prod',
  SPILLWAY_ACTION_TOKEN_SECRET: 'a'.repeat(64), // 64 hex chars
  DASHBOARD_ORIGIN: 'https://app.example.com',
  METRICS_TOKEN: 'tok',
};

describe('workosIssuer', () => {
  it('uses WorkOS hosted AuthKit as the verified issuer by default', () => {
    expect(workosIssuer(parseConfig(base))).toBe('https://api.workos.com/');
  });

  it('allows a configured custom AuthKit domain', () => {
    expect(
      workosIssuer(parseConfig({ ...base, WORKOS_JWT_ISSUER: 'https://auth.example.com/' })),
    ).toBe('https://auth.example.com/');
  });

  // L47: trailing-slash normalization prevents a 1-char env-typo from causing a 100% auth outage.
  it('normalises a custom domain without a trailing slash by appending one', () => {
    expect(
      workosIssuer(parseConfig({ ...base, WORKOS_JWT_ISSUER: 'https://auth.example.com' })),
    ).toBe('https://auth.example.com/');
  });
});

// M46: production boot invariants must not regress silently.
describe('parseConfig — production boot invariants', () => {
  it('parses a fully-supplied prod env without throwing', () => {
    expect(() => parseConfig(prodBase)).not.toThrow();
  });

  it.each([
    ['WORKOS_API_KEY'],
    ['WORKOS_CLIENT_ID'],
    ['SPILLWAY_ACTION_TOKEN_SECRET'],
    ['DASHBOARD_ORIGIN'],
    ['METRICS_TOKEN'],
  ] as const)('throws when %s is absent in production', (key) => {
    const env = { ...prodBase };
    delete (env as Record<string, string>)[key];
    expect(() => parseConfig(env)).toThrow();
  });

  it('throws when ENABLE_TEST_SEEDER is true in production (must NEVER be set in prod)', () => {
    expect(() => parseConfig({ ...prodBase, ENABLE_TEST_SEEDER: 'true' })).toThrow(
      'ENABLE_TEST_SEEDER',
    );
  });

  it('throws when SPILLWAY_ENC_KEY_V1 has the wrong decoded length', () => {
    // 31 bytes encoded → wrong length
    const shortKey = Buffer.alloc(31).toString('base64');
    expect(() => parseConfig({ ...base, SPILLWAY_ENC_KEY_V1: shortKey })).toThrow();
  });

  // L46: canonical base64 check — silently-malformed key decodes to correct length but differs
  // from the canonical re-encoding, which would cause decrypt failures on another instance.
  it('throws when SPILLWAY_ENC_KEY_V1 has trailing whitespace / non-canonical padding', () => {
    const canonical = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
    // Append a space — Buffer.from silently ignores it, decodes to 32 bytes, but re-encoding ≠ input
    expect(() => parseConfig({ ...base, SPILLWAY_ENC_KEY_V1: canonical + ' ' })).toThrow();
  });

  it('throws when SPILLWAY_ACTION_TOKEN_SECRET contains non-hex characters', () => {
    expect(() =>
      parseConfig({ ...prodBase, SPILLWAY_ACTION_TOKEN_SECRET: 'z'.repeat(64) }),
    ).toThrow();
  });

  it('throws when WORKOS_JWT_AUD is an empty string (empty must not silently disable enforcement)', () => {
    expect(() => parseConfig({ ...prodBase, WORKOS_JWT_AUD: '' })).toThrow();
  });
});
