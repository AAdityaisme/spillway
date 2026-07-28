import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import type { Dispatcher } from 'undici';
import { createLocalJWKSet } from 'jose';
import { mintTestJwt, getTestJwks } from '@spillway/shared/test-utils/mint-jwt';
import { buildApp } from '../../src/app.js';
import { workosIssuer, type Config } from '../../src/config.js';
import type { DatabaseClient } from '../../src/db/client.js';
import { makeEncryptor, type Encryptor } from '../../src/services/encryptor.js';
import { createTestDb } from './db.js';
import { testConfig } from './config.js';

export interface TestHarness {
  app: FastifyInstance;
  db: DatabaseClient; // app-role (RLS enforced)
  jobsDb: DatabaseClient; // spillway_jobs role (cross-org, for poller/timers)
  adminSql: Sql; // superuser (bypasses RLS — for assertions/seeding)
  config: Config;
  encryptor: Encryptor; // SAME config as the app — seal provider keys with this when seeding
  token: (sub: string, email?: string) => Promise<string>;
  containerId: string | undefined; // testcontainer docker id (undefined in CI); for direct container control
  close: () => Promise<void>;
}

export interface MakeTestAppOptions {
  /** Inject an undici dispatcher (e.g. a MockAgent) for the data-plane upstream fetch. */
  dispatcher?: Dispatcher;
}

/** Builds a full app over an isolated test DB, with a local JWKS so auth needs no WorkOS. */
export async function makeTestApp(opts: MakeTestAppOptions = {}): Promise<TestHarness> {
  const { db, jobsDb, adminSql, containerId, cleanup } = await createTestDb();
  const config = testConfig();
  const issuer = workosIssuer(config);
  const jwks = createLocalJWKSet(await getTestJwks());
  const app = await buildApp({
    config,
    db,
    auth: { jwks, verifyOpts: { issuer } },
    dispatcher: opts.dispatcher,
    logger: process.env.TEST_LOG === '1',
  });

  return {
    app,
    db,
    jobsDb,
    adminSql,
    config,
    encryptor: makeEncryptor(config),
    token: (sub, email) => mintTestJwt({ issuer, sub, email: email ?? `${sub}@test.dev` }),
    containerId,
    close: async () => {
      await app.close();
      await cleanup();
    },
  };
}
