import { describe, it, expect } from 'vitest';
import { openaiAdapter } from './openai.js';
import type { Candidate } from './types.js';

const cand: Candidate = { provider: 'openai', model: 'gpt-4.1', providerKeyId: 'pk1' };
const tf = (body: Record<string, unknown>) => {
  const r = openaiAdapter.transform(body, cand, 'sk-test-key', { injectUsage: false });
  return { out: r.body as Record<string, unknown>, dropped: r.dropped ?? [], headers: r.headers };
};

describe('openaiAdapter.transform', () => {
  const base = { model: 'client-sent', messages: [{ role: 'user', content: 'hi' }] };

  it('overrides client model with the candidate model + sets Bearer auth; non-stream stays false', () => {
    const { out, headers } = tf(base); // no stream field → non-streaming
    expect(out.model).toBe('gpt-4.1');
    expect(out.stream).toBe(false);
    expect(out.stream_options).toBeUndefined();
    expect(headers.Authorization).toBe('Bearer sk-test-key');
  });

  it('honors streaming intent + injects stream_options.include_usage when capturing (Phase C)', () => {
    const r = openaiAdapter.transform({ ...base, stream: true }, cand, 'sk-test-key', {
      injectUsage: true,
    });
    const out = r.body as Record<string, unknown>;
    expect(out.stream).toBe(true);
    expect(out.stream_options).toEqual({ include_usage: true });
  });

  it('merges include_usage into client-supplied stream_options (no clobber)', () => {
    const r = openaiAdapter.transform(
      { ...base, stream: true, stream_options: { foo: 1 } },
      cand,
      'sk',
      {
        injectUsage: true,
      },
    );
    expect((r.body as Record<string, unknown>).stream_options).toEqual({
      foo: 1,
      include_usage: true,
    });
  });

  it('drops stream_options on a non-stream request (avoids a gateway-caused upstream 400)', () => {
    const { out, dropped } = tf({ ...base, stream_options: { include_usage: true } }); // no stream
    expect(out.stream).toBe(false);
    expect(out.stream_options).toBeUndefined();
    expect(dropped).toContain('stream_options');
  });

  it('prepends a top-level system string as a system message', () => {
    const { out } = tf({ ...base, system: 'You are terse.' });
    expect((out.messages as Array<{ role: string; content: string }>)[0]).toEqual({
      role: 'system',
      content: 'You are terse.',
    });
  });

  it('renames max_completion_tokens → max_tokens; max_tokens wins if both', () => {
    expect(tf({ ...base, max_completion_tokens: 100 }).out.max_tokens).toBe(100);
    expect(tf({ ...base, max_tokens: 50, max_completion_tokens: 100 }).out.max_tokens).toBe(50);
  });

  it('strip-and-records out-of-range temperature/top_p; keeps in-range', () => {
    const inRange = tf({ ...base, temperature: 0.7, top_p: 0.9 });
    expect(inRange.out.temperature).toBe(0.7);
    expect(inRange.out.top_p).toBe(0.9);
    const bad = tf({ ...base, temperature: 3, top_p: 2 });
    expect(bad.out.temperature).toBeUndefined();
    expect(bad.dropped).toEqual(expect.arrayContaining(['temperature', 'top_p']));
  });

  it('passes known params through, strips unknown + metadata (recorded)', () => {
    const { out, dropped } = tf({
      ...base,
      tools: [{ type: 'function' }],
      seed: 7,
      metadata: { x: 1 },
      foo: 'bar',
    });
    expect(out.tools).toBeDefined();
    expect(out.seed).toBe(7);
    expect(out.metadata).toBeUndefined();
    expect(dropped).toEqual(expect.arrayContaining(['metadata', 'foo']));
  });

  it('drops non-finite numeric params (NaN/Infinity) instead of forwarding null', () => {
    const { out, dropped } = tf({ ...base, presence_penalty: NaN, temperature: Infinity });
    expect(out.presence_penalty).toBeUndefined();
    expect(out.temperature).toBeUndefined();
    expect(dropped).toEqual(expect.arrayContaining(['presence_penalty', 'temperature']));
  });

  it('records a non-string system in dropped (strip-and-record contract)', () => {
    const { out, dropped } = tf({ ...base, system: { not: 'a string' } });
    expect((out.messages as Array<{ role: string }>)[0]?.role).toBe('user'); // not prepended
    expect(dropped).toContain('system');
  });
});

