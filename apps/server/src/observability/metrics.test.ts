import { describe, it, expect } from 'vitest';
import {
  registry,
  recordRequestCompletion,
  observeRequestDuration,
  observeTtft,
  recordSpendUsd,
  recordTokens,
  recordBlock,
  recordFallback,
  recordStreamAbort,
  recordProviderError,
  sseStreamOpened,
  sseStreamClosed,
  policyCacheHit,
  policyCacheMiss,
  setPricingStalenessHours,
} from './metrics.js';

/**
 * Unit coverage for the §6.3 request-path catalog producers (12-operations). Each metric family is
 * exercised through its `record*`/`observe*` helper (the producer's pure module seam) and read back
 * out of the shared prom-client registry with exact labels. Every assertion targets a UNIQUE label
 * set so the module-singleton instruments don't cross-contaminate between cases.
 */

interface Sample {
  value: number;
  labels: Record<string, string | number>;
  metricName?: string;
}

async function samples(name: string): Promise<Sample[]> {
  const all = await registry.getMetricsAsJSON();
  const m = all.find((x) => x.name === name) as { values?: Sample[] } | undefined;
  return m?.values ?? [];
}

const matches = (s: Sample, labels: Record<string, string>): boolean =>
  Object.entries(labels).every(([k, v]) => String(s.labels[k]) === v);

/** Total value across series matching `labels` (exact-match → one series → its value). */
async function counter(name: string, labels: Record<string, string> = {}): Promise<number> {
  return (await samples(name))
    .filter((s) => s.metricName === undefined || s.metricName === name)
    .filter((s) => matches(s, labels))
    .reduce((sum, s) => sum + s.value, 0);
}

/** Observation count of a histogram series (the `${name}_count` child). */
async function histogramCount(name: string, labels: Record<string, string>): Promise<number> {
  const s = (await samples(name)).find(
    (x) => x.metricName === `${name}_count` && matches(x, labels),
  );
  return s?.value ?? 0;
}

