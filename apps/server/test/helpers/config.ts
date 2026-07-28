import { randomBytes } from 'node:crypto';
import { parseConfig, type Config } from '../../src/config.js';

/** A valid test Config (auth is injected in tests, so WorkOS creds are nominal). */
export function testConfig(overrides: NodeJS.ProcessEnv = {}): Config {
  return parseConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://spillway_app:spillway_app@localhost:5432/unused',
    DATABASE_URL_JOBS: 'postgres://spillway_jobs:spillway_jobs@localhost:5432/unused',
    SPILLWAY_ENC_KEY_V1: randomBytes(32).toString('base64'),
    SPILLWAY_ACTION_TOKEN_SECRET: randomBytes(32).toString('hex'), // enables signed action links
    WORKOS_CLIENT_ID: 'client_test',
    ...overrides,
  });
}