describe('openaiAdapter.parseBody', () => {
  it('extracts usage; input EXCLUDES cached (subtracted from prompt_tokens)', () => {
    const u = openaiAdapter.parseBody({
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 500,
        prompt_tokens_details: { cached_tokens: 200 },
        completion_tokens_details: { reasoning_tokens: 120 },
      },
    });
    expect(u).toEqual({
      input_tokens: 800, // 1000 − 200 cached
      output_tokens: 500,
      cached_read_tokens: 200,
      cache_write_5m_tokens: 0,
      cache_write_1h_tokens: 0,
      cache_type: null,
      reasoning_tokens: 120,
      audio_input_tokens: 0, // text-only → no audio lines
      audio_output_tokens: 0,
      usage_estimated: false,
    });
  });

  it('decomposes audio tokens onto their own lines (excluded from the full-rate text lines)', () => {
    const u = openaiAdapter.parseBody({
      usage: {
        prompt_tokens: 1000, // includes 200 cached + 300 audio
        completion_tokens: 500, // includes 100 audio
        prompt_tokens_details: { cached_tokens: 200, audio_tokens: 300 },
        completion_tokens_details: { audio_tokens: 100 },
      },
    });
    expect(u).toMatchObject({
      input_tokens: 500, // 1000 − 200 cached − 300 audio
      cached_read_tokens: 200,
      audio_input_tokens: 300,
      output_tokens: 400, // 500 − 100 audio
      audio_output_tokens: 100,
    });
  });

  it('handles no cached details (cached = 0, input = prompt)', () => {
    expect(
      openaiAdapter.parseBody({ usage: { prompt_tokens: 30, completion_tokens: 10 } }),
    ).toMatchObject({
      input_tokens: 30,
      cached_read_tokens: 0,
    });
  });

  it('returns null on absent or all-zero usage (estimation trigger)', () => {
    expect(openaiAdapter.parseBody({})).toBeNull();
    expect(
      openaiAdapter.parseBody({ usage: { prompt_tokens: 0, completion_tokens: 0 } }),
    ).toBeNull();
  });

  it('clamps cached_read to prompt (pathological upstream usage)', () => {
    const u = openaiAdapter.parseBody({
      usage: {
        prompt_tokens: 100,
        completion_tokens: 10,
        prompt_tokens_details: { cached_tokens: 500 },
      },
    });
    expect(u?.cached_read_tokens).toBe(100);
    expect(u?.input_tokens).toBe(0); // max(0, 100 − 100)
  });

  it('caps >int32 token counts so the requests insert cannot overflow (red-team)', () => {
    const u = openaiAdapter.parseBody({
      usage: { prompt_tokens: 10, completion_tokens: 3_000_000_000 },
    });
    expect(u?.output_tokens).toBe(2_000_000_000);
  });

  it('floors negative token counts at 0; sign-cancel does not fake an all-zero null (red-team)', () => {
    const neg = openaiAdapter.parseBody({ usage: { prompt_tokens: 10, completion_tokens: -5 } });
    expect(neg?.output_tokens).toBe(0);
    expect(neg?.input_tokens).toBe(10);
    const cancel = openaiAdapter.parseBody({ usage: { prompt_tokens: 5, completion_tokens: -5 } });
    expect(cancel).not.toBeNull(); // floored (5 + 0) ≠ 0, so real usage is recorded
    expect(cancel?.input_tokens).toBe(5);
    expect(cancel?.output_tokens).toBe(0);
  });
});

describe('openaiAdapter.createStreamParser', () => {
  const feed = (events: string[]) => {
    const p = openaiAdapter.createStreamParser(cand);
    for (const d of events) p.processEvent({ data: d });
    return p;
  };

  it('captures the usage chunk (empty choices + usage) with cached subtraction', () => {
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
    const u = p.getUsage({}, 'gpt-4.1');
    expect(u.input_tokens).toBe(800); // 1000 − 200 cached
    expect(u.output_tokens).toBe(500);
    expect(u.cached_read_tokens).toBe(200);
    expect(u.usage_estimated).toBe(false);
  });

  it('estimates when no usage chunk arrives (usage_estimated=true, non-zero)', () => {
    const p = feed([
      JSON.stringify({ choices: [{ delta: { content: 'hello world' } }] }),
      '[DONE]',
    ]);
    const u = p.getUsage({ messages: [{ role: 'user', content: '12345678' }] }, 'gpt-4.1');
    expect(u.usage_estimated).toBe(true);
    expect(u.input_tokens).toBe(2); // ceil(8/4)
    expect(u.output_tokens).toBe(3); // ceil(11/4) — "hello world"
  });

  it('skips a malformed SSE line without throwing', () => {
    const p = feed([
      'not json at all',
      JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
    ]);
    expect(p.getUsage({}, 'gpt-4.1').output_tokens).toBe(5);
  });

  it('estimates tool-call output when truncated before the usage chunk (red-team ADR-034)', () => {
    // tool-only stream, no content deltas, cut before the usage frame → must NOT estimate 0
    const p = feed([
      JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, function: { name: 'search', arguments: '{"q":"hello world"}' } },
              ],
            },
          },
        ],
      }),
    ]);
    const u = p.getUsage({ messages: [{ role: 'user', content: 'hi' }] }, 'gpt-4.1');
    expect(u.usage_estimated).toBe(true);
    expect(u.output_tokens).toBeGreaterThan(0); // tool_calls args/name counted, not just delta.content
  });
});

