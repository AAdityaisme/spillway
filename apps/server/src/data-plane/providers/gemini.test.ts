import { describe, it, expect } from 'vitest';
import { computeCost, type ModelPriceRow } from '@spillway/pricing';
import { geminiAdapter } from './gemini.js';
import type { Candidate, ParsedUsage } from './types.js';

const cand: Candidate = { provider: 'gemini', model: 'gemini-2.5-flash', providerKeyId: 'pk1' };
const tf = (body: Record<string, unknown>, injectUsage = false) => {
  const r = geminiAdapter.transform(body, cand, 'gm-test-key', { injectUsage });
  return {
    out: r.body as Record<string, unknown>,
    dropped: r.dropped ?? [],
    headers: r.headers,
    url: r.url,
  };
};

/** Feed a ParsedUsage straight into the cost engine to prove the gemini token semantics end-to-end. */
const geminiPrice = (over: Partial<ModelPriceRow> = {}): ModelPriceRow => ({
  provider: 'gemini',
  inputUsdPerM: '1.000000', // $1 / 1M input (≤200K tier)
  outputUsdPerM: '4.000000',
  cacheReadUsdPerM: '0.250000', // cache read at ¼ the input rate
  cacheWrite5mUsdPerM: null,
  cacheWrite1hUsdPerM: null,
  inputUsdPerMLong: '2.000000', // $2 / 1M input (>200K tier)
  longContextThreshold: 200_000,
  tiers: null,
  serviceTierMultipliers: null,
  ...over,
});
const toCanonical = (u: ParsedUsage) => ({
  inputTokens: u.input_tokens,
  outputTokens: u.output_tokens,
  cachedReadTokens: u.cached_read_tokens,
  cacheWrite5mTokens: u.cache_write_5m_tokens,
  cacheWrite1hTokens: u.cache_write_1h_tokens,
  reasoningTokens: u.reasoning_tokens,
});

describe('geminiAdapter.transform', () => {
  const base = { model: 'client-sent', messages: [{ role: 'user', content: 'hi' }] };

  it('targets the OpenAI-compat endpoint with Bearer auth + candidate model; non-stream false', () => {
    const { out, headers, url } = tf(base);
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
    expect(out.model).toBe('gemini-2.5-flash'); // client model ignored
    expect(out.stream).toBe(false);
    expect(out.stream_options).toBeUndefined();
    expect(headers.Authorization).toBe('Bearer gm-test-key');
    expect(headers['x-goog-api-key']).toBeUndefined(); // compat uses Bearer, not x-goog-*
  });

  it('strips a models/ prefix from the candidate model id', () => {
    const prefixed: Candidate = { ...cand, model: 'models/gemini-2.5-pro' };
    const r = geminiAdapter.transform(base, prefixed, 'k', { injectUsage: false });
    expect((r.body as Record<string, unknown>).model).toBe('gemini-2.5-pro');
  });

  it('strip-and-records reasoning_effort (thinking_budget uncontrollable via compat, §3.7)', () => {
    const { out, dropped } = tf({ ...base, reasoning_effort: 'high' });
    expect(out.reasoning_effort).toBeUndefined();
    expect(dropped).toContain('reasoning_effort');
  });

  it('injects stream_options.include_usage when capturing on a stream (Phase C)', () => {
    const { out } = tf({ ...base, stream: true }, true);
    expect(out.stream).toBe(true);
    expect(out.stream_options).toEqual({ include_usage: true });
  });

  it('merges include_usage into client-supplied stream_options (no clobber)', () => {
    const { out } = tf({ ...base, stream: true, stream_options: { foo: 1 } }, true);
    expect(out.stream_options).toEqual({ foo: 1, include_usage: true });
  });

  it('drops stream_options on a non-stream request (avoids a gateway-caused upstream 400)', () => {
    const { out, dropped } = tf({ ...base, stream_options: { include_usage: true } });
    expect(out.stream).toBe(false);
    expect(out.stream_options).toBeUndefined();
    expect(dropped).toContain('stream_options');
  });

  it('prepends a top-level system string; records a non-string system', () => {
    expect(
      (tf({ ...base, system: 'Be terse.' }).out.messages as Array<{ role: string }>)[0],
    ).toEqual({ role: 'system', content: 'Be terse.' });
    const { dropped } = tf({ ...base, system: { not: 'a string' } });
    expect(dropped).toContain('system');
  });

  it('renames max_completion_tokens → max_tokens; max_tokens wins if both; keeps temp 0–2', () => {
    expect(tf({ ...base, max_completion_tokens: 100 }).out.max_tokens).toBe(100);
    expect(tf({ ...base, max_tokens: 50, max_completion_tokens: 100 }).out.max_tokens).toBe(50);
    expect(tf({ ...base, temperature: 1.8 }).out.temperature).toBe(1.8); // Gemini window is 0–2
    expect(tf({ ...base, temperature: 3 }).dropped).toContain('temperature');
  });

  it('passes known params through, strips unknown + metadata (recorded)', () => {
    const { out, dropped } = tf({
      ...base,
      tools: [{ type: 'function' }],
      seed: 7,
      metadata: {},
      foo: 1,
    });
    expect(out.tools).toBeDefined();
    expect(out.seed).toBe(7);
    expect(out.metadata).toBeUndefined();
    expect(dropped).toEqual(expect.arrayContaining(['metadata', 'foo']));
  });
});

