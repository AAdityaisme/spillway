import { describe, it, expect } from 'vitest';
import { anthropicAdapter, ANTHROPIC_UPSTREAM_URL, ANTHROPIC_VERSION } from './anthropic.js';
import type { Candidate } from './types.js';

const cand: Candidate = { provider: 'anthropic', model: 'claude-sonnet-4-6', providerKeyId: 'pk1' };
const tf = (body: Record<string, unknown>, injectUsage = false) => {
  const r = anthropicAdapter.transform(body, cand, 'sk-ant-test', { injectUsage });
  return {
    out: r.body as Record<string, unknown>,
    dropped: r.dropped ?? [],
    headers: r.headers,
    url: r.url,
  };
};

type Block = { type: string; [k: string]: unknown };
type Msg = { role: string; content: unknown };

describe('anthropicAdapter.transform', () => {
  const base = { model: 'client-sent', messages: [{ role: 'user', content: 'hi' }] };

  it('sets x-api-key + anthropic-version (NOT Authorization: Bearer) and the messages URL', () => {
    const { headers, url } = tf(base);
    expect(headers['x-api-key']).toBe('sk-ant-test');
    expect(headers['anthropic-version']).toBe(ANTHROPIC_VERSION);
    expect(headers.Authorization).toBeUndefined();
    expect(url).toBe(ANTHROPIC_UPSTREAM_URL);
  });

  it('overrides client model with the candidate model', () => {
    expect(tf(base).out.model).toBe('claude-sonnet-4-6');
  });

  it('extracts + concatenates system messages into the top-level system string, in order', () => {
    const { out } = tf({
      model: 'x',
      messages: [
        { role: 'system', content: 'You are terse.' },
        { role: 'user', content: 'hi' },
        { role: 'system', content: 'Be formal.' },
      ],
    });
    expect(out.system).toBe('You are terse.\n\nBe formal.');
    const msgs = out.messages as Msg[];
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toEqual({ role: 'user', content: 'hi' });
  });

  it('folds a top-level system string ahead of a system message', () => {
    const { out } = tf({
      ...base,
      system: 'Top level.',
      messages: [
        { role: 'system', content: 'Msg level.' },
        { role: 'user', content: 'hi' },
      ],
    });
    expect(out.system).toBe('Top level.\n\nMsg level.');
  });

  it('injects DEFAULT max_tokens when absent; honors client max_tokens / max_completion_tokens', () => {
    expect(tf(base).out.max_tokens).toBe(4096);
    expect(tf({ ...base, max_tokens: 256 }).out.max_tokens).toBe(256);
    expect(tf({ ...base, max_completion_tokens: 128 }).out.max_tokens).toBe(128);
    expect(tf({ ...base, max_tokens: 50, max_completion_tokens: 128 }).out.max_tokens).toBe(50);
  });

  it('clamps temperature to Anthropic 0–1 (not 0–2): keeps in-range, strip-records out-of-range', () => {
    expect(tf({ ...base, temperature: 0.5 }).out.temperature).toBe(0.5);
    const bad = tf({ ...base, temperature: 1.5 });
    expect(bad.out.temperature).toBeUndefined();
    expect(bad.dropped).toContain('temperature');
    const nan = tf({ ...base, temperature: NaN });
    expect(nan.out.temperature).toBeUndefined();
    expect(nan.dropped).toContain('temperature');
  });

  it('passes top_k through (Anthropic-only) and renames stop → stop_sequences (wrapping a string)', () => {
    expect(tf({ ...base, top_k: 40 }).out.top_k).toBe(40);
    expect(tf({ ...base, stop: 'END' }).out.stop_sequences).toEqual(['END']);
    expect(tf({ ...base, stop: ['a', 'b'] }).out.stop_sequences).toEqual(['a', 'b']);
    expect(tf({ ...base, stop: 'END' }).out.stop).toBeUndefined();
  });

  it('maps an image_url content part to an Anthropic image block; strips + records image_url.detail', () => {
    const { out, dropped } = tf({
      model: 'x',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look' },
            { type: 'image_url', image_url: { url: 'https://ex.com/a.png', detail: 'high' } },
          ],
        },
      ],
    });
    const blocks = ((out.messages as Msg[])[0]?.content ?? []) as Block[];
    expect(blocks[0]).toEqual({ type: 'text', text: 'look' });
    expect(blocks[1]).toEqual({
      type: 'image',
      source: { type: 'url', url: 'https://ex.com/a.png' },
    });
    expect(dropped).toContain('image_url.detail');
  });

  it('maps a base64 data: image URI to a base64 image source', () => {
    const { out } = tf({
      model: 'x',
      messages: [
        {
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }],
        },
      ],
    });
    const blocks = ((out.messages as Msg[])[0]?.content ?? []) as Block[];
    expect(blocks[0]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
    });
  });

  it('maps assistant tool_calls to tool_use blocks (arguments JSON string → input object)', () => {
    const { out } = tf({
      model: 'x',
      messages: [
        { role: 'user', content: 'search' },
        {
          role: 'assistant',
          content: 'let me look',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'search', arguments: '{"q":"cats"}' },
            },
          ],
        },
      ],
    });
    const blocks = ((out.messages as Msg[])[1]?.content ?? []) as Block[];
    expect(blocks[0]).toEqual({ type: 'text', text: 'let me look' });
    expect(blocks[1]).toEqual({
      type: 'tool_use',
      id: 'call_1',
      name: 'search',
      input: { q: 'cats' },
    });
  });

  it('falls back to {} input on malformed tool_call arguments (never throws)', () => {
    const { out } = tf({
      model: 'x',
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'c1', function: { name: 'f', arguments: 'not json' } }],
        },
      ],
    });
    const blocks = ((out.messages as Msg[])[0]?.content ?? []) as Block[];
    expect(blocks[0]).toEqual({ type: 'tool_use', id: 'c1', name: 'f', input: {} });
  });

  it('maps a tool-result message to a user turn with a tool_result block (tool_call_id→tool_use_id)', () => {
    const { out } = tf({
      model: 'x',
      messages: [{ role: 'tool', tool_call_id: 'call_1', content: '42' }],
    });
    expect((out.messages as Msg[])[0]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '42' }],
    });
  });

  it('maps OpenAI tools → Anthropic tools (parameters → input_schema)', () => {
    const { out } = tf({
      ...base,
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'w',
            parameters: { type: 'object', properties: { city: { type: 'string' } } },
          },
        },
      ],
    });
    expect(out.tools).toEqual([
      {
        name: 'get_weather',
        description: 'w',
        input_schema: { type: 'object', properties: { city: { type: 'string' } } },
      },
    ]);
  });

  it('maps tool_choice variants; none → {type:auto} + records tool_choice (no Anthropic equivalent)', () => {
    expect(tf({ ...base, tool_choice: 'auto' }).out.tool_choice).toEqual({ type: 'auto' });
    expect(tf({ ...base, tool_choice: 'required' }).out.tool_choice).toEqual({ type: 'any' });
    expect(
      tf({ ...base, tool_choice: { type: 'function', function: { name: 'f' } } }).out.tool_choice,
    ).toEqual({ type: 'tool', name: 'f' });
    const none = tf({ ...base, tool_choice: 'none' });
    expect(none.out.tool_choice).toEqual({ type: 'auto' });
    expect(none.dropped).toContain('tool_choice');
  });

  it('keeps metadata.user_id, strips + records other metadata tags', () => {
    const { out, dropped } = tf({ ...base, metadata: { user_id: 'u1', team: 'eng' } });
    expect(out.metadata).toEqual({ user_id: 'u1' });
    expect(dropped).toContain('metadata.team');
  });

  it('strip-records unsupported OpenAI params (n, penalties, logprobs, seed, response_format)', () => {
    const { out, dropped } = tf({
      ...base,
      n: 2,
      frequency_penalty: 0.5,
      presence_penalty: 0.5,
      logprobs: true,
      seed: 7,
      response_format: { type: 'json_object' },
    });
    expect(out.n).toBeUndefined();
    expect(out.seed).toBeUndefined();
    expect(dropped).toEqual(
      expect.arrayContaining([
        'n',
        'frequency_penalty',
        'presence_penalty',
        'logprobs',
        'seed',
        'response_format',
      ]),
    );
  });

  it('honors streaming intent; injectUsage is a no-op (Anthropic streams usage natively, no stream_options)', () => {
    expect(tf(base).out.stream).toBe(false);
    const s = tf({ ...base, stream: true }, true);
    expect(s.out.stream).toBe(true);
    expect(s.out.stream_options).toBeUndefined();
    expect(s.dropped).not.toContain('stream_options');
  });
});