describe('request-path metrics catalog (§6.3)', () => {
  it('requests_total counts by status/provider/model/endpoint', async () => {
    recordRequestCompletion('ok', 'openai', 'unit-req-ok', 'chat_completions');
    recordRequestCompletion('ok', 'openai', 'unit-req-ok', 'chat_completions');
    recordRequestCompletion('error', 'openai', 'unit-req-err', 'chat_completions');
    expect(
      await counter('spillway_requests_total', {
        status: 'ok',
        provider: 'openai',
        model: 'unit-req-ok',
        endpoint: 'chat_completions',
      }),
    ).toBe(2);
    expect(
      await counter('spillway_requests_total', {
        status: 'error',
        provider: 'openai',
        model: 'unit-req-err',
        endpoint: 'chat_completions',
      }),
    ).toBe(1);
  });

  it('request_duration_ms observes with provider/model/stream labels', async () => {
    observeRequestDuration('openai', 'unit-dur', false, 123);
    expect(
      await histogramCount('spillway_request_duration_ms', {
        provider: 'openai',
        model: 'unit-dur',
        stream: 'false',
      }),
    ).toBe(1);
  });

  it('ttft_ms observes with provider/model labels', async () => {
    observeTtft('openai', 'unit-ttft', 42);
    expect(
      await histogramCount('spillway_ttft_ms', { provider: 'openai', model: 'unit-ttft' }),
    ).toBe(1);
  });

  it('spend_usd_total sums USD from bigint micro-USD; skips null/zero cost', async () => {
    recordSpendUsd('unit-org', 'openai', 'unit-spend', 2_500_000n); // $2.50
    recordSpendUsd('unit-org', 'openai', 'unit-spend', null); // unpriced → no add
    recordSpendUsd('unit-org', 'openai', 'unit-spend', 0n); // zero → no add
    expect(
      await counter('spillway_spend_usd_total', {
        org_id: 'unit-org',
        provider: 'openai',
        model: 'unit-spend',
      }),
    ).toBeCloseTo(2.5, 6);
  });

  it('tokens_total splits by type and folds both cache-write windows into cache_write', async () => {
    recordTokens('openai', 'unit-tok', {
      inputTokens: 10,
      outputTokens: 5,
      cachedReadTokens: 3,
      cacheWrite5mTokens: 2,
      cacheWrite1hTokens: 1,
      reasoningTokens: 4,
    });
    const l = { provider: 'openai', model: 'unit-tok' };
    expect(await counter('spillway_tokens_total', { type: 'input', ...l })).toBe(10);
    expect(await counter('spillway_tokens_total', { type: 'output', ...l })).toBe(5);
    expect(await counter('spillway_tokens_total', { type: 'cached_read', ...l })).toBe(3);
    expect(await counter('spillway_tokens_total', { type: 'cache_write', ...l })).toBe(3);
    expect(await counter('spillway_tokens_total', { type: 'reasoning', ...l })).toBe(4);
  });

  it('blocks_total counts by reason/scope_type', async () => {
    recordBlock('budget_exceeded', 'team');
    expect(
      await counter('spillway_blocks_total', { reason: 'budget_exceeded', scope_type: 'team' }),
    ).toBe(1);
  });

  it('fallbacks_total counts by from_provider/from_model/reason', async () => {
    recordFallback('openai', 'unit-from', 'timeout');
    expect(
      await counter('spillway_fallbacks_total', {
        from_provider: 'openai',
        from_model: 'unit-from',
        reason: 'timeout',
      }),
    ).toBe(1);
  });

  it('stream_aborts_total counts by provider/model', async () => {
    recordStreamAbort('openai', 'unit-abort');
    expect(
      await counter('spillway_stream_aborts_total', { provider: 'openai', model: 'unit-abort' }),
    ).toBe(1);
  });

  it('provider_errors_total counts by provider/http_status/spillway_code', async () => {
    recordProviderError('openai', 529, 'upstream_overloaded');
    expect(
      await counter('spillway_provider_errors_total', {
        provider: 'openai',
        http_status: '529',
        spillway_code: 'upstream_overloaded',
      }),
    ).toBe(1);
  });

  it('policy_cache hits/misses each increment their counter', async () => {
    const hits0 = await counter('spillway_policy_cache_hits_total');
    const misses0 = await counter('spillway_policy_cache_misses_total');
    policyCacheHit();
    policyCacheMiss();
    policyCacheMiss();
    expect(await counter('spillway_policy_cache_hits_total')).toBe(hits0 + 1);
    expect(await counter('spillway_policy_cache_misses_total')).toBe(misses0 + 2);
  });

  it('active_sse_streams is a balanced gauge (open bumps, close drops)', async () => {
    const before = await counter('spillway_active_sse_streams');
    sseStreamOpened();
    sseStreamOpened();
    expect(await counter('spillway_active_sse_streams')).toBe(before + 2);
    sseStreamClosed();
    sseStreamClosed();
    expect(await counter('spillway_active_sse_streams')).toBe(before);
  });

  it('pricing_staleness_hours is a settable gauge', async () => {
    setPricingStalenessHours(12.5);
    expect(await counter('spillway_pricing_staleness_hours')).toBe(12.5);
    setPricingStalenessHours(80);
    expect(await counter('spillway_pricing_staleness_hours')).toBe(80);
  });
});

describe('L49 cardinality guard', () => {
  it('collapses null/undefined/empty provider+model to "unknown"', async () => {
    recordRequestCompletion('blocked', null, undefined, 'chat_completions');
    recordRequestCompletion('rate_limited', '', '', 'chat_completions');
    recordProviderError(null, 500, 'internal_error');
    expect(
      await counter('spillway_requests_total', {
        status: 'blocked',
        provider: 'unknown',
        model: 'unknown',
        endpoint: 'chat_completions',
      }),
    ).toBe(1);
    expect(
      await counter('spillway_requests_total', {
        status: 'rate_limited',
        provider: 'unknown',
        model: 'unknown',
        endpoint: 'chat_completions',
      }),
    ).toBe(1);
    expect(
      await counter('spillway_provider_errors_total', {
        provider: 'unknown',
        http_status: '500',
        spillway_code: 'internal_error',
      }),
    ).toBe(1);
  });
});
