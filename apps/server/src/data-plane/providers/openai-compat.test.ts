import { describe, it, expect } from 'vitest';
import { SpillwayError } from '@spillway/shared';
import { openaiCompatAdapter } from './openai-compat.js';
import type { Candidate } from './types.js';

const cand = (baseUrl: string): Candidate => ({
  provider: 'openai_compat',
  model: 'grok-2-latest',
  providerKeyId: 'pk1',
  baseUrl,
});

const tf = (baseUrl: string, body: Record<string, unknown>, injectUsage = false) => {
  const r = openaiCompatAdapter.transform(body, cand(baseUrl), 'sk-compat-key', { injectUsage });
  return {
    url: r.url,
    out: r.body as Record<string, unknown>,
    dropped: r.dropped ?? [],
    headers: r.headers,
  };
};

const base = { model: 'client-sent', messages: [{ role: 'user', content: 'hi' }] };

describe('openaiCompatAdapter.transform — baseUrl routing', () => {
  it('routes to candidate.baseUrl + /chat/completions and sets Bearer auth', () => {
    const { url, out, headers } = tf('https://api.x.ai/v1', base);
    expect(url).toBe('https://api.x.ai/v1/chat/completions');
    expect(out.model).toBe('grok-2-latest'); // candidate model wins over client-sent
    expect(headers.Authorization).toBe('Bearer sk-compat-key');
    expect(out.stream).toBe(false);
  });

  it('strips trailing slash(es) off base_url before appending the path', () => {
    expect(tf('https://api.deepseek.com/v1/', base).url).toBe(
      'https://api.deepseek.com/v1/chat/completions',
    );
    expect(tf('https://host.example.com///', base).url).toBe(
      'https://host.example.com/chat/completions',
    );
  });

  it('inherits OpenAI request shaping: injects stream_options.include_usage when streaming', () => {
    const { out } = tf('https://api.x.ai/v1', { ...base, stream: true }, true);
    expect(out.stream).toBe(true);
    expect(out.stream_options).toEqual({ include_usage: true });
  });

  it('inherits strip-and-record: unknown params dropped', () => {
    const { out, dropped } = tf('https://api.x.ai/v1', { ...base, seed: 7, foo: 'bar' });
    expect(out.seed).toBe(7);
    expect(dropped).toContain('foo');
  });
});

describe('openaiCompatAdapter.transform — SSRF re-validation at dispatch (06 §4.3)', () => {
  const rejects = (baseUrl: string) =>
    expect(() =>
      openaiCompatAdapter.transform(base, cand(baseUrl), 'sk', { injectUsage: false }),
    ).toThrow(SpillwayError);

  it('rejects a link-local / cloud-metadata base_url (169.254.169.254)', () => {
    rejects('https://169.254.169.254/v1');
  });

  it('rejects loopback and private-range hosts', () => {
    rejects('https://127.0.0.1/v1');
    rejects('https://localhost/v1');
    rejects('https://10.0.0.5/v1');
    rejects('https://192.168.1.1/v1');
  });

  it('rejects an obfuscated-IP bypass and non-https scheme', () => {
    rejects('https://0x7f000001/v1'); // hex-encoded 127.0.0.1
    rejects('http://api.x.ai/v1'); // must be https
  });

  it('rejects a missing base_url as a configuration fault', () => {
    expect(() =>
      openaiCompatAdapter.transform(
        base,
        { provider: 'openai_compat', model: 'm', providerKeyId: 'pk1' },
        'sk',
        {
          injectUsage: false,
        },
      ),
    ).toThrow(SpillwayError);
  });

  it('allows a public https host', () => {
    expect(() => tf('https://api.together.xyz/v1', base)).not.toThrow();
  });
});

describe('openaiCompatAdapter.parseBody — OpenAI response shape (§4.7)', () => {
  it('extracts usage with cached-token subtraction from prompt_tokens', () => {
    const u = openaiCompatAdapter.parseBody({
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 500,
        prompt_tokens_details: { cached_tokens: 200 },
        completion_tokens_details: { reasoning_tokens: 90 },
      },
    });
    expect(u).toMatchObject({
      input_tokens: 800, // 1000 − 200 cached
      output_tokens: 500,
      cached_read_tokens: 200,
      reasoning_tokens: 90,
      usage_estimated: false,
    });
  });

  it('returns null on absent/all-zero usage (estimation trigger)', () => {
    expect(openaiCompatAdapter.parseBody({})).toBeNull();
    expect(
      openaiCompatAdapter.parseBody({ usage: { prompt_tokens: 0, completion_tokens: 0 } }),
    ).toBeNull();
  });
});

describe('openaiCompatAdapter.createStreamParser — OpenAI SSE shape (§4.6)', () => {
  const feed = (events: string[]) => {
    const p = openaiCompatAdapter.createStreamParser(cand('https://api.x.ai/v1'));
    for (const d of events) p.processEvent({ data: d });
    return p;
  };

  it('captures the terminal usage chunk (empty choices + usage)', () => {
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
    const u = p.getUsage({}, 'grok-2-latest');
    expect(u.input_tokens).toBe(800);
    expect(u.output_tokens).toBe(500);
    expect(u.usage_estimated).toBe(false);
  });

  it('estimates when the upstream ignores include_usage (Degradation Rule 1)', () => {
    const p = feed([JSON.stringify({ choices: [{ delta: { content: 'hello world' } }] })]);
    const u = p.getUsage({ messages: [{ role: 'user', content: '12345678' }] }, 'grok-2-latest');
    expect(u.usage_estimated).toBe(true);
    expect(u.output_tokens).toBeGreaterThan(0);
  });
});

describe('openaiCompatAdapter.mapError — OpenAI taxonomy (§4.8)', () => {
  it('classifies rate-limit / server / client statuses like the openai adapter', () => {
    expect(openaiCompatAdapter.mapError(429, {})).toMatchObject({
      spillwayCode: 'provider_rate_limited',
      isRetryable: true,
      errorClass: 'rate_limit',
    });
    expect(openaiCompatAdapter.mapError(503, {})).toMatchObject({
      isRetryable: true,
      errorClass: 'server',
    });
    expect(openaiCompatAdapter.mapError(400, {})).toMatchObject({
      isClientError: true,
      isRetryable: false,
      errorClass: 'client',
    });
    expect(openaiCompatAdapter.mapError(401, {})).toMatchObject({ errorClass: 'auth' });
  });

  it('tolerates null / HTML bodies (never forwards raw upstream HTML)', () => {
    expect(openaiCompatAdapter.mapError(502, '<html>bad gateway</html>').rawBody).toBeNull();
  });
});