describe('anthropicAdapter.parseBody — usage (§2.5 cache-token trap)', () => {
  it('input_tokens is RAW full-rate (NOT summed with cache); cache read/write in own fields', () => {
    const u = anthropicAdapter.parseBody({
      usage: {
        input_tokens: 100, // post-cache-breakpoint portion — already full-rate
        output_tokens: 40,
        cache_read_input_tokens: 900,
        cache_creation: { ephemeral_5m_input_tokens: 500, ephemeral_1h_input_tokens: 0 },
      },
    });
    expect(u).toEqual({
      input_tokens: 100, // NOT 100+900+500 — summing would double-bill
      output_tokens: 40,
      cached_read_tokens: 900,
      cache_write_5m_tokens: 500,
      cache_write_1h_tokens: 0,
      cache_type: '5m',
      reasoning_tokens: 0,
      usage_estimated: false,
    });
  });

  it('splits cache writes from the explicit cache_creation object; 1h present → cache_type 1h', () => {
    const u = anthropicAdapter.parseBody({
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 800 },
      },
    });
    expect(u?.cache_write_5m_tokens).toBe(200);
    expect(u?.cache_write_1h_tokens).toBe(800);
    expect(u?.cache_type).toBe('1h');
  });

  it('legacy scalar cache_creation_input_tokens: infers TTL from request cache_control (1h)', () => {
    const u = anthropicAdapter.parseBody(
      { usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 300 } },
      undefined,
      { system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral', ttl: '1h' } }] },
    );
    expect(u?.cache_write_1h_tokens).toBe(300);
    expect(u?.cache_write_5m_tokens).toBe(0);
    expect(u?.cache_type).toBe('1h');
  });

  it('legacy scalar defaults to 5m when no cache_control is present on the request', () => {
    const u = anthropicAdapter.parseBody({
      usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 300 },
    });
    expect(u?.cache_write_5m_tokens).toBe(300);
    expect(u?.cache_type).toBe('5m');
  });

  it('no cache tokens → all cache fields 0, cache_type null', () => {
    const u = anthropicAdapter.parseBody({ usage: { input_tokens: 30, output_tokens: 10 } });
    expect(u).toMatchObject({
      input_tokens: 30,
      output_tokens: 10,
      cached_read_tokens: 0,
      cache_write_5m_tokens: 0,
      cache_write_1h_tokens: 0,
      cache_type: null,
    });
  });

  it('returns null on absent or all-zero usage (estimation trigger)', () => {
    expect(anthropicAdapter.parseBody({})).toBeNull();
    expect(anthropicAdapter.parseBody(null)).toBeNull();
    expect(anthropicAdapter.parseBody({ usage: { input_tokens: 0, output_tokens: 0 } })).toBeNull();
  });

  it('clamps >int32 counts and floors negatives (requests-column overflow guard)', () => {
    const big = anthropicAdapter.parseBody({
      usage: { input_tokens: 10, output_tokens: 3_000_000_000 },
    });
    expect(big?.output_tokens).toBe(2_000_000_000);
    const neg = anthropicAdapter.parseBody({ usage: { input_tokens: 10, output_tokens: -5 } });
    expect(neg?.output_tokens).toBe(0);
    expect(neg?.input_tokens).toBe(10);
  });
});