describe('geminiAdapter.parseBody — cached NOT subtracted (cost.ts owns the subtraction)', () => {
  it('input_tokens is the TOTAL prompt_tokens (cached included), cached reported separately', () => {
    const u = geminiAdapter.parseBody({
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 500,
        prompt_tokens_details: { cached_tokens: 200 },
        completion_tokens_details: { reasoning_tokens: 40 },
      },
    });
    expect(u).toEqual({
      input_tokens: 1000, // NOT 800 — the whole point of the gemini divergence
      output_tokens: 500,
      cached_read_tokens: 200,
      cache_write_5m_tokens: 0,
      cache_write_1h_tokens: 0,
      cache_type: null,
      reasoning_tokens: 40,
      audio_input_tokens: 0, // text-only → no audio lines
      audio_output_tokens: 0,
      usage_estimated: false,
    });
  });

  it('decomposes audio: input stays TOTAL, output excludes audio, audio on its own lines', () => {
    const u = geminiAdapter.parseBody({
      usage: {
        prompt_tokens: 1000, // includes 200 cached + 300 audio
        completion_tokens: 500, // includes 100 audio
        prompt_tokens_details: { cached_tokens: 200, audio_tokens: 300 },
        completion_tokens_details: { audio_tokens: 100 },
      },
    });
    expect(u).toMatchObject({
      input_tokens: 1000, // stays TOTAL (cost.ts isGemini subtracts cached + audio for the text line)
      cached_read_tokens: 200,
      audio_input_tokens: 300,
      output_tokens: 400, // 500 − 100 audio
      audio_output_tokens: 100,
    });
  });

  it('cost.ts bills cached exactly once when fed gemini ParsedUsage (no double-subtract)', () => {
    const u = geminiAdapter.parseBody({
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 500,
        prompt_tokens_details: { cached_tokens: 200 },
      },
    })!;
    const { costMicroUsd } = computeCost(toCanonical(u), geminiPrice());
    // full-rate input = 1000 − 200 = 800 @ $1/M = 800µ; cached 200 @ $0.25/M = 50µ; output 500 @ $4/M = 2000µ
    expect(costMicroUsd).toBe(800n + 50n + 2000n);
  });

  it('handles no cached details (cached = 0, input = prompt)', () => {
    expect(
      geminiAdapter.parseBody({ usage: { prompt_tokens: 30, completion_tokens: 10 } }),
    ).toMatchObject({
      input_tokens: 30,
      cached_read_tokens: 0,
    });
  });

  it('returns null on absent / all-zero usage (estimation trigger)', () => {
    expect(geminiAdapter.parseBody({})).toBeNull();
    expect(
      geminiAdapter.parseBody({ usage: { prompt_tokens: 0, completion_tokens: 0 } }),
    ).toBeNull();
  });

  it('clamps cached_read to prompt + caps >int32 counts (pathological upstream usage)', () => {
    const clamped = geminiAdapter.parseBody({
      usage: {
        prompt_tokens: 100,
        completion_tokens: 10,
        prompt_tokens_details: { cached_tokens: 500 },
      },
    });
    expect(clamped?.cached_read_tokens).toBe(100); // clamped to prompt → cost.ts fullRate = 0, not negative
    expect(clamped?.input_tokens).toBe(100);
    const capped = geminiAdapter.parseBody({
      usage: { prompt_tokens: 10, completion_tokens: 3_000_000_000 },
    });
    expect(capped?.output_tokens).toBe(2_000_000_000);
  });
});

describe('geminiAdapter — 200K long-context tier boundary (adapter emits total; cost.ts tiers)', () => {
  it('at/under 200K uses the base input rate; the boundary is exclusive', () => {
    // input_tokens = 200_000 exactly → cost.ts useLongTier requires `> threshold`, so base rate applies.
    const u = geminiAdapter.parseBody({ usage: { prompt_tokens: 200_000, completion_tokens: 0 } })!;
    expect(u.input_tokens).toBe(200_000);
    const { unitPrices } = computeCost(toCanonical(u), geminiPrice());
    expect(unitPrices?.in).toBe('1.000000'); // ≤200K tier
  });

  it('above 200K TOTAL input trips the long tier — proving input_tokens carries the total', () => {
    const u = geminiAdapter.parseBody({
      usage: {
        prompt_tokens: 250_000,
        completion_tokens: 100,
        prompt_tokens_details: { cached_tokens: 50_000 },
      },
    })!;
    expect(u.input_tokens).toBe(250_000); // total (incl. 50K cached) drives the tier check
    const { unitPrices } = computeCost(toCanonical(u), geminiPrice());
    expect(unitPrices?.in).toBe('2.000000'); // >200K long tier — would NOT trip if we'd emitted 200K net
  });
});