describe('openaiAdapter.mapError', () => {
  it('classifies retryable / client / errorClass by status + body code (15 §7.1)', () => {
    expect(openaiAdapter.mapError(429, {})).toMatchObject({
      isRetryable: true,
      isClientError: false,
      spillwayCode: 'provider_rate_limited',
      errorClass: 'rate_limit',
    });
    // 5xx: now retryable + server class (the chain advances; health counts it).
    expect(openaiAdapter.mapError(503, {})).toMatchObject({
      isRetryable: true,
      errorClass: 'server',
    });
    expect(openaiAdapter.mapError(500, {})).toMatchObject({
      spillwayCode: 'provider_unavailable',
      isRetryable: true,
      errorClass: 'server',
    });
    // bare 400 → client (surfaces immediately, never advances the chain).
    expect(openaiAdapter.mapError(400, {})).toMatchObject({
      isClientError: true,
      isRetryable: false,
      spillwayCode: 'invalid_request',
      errorClass: 'client',
    });
    // typed-chain 400s: context length + content policy advance their variant.
    expect(
      openaiAdapter.mapError(400, { error: { code: 'context_length_exceeded' } }),
    ).toMatchObject({ errorClass: 'context_window', isClientError: false, isRetryable: true });
    expect(
      openaiAdapter.mapError(400, { error: { code: 'content_policy_violation' } }),
    ).toMatchObject({ errorClass: 'content_policy', isRetryable: true });
    expect(openaiAdapter.mapError(413, {})).toMatchObject({ errorClass: 'context_window' });
    expect(openaiAdapter.mapError(401, {})).toMatchObject({
      spillwayCode: 'provider_auth_error',
      isRetryable: false,
      errorClass: 'auth',
    });
    // 404 is a 4xx → excluded from circuit-breaker health (§6.6, red-team B5-6): errorClass 'client'.
    expect(openaiAdapter.mapError(404, {})).toMatchObject({
      spillwayCode: 'model_not_found',
      errorClass: 'client',
    });
    // 422 (and any unrecognized 4xx): surfaced immediately as a client error — NOT mislabeled a 5xx
    // provider failure that advances the chain into a bogus 502 all_providers_failed (expanded-audit).
    expect(openaiAdapter.mapError(422, {})).toMatchObject({
      spillwayCode: 'invalid_request',
      isClientError: true,
      isRetryable: false,
      errorClass: 'client',
    });
    expect(openaiAdapter.mapError(418, {})).toMatchObject({
      isClientError: true,
      errorClass: 'client',
    });
  });

  it('tolerates null / non-object (HTML) bodies — rawBody nulled, never forwarded', () => {
    expect(openaiAdapter.mapError(500, null).rawBody).toBeNull();
    expect(openaiAdapter.mapError(502, '<html>502 Bad Gateway</html>').rawBody).toBeNull();
  });
});

describe('openaiAdapter.transformEmbeddings (task #9)', () => {
  const ecand: Candidate = {
    provider: 'openai',
    model: 'text-embedding-3-small',
    providerKeyId: 'pk1',
  };
  const tfe = (body: Record<string, unknown>) => {
    const r = openaiAdapter.transformEmbeddings!(body, ecand, 'sk-test-key');
    return { r, out: r.body as Record<string, unknown>, dropped: r.dropped ?? [] };
  };

  it('targets /v1/embeddings, overrides the model, forwards the embeddings surface', () => {
    const { r, out } = tfe({
      model: 'client-sent',
      input: ['a', 'b'],
      encoding_format: 'float',
      dimensions: 256,
      user: 'u1',
    });
    expect(r.url).toBe('https://api.openai.com/v1/embeddings');
    expect(r.headers.Authorization).toBe('Bearer sk-test-key');
    expect(out.model).toBe('text-embedding-3-small');
    expect(out.input).toEqual(['a', 'b']);
    expect(out.encoding_format).toBe('float');
    expect(out.dimensions).toBe(256);
    expect(out.user).toBe('u1');
  });

  it('strips-and-records chat params — OpenAI 400s on unknown embeddings params', () => {
    const { out, dropped } = tfe({
      model: 'm',
      input: 'hi',
      messages: [{ role: 'user', content: 'x' }],
      temperature: 0.5,
      stream: true,
    });
    expect(out.messages).toBeUndefined();
    expect(out.stream).toBeUndefined();
    expect(dropped).toEqual(expect.arrayContaining(['messages', 'temperature', 'stream']));
  });

  it('never forwards the internal original_max_tokens marker', () => {
    const { out, dropped } = tfe({ model: 'm', input: 'hi', original_max_tokens: 4096 });
    expect(out.original_max_tokens).toBeUndefined();
    expect(dropped).not.toContain('original_max_tokens');
  });
});