describe('anthropicAdapter.createStreamParser — native usage accumulation (§2.4)', () => {
  const feed = (events: object[]) => {
    const p = anthropicAdapter.createStreamParser(cand);
    for (const e of events) p.processEvent({ data: JSON.stringify(e) });
    return p;
  };

  it('captures input from message_start + cumulative output from message_delta; message_stop → real', () => {
    const p = feed([
      {
        type: 'message_start',
        message: { usage: { input_tokens: 200, cache_read_input_tokens: 50, output_tokens: 1 } },
      },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 42 } }, // cumulative — overwrite
      { type: 'message_stop' },
    ]);
    const u = p.getUsage({}, 'claude-sonnet-4-6');
    expect(u.input_tokens).toBe(200);
    expect(u.output_tokens).toBe(42); // last cumulative value, NOT 3+42
    expect(u.cached_read_tokens).toBe(50);
    expect(u.usage_estimated).toBe(false);
  });

  it('carries cache_creation split from message_start into real usage', () => {
    const p = feed([
      {
        type: 'message_start',
        message: {
          usage: {
            input_tokens: 10,
            output_tokens: 0,
            cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 700 },
          },
        },
      },
      { type: 'message_delta', usage: { output_tokens: 5 } },
      { type: 'message_stop' },
    ]);
    const u = p.getUsage({}, 'claude-sonnet-4-6');
    expect(u.cache_write_1h_tokens).toBe(700);
    expect(u.cache_type).toBe('1h');
    expect(u.usage_estimated).toBe(false);
  });

  it('estimates (usage_estimated:true) when the stream truncates before message_stop', () => {
    // No message_stop: keep the REAL captured input, estimate output from accumulated text.
    const p = feed([
      { type: 'message_start', message: { usage: { input_tokens: 123, output_tokens: 0 } } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello world' } },
    ]);
    const u = p.getUsage({ messages: [{ role: 'user', content: 'ignored' }] }, 'claude-sonnet-4-6');
    expect(u.usage_estimated).toBe(true);
    expect(u.input_tokens).toBe(123); // captured real input preserved (nothing lost)
    expect(u.output_tokens).toBe(3); // ceil(11/4) — "hello world"
  });

  it('estimates fully when message_start never arrived (input from request, output from text)', () => {
    const p = feed([{ type: 'content_block_delta', delta: { type: 'text_delta', text: 'abcd' } }]);
    const u = p.getUsage(
      { messages: [{ role: 'user', content: '12345678' }] },
      'claude-sonnet-4-6',
    );
    expect(u.usage_estimated).toBe(true);
    expect(u.input_tokens).toBe(2); // ceil(8/4)
    expect(u.output_tokens).toBe(1); // ceil(4/4)
  });

  it('counts tool-call input_json_delta so a tool-only truncated stream does not estimate 0 output', () => {
    const p = feed([
      { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 't1', name: 'search' },
      },
      {
        type: 'content_block_delta',
        delta: { type: 'input_json_delta', partial_json: '{"q":"hello world"}' },
      },
    ]);
    const u = p.getUsage({ messages: [{ role: 'user', content: 'hi' }] }, 'claude-sonnet-4-6');
    expect(u.usage_estimated).toBe(true);
    expect(u.output_tokens).toBeGreaterThan(0);
  });

  it('an error event forces estimation even if a message_start was seen', () => {
    const p = feed([
      { type: 'message_start', message: { usage: { input_tokens: 50, output_tokens: 0 } } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } },
      { type: 'error', error: { type: 'overloaded_error' } },
      { type: 'message_stop' }, // even a trailing stop must not upgrade an aborted stream to real
    ]);
    const u = p.getUsage({}, 'claude-sonnet-4-6');
    expect(u.usage_estimated).toBe(true);
  });

  it('skips a malformed SSE line without throwing', () => {
    const p = anthropicAdapter.createStreamParser(cand);
    p.processEvent({ data: 'not json' });
    p.processEvent({ data: '[DONE]' });
    p.processEvent({
      data: JSON.stringify({
        type: 'message_start',
        message: { usage: { input_tokens: 7, output_tokens: 0 } },
      }),
    });
    p.processEvent({
      data: JSON.stringify({ type: 'message_delta', usage: { output_tokens: 4 } }),
    });
    p.processEvent({ data: JSON.stringify({ type: 'message_stop' }) });
    const u = p.getUsage({}, 'claude-sonnet-4-6');
    expect(u.input_tokens).toBe(7);
    expect(u.output_tokens).toBe(4);
  });
});

