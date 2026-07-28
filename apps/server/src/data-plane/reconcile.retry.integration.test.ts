import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { makeTestApp, type TestHarness } from '../../test/helpers/app.js';
import { runReconcile } from './reconcile.js';
import { BurstTracker } from '../services/alerts/burst.js';
import type { DatabaseClient } from '../db/client.js';
import type { PipelineContext } from './pipeline/context.js';
import type { ParsedUsage } from './providers/types.js';
import type { ModelPriceRow } from '@spillway/pricing';

/**
 * Nothing-lost hardening (audit 2026-07-07): the settle tx gets bounded retries on transient
 * failure, and a terminal failure emits the `spend_write_lost` recovery record. Fault injection
 * via a proxied db whose `transaction` throws N times before delegating to the real client.
 */

const usage: ParsedUsage = {
  input_tokens: 800,
  output_tokens: 500,
  cached_read_tokens: 200,
  cache_write_5m_tokens: 0,
  cache_write_1h_tokens: 0,
  cache_type: null,
  reasoning_tokens: 0,
  usage_estimated: false,
};
const price: ModelPriceRow = {
  provider: 'openai',
  inputUsdPerM: '2.500000',
  outputUsdPerM: '10.000000',
  cacheReadUsdPerM: '0.250000',
  cacheWrite5mUsdPerM: null,
  cacheWrite1hUsdPerM: null,
  inputUsdPerMLong: null,
  longContextThreshold: null,
};

let h: TestHarness;
const orgId = randomUUID();
const vkId = randomUUID();

function flakyDb(db: DatabaseClient, faults: { remaining: number }): DatabaseClient {
  return new Proxy(db, {
    get(target, prop, recv) {
      if (prop === 'transaction' && faults.remaining > 0) {
        return () => {
          faults.remaining -= 1;
          throw new Error('injected transient db failure');
        };
      }
      return Reflect.get(target, prop, recv) as unknown;
    },
  }) as DatabaseClient;
}

interface LogSpy {
  warns: unknown[][];
  errors: unknown[][];
}

function makeCtx(db: DatabaseClient, spy: LogSpy): PipelineContext {
  return {
    deps: { db, burstTracker: new BurstTracker() },
    policy: {
      orgId,
      virtualKeyId: vkId,
      teamId: null,
      configSnapshotHash: 'testhash',
      budgets: [],
    },
    usage,
    requestId: randomUUID(),
    startedAt: Date.now() - 10,
    upstreamStatus: 200,
    errorCode: null,
    activeCandidate: { provider: 'openai', model: 'gpt-4.1', providerKeyId: 'pk' },
    candidate: { provider: 'openai', model: 'gpt-4.1', providerKeyId: 'pk' },
    priceByCandidate: new Map([['openai:gpt-4.1', price]]),
    requestedModel: 'gpt-4.1',
    stream: false,
    knobs: { sessionId: null, requireCapabilities: null, traceEnabled: false, provider: null },
    attemptNumber: 0,
    isFinalAttempt: true,
    servedUnderBudgetFallback: false,
    fallbackFrom: [],
    routeResult: { routingRuleId: null, requestedModel: 'gpt-4.1' },
    requestFeatures: { message_count: 1 },
    timings: {},
    validatedBody: {},
    req: {
      headers: {},
      log: {
        warn: (...a: unknown[]) => spy.warns.push(a),
        error: (...a: unknown[]) => spy.errors.push(a),
      },
    },
  } as unknown as PipelineContext;
}

beforeAll(async () => {
  h = await makeTestApp();
  await h.adminSql`INSERT INTO orgs (id, name, slug) VALUES (${orgId}, 'A', ${'a-' + orgId.slice(0, 8)})`;
  await h.adminSql`INSERT INTO virtual_keys (id, org_id, name, key_hash, key_prefix, status)
            VALUES (${vkId}, ${orgId}, 'k', ${Buffer.from(vkId)}, 'mk-a', 'active')`;
  await h.adminSql`INSERT INTO model_prices (provider, model, input_usd_per_m, output_usd_per_m, cache_read_usd_per_m, source, synced_at)
            VALUES ('openai', 'gpt-4.1', 2.5, 10, 0.25, 'litellm', now())`;
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.adminSql`TRUNCATE requests, request_bodies, request_attempts, spend_counters`;
});

describe('reconcile settle retry (nothing-lost)', () => {
  it('a transient tx failure is retried and the spend row still lands', async () => {
    const spy: LogSpy = { warns: [], errors: [] };
    const ctx = makeCtx(flakyDb(h.db, { remaining: 2 }), spy);
    await runReconcile(ctx);

    const attempts = await h.adminSql`SELECT outcome FROM request_attempts`;
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.outcome).toBe('ok');
    const counters = await h.adminSql<{ spent_usd: string }[]>`
      SELECT spent_usd FROM spend_counters WHERE scope_type='org'`;
    expect(counters.length).toBeGreaterThan(0);
    expect(spy.warns).toHaveLength(2); // one warn per retry
    expect(spy.errors).toHaveLength(0); // never declared lost
  }, 15_000);

  it('a terminal failure emits the spend_write_lost recovery record and never throws', async () => {
    const spy: LogSpy = { warns: [], errors: [] };
    const ctx = makeCtx(flakyDb(h.db, { remaining: 99 }), spy);
    await runReconcile(ctx); // must not throw post-response

    const attempts = await h.adminSql`SELECT 1 FROM request_attempts`;
    expect(attempts).toHaveLength(0);
    expect(spy.errors).toHaveLength(1);
    const [payload, msg] = spy.errors[0] as [Record<string, unknown>, string];
    expect(msg).toContain('spend_write_lost');
    const lost = payload.lost as Record<string, unknown>;
    expect(lost.orgId).toBe(orgId);
    expect(lost.virtualKeyId).toBe(vkId);
    expect(lost.usage).toBeTruthy(); // enough to hand-replay the settle
  }, 15_000);
});