describe('geminiAdapter.createStreamParser (OpenAI-shaped SSE)', () => {
  const feed = (events: string[]) => {
    const p = geminiAdapter.createStreamParser(cand);
    for (const d of events) p.processEvent({ data: d });
    return p;
  };

  it('captures the terminal usage chunk with total input (cached NOT subtracted)', () => {
    const p = feed([
      JSON.stringify({ choices: [{ delta: { content: 'hi' } }] }),
      JSON.stringify({
        choices: [],
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 500,
          prompt_tokens_details: { cached_tokens: 200 },
        },
      }),
      '[DONE]',
    ]);
    const u = p.getUsage({}, 'gemini-2.5-flash');
    expect(u.input_tokens).toBe(1000); // total
    expect(u.cached_read_tokens).toBe(200);
    expect(u.output_tokens).toBe(500);
    expect(u.usage_estimated).toBe(false);
  });

  it('estimates when no usage chunk arrives (compat model omitted it) — non-zero, flagged', () => {
    const p = feed([
      JSON.stringify({ choices: [{ delta: { content: 'hello world' } }] }),
      '[DONE]',
    ]);
    const u = p.getUsage({ messages: [{ role: 'user', content: '12345678' }] }, 'gemini-2.5-flash');
    expect(u.usage_estimated).toBe(true);
    expect(u.input_tokens).toBe(2); // ceil(8/4)
    expect(u.output_tokens).toBe(3); // ceil(11/4)
  });

  it('counts tool-call output when truncated before the usage chunk (no under-bill)', () => {
    const p = feed([
      JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, function: { name: 'search', arguments: '{"q":"x"}' } }],
            },
          },
        ],
      }),
    ]);
    const u = p.getUsage({ messages: [{ role: 'user', content: 'hi' }] }, 'gemini-2.5-flash');
    expect(u.usage_estimated).toBe(true);
    expect(u.output_tokens).toBeGreaterThan(0);
  });

  it('skips a malformed SSE line without throwing', () => {
    const p = feed([
      'not json',
      JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
    ]);
    expect(p.getUsage({}, 'gemini-2.5-flash').output_tokens).toBe(5);
  });
});

describe('geminiAdapter.mapError', () => {
  it('429 RESOURCE_EXHAUSTED → rate_limit, retryable', () => {
    expect(geminiAdapter.mapError(429, { error: { status: 'RESOURCE_EXHAUSTED' } })).toMatchObject({
      spillwayCode: 'provider_rate_limited',
      isRetryable: true,
      errorClass: 'rate_limit',
    });
  });

  it('400 INVALID_ARGUMENT → bare client error, surfaces (never advances the chain)', () => {
    expect(
      geminiAdapter.mapError(400, { error: { status: 'INVALID_ARGUMENT', message: 'bad param' } }),
    ).toMatchObject({
      spillwayCode: 'invalid_request',
      isClientError: true,
      isRetryable: false,
      errorClass: 'client',
    });
  });

  it('400 context-length (Gemini phrasing in message) → context_window, advances', () => {
    expect(
      geminiAdapter.mapError(400, {
        error: {
          status: 'INVALID_ARGUMENT',
          message: 'The input token count exceeds the maximum context length',
        },
      }),
    ).toMatchObject({
      errorClass: 'context_window',
      spillwayCode: 'request_too_large',
      isRetryable: true,
      isClientError: false,
    });
  });

  it('400 safety/content → content_policy, advances', () => {
    expect(
      geminiAdapter.mapError(400, { error: { message: 'blocked for safety reasons' } }),
    ).toMatchObject({
      errorClass: 'content_policy',
      isRetryable: true,
    });
  });

  it('401/403 → auth, non-retryable; 404 → model_not_found client (excluded from health)', () => {
    expect(geminiAdapter.mapError(401, {})).toMatchObject({
      errorClass: 'auth',
      isRetryable: false,
    });
    expect(geminiAdapter.mapError(403, {})).toMatchObject({ spillwayCode: 'provider_auth_error' });
    expect(geminiAdapter.mapError(404, {})).toMatchObject({
      spillwayCode: 'model_not_found',
      errorClass: 'client',
    });
  });

  it('503 SERVICE_UNAVAILABLE + other 5xx → retryable server; unknown 4xx → client', () => {
    expect(geminiAdapter.mapError(503, { error: { status: 'UNAVAILABLE' } })).toMatchObject({
      spillwayCode: 'provider_unavailable',
      isRetryable: true,
      errorClass: 'server',
    });
    expect(geminiAdapter.mapError(500, {})).toMatchObject({
      isRetryable: true,
      errorClass: 'server',
    });
    expect(geminiAdapter.mapError(422, {})).toMatchObject({
      isClientError: true,
      errorClass: 'client',
      isRetryable: false,
    });
  });

  it('tolerates null / HTML bodies — rawBody nulled, never forwarded', () => {
    expect(geminiAdapter.mapError(500, null).rawBody).toBeNull();
    expect(geminiAdapter.mapError(502, '<html>502</html>').rawBody).toBeNull();
  });
});