describe('anthropicAdapter.mapError (§2.6)', () => {
  it('429 rate_limit_error → retryable, rate_limit class', () => {
    expect(anthropicAdapter.mapError(429, { error: { type: 'rate_limit_error' } })).toMatchObject({
      spillwayCode: 'provider_rate_limited',
      isRetryable: true,
      isClientError: false,
      errorClass: 'rate_limit',
    });
  });

  it('529 overloaded_error → retryable, server class (exp-backoff), distinct from 429', () => {
    expect(anthropicAdapter.mapError(529, { error: { type: 'overloaded_error' } })).toMatchObject({
      spillwayCode: 'provider_overloaded',
      isRetryable: true,
      isClientError: false,
      errorClass: 'server',
    });
  });

  it('503 AND 500 → retryable server (both fail over to the next candidate; F2)', () => {
    expect(anthropicAdapter.mapError(503, {})).toMatchObject({
      spillwayCode: 'provider_unavailable',
      isRetryable: true,
      errorClass: 'server',
    });
    // 500 must be retryable: the executor keys canAdvance off isRetryable, so isRetryable:false silently
    // dropped a transient Anthropic 500 instead of failing over (parity with 502/503 + openai 5xx).
    expect(anthropicAdapter.mapError(500, {})).toMatchObject({
      spillwayCode: 'provider_error',
      isRetryable: true,
      errorClass: 'server',
    });
    expect(anthropicAdapter.mapError(502, {})).toMatchObject({
      isRetryable: true,
      errorClass: 'server',
    });
  });

  it('400 invalid_request_error: bare → client; context/safety messages → typed chains', () => {
    expect(
      anthropicAdapter.mapError(400, {
        error: { type: 'invalid_request_error', message: 'bad param' },
      }),
    ).toMatchObject({
      spillwayCode: 'invalid_request',
      isClientError: true,
      isRetryable: false,
      errorClass: 'client',
    });
    expect(
      anthropicAdapter.mapError(400, {
        error: {
          type: 'invalid_request_error',
          message: 'prompt is too long: 300000 tokens > 200000 maximum',
        },
      }),
    ).toMatchObject({ errorClass: 'context_window', isClientError: false, isRetryable: true });
    expect(
      anthropicAdapter.mapError(400, {
        error: { type: 'invalid_request_error', message: 'Output blocked by content policy' },
      }),
    ).toMatchObject({ errorClass: 'content_policy', isClientError: false, isRetryable: true });
  });

  it('401/403 → auth, never retried', () => {
    expect(
      anthropicAdapter.mapError(401, { error: { type: 'authentication_error' } }),
    ).toMatchObject({
      spillwayCode: 'provider_auth_error',
      isRetryable: false,
      errorClass: 'auth',
    });
    expect(anthropicAdapter.mapError(403, { error: { type: 'permission_error' } })).toMatchObject({
      spillwayCode: 'provider_auth_error',
      errorClass: 'auth',
    });
  });

  it('413 request_too_large → surfaced to client; 404 not_found → model_not_found, client class', () => {
    expect(anthropicAdapter.mapError(413, {})).toMatchObject({
      spillwayCode: 'request_too_large',
      isClientError: true,
    });
    expect(anthropicAdapter.mapError(404, { error: { type: 'not_found_error' } })).toMatchObject({
      spillwayCode: 'model_not_found',
      errorClass: 'client',
    });
  });

  it('unrecognized 4xx (422) → surfaced client error, not mislabeled a 5xx provider failure', () => {
    expect(anthropicAdapter.mapError(422, {})).toMatchObject({
      spillwayCode: 'invalid_request',
      isClientError: true,
      isRetryable: false,
      errorClass: 'client',
    });
  });

  it('tolerates null / non-object (HTML) bodies — rawBody nulled, never forwarded', () => {
    expect(anthropicAdapter.mapError(500, null).rawBody).toBeNull();
    expect(anthropicAdapter.mapError(502, '<html>502 Bad Gateway</html>').rawBody).toBeNull();
    expect(anthropicAdapter.mapError(500, null).retryAfterMs).toBeNull();
  });
});
