import { describe, it, expect } from 'vitest';
import { runValidate } from './validate.js';
import type { PipelineContext } from './context.js';
import type { PolicyBundle } from './auth.js';

const policy = (o: Partial<PolicyBundle> = {}): PolicyBundle => ({
  virtualKeyId: 'vk',
  orgId: 'org',
  teamId: null,
  keyStatus: 'active',
  allowedProviders: null,
  allowedModels: null,
  complianceClass: 'none',
  maxInputTokens: null,
  maxOutputTokens: null,
  rpmLimit: null,
  tpmLimit: null,
  maxParallel: 32,
  expiresAt: null,
  keyTags: [],
  providerKeys: [],
  aliases: [],
  routingRules: [],
  governancePolicies: [],
  compiledPolicies: [],
  budgets: [],
  configSnapshotHash: 'test',
  cachedAt: 0,
  ...o,
});
const ctx = (
  body: unknown,
  pol: PolicyBundle = policy(),
  headers: Record<string, string> = {},
): PipelineContext =>
  ({
    req: { body, headers },
    policy: pol,
    requestedModel: '',
    validatedBody: {},
    knobs: { sessionId: null, requireCapabilities: null, traceEnabled: false, provider: null },
    requestFeatures: {},
    estimatedInputTokens: 0,
  }) as unknown as PipelineContext;

const okBody = { model: 'gpt-4.1', messages: [{ role: 'user', content: 'hi' }] };

describe('runValidate', () => {
  it('accepts a valid body; sets requestedModel + validatedBody', () => {
    const c = ctx(okBody);
    runValidate(c);
    expect(c.requestedModel).toBe('gpt-4.1');
    expect((c.validatedBody as Record<string, unknown>).model).toBe('gpt-4.1');
  });

  it('rejects an invalid body (zod) as 400', () => {
    expect(() => runValidate(ctx({ messages: [] }))).toThrow();
  });

  it('accepts streaming and records ctx.stream (Phase C)', () => {
    const c = ctx({ ...okBody, stream: true });
    runValidate(c);
    expect(c.stream).toBe(true);
    expect(c.requestedModel).toBe('gpt-4.1'); // still validates normally
  });

  it('captures service_tier for the pricing multiplier; null when absent', () => {
    const flex = ctx({ ...okBody, service_tier: 'flex' });
    runValidate(flex);
    expect(flex.serviceTier).toBe('flex');
    const none = ctx(okBody);
    runValidate(none);
    expect(none.serviceTier).toBeNull();
  });

  it('enforces the model allow-list (403)', () => {
    expect(() => runValidate(ctx(okBody, policy({ allowedModels: ['gpt-4o'] })))).toThrow(
      /not permitted/i,
    );
  });

  it('does NOT enforce the provider allow-list (that gate moved to ROUTE, per-resolved-candidate)', () => {
    // VALIDATE no longer hardcodes an openai-only provider gate — all four providers are supported,
    // and the provider allow-list is enforced against the RESOLVED candidate in resolve.ts
    // (assembleDefault/assembleVariant). A gpt-4.1 body with allowedProviders=['anthropic'] passes
    // VALIDATE and is rejected downstream in ROUTE.
    expect(() =>
      runValidate(ctx(okBody, policy({ allowedProviders: ['anthropic'] }))),
    ).not.toThrow();
  });

  it('rejects oversized input (request_too_large)', () => {
    const big = { model: 'gpt-4.1', messages: [{ role: 'user', content: 'x'.repeat(1000) }] };
    expect(() => runValidate(ctx(big, policy({ maxInputTokens: 10 })))).toThrow(/max input/i);
  });

  it('clamps max_tokens to the key ceiling + stashes the original', () => {
    const c = ctx({ ...okBody, max_tokens: 5000 }, policy({ maxOutputTokens: 1000 }));
    runValidate(c);
    const b = c.validatedBody as Record<string, unknown>;
    expect(b.max_tokens).toBe(1000);
    expect(b.original_max_tokens).toBe(5000);
  });

  it('clamps max_completion_tokens too (red-team: clamp bypass)', () => {
    const c = ctx({ ...okBody, max_completion_tokens: 999_999 }, policy({ maxOutputTokens: 256 }));
    runValidate(c);
    const b = c.validatedBody as Record<string, unknown>;
    expect(b.max_tokens).toBe(256);
    expect(b.original_max_tokens).toBe(999_999);
    expect(b.max_completion_tokens).toBeUndefined();
  });

  it('counts top-level system in the input-size guard (red-team: size bypass)', () => {
    const body = {
      model: 'gpt-4.1',
      messages: [{ role: 'user', content: 'hi' }],
      system: 'x'.repeat(1000),
    };
    expect(() => runValidate(ctx(body, policy({ maxInputTokens: 10 })))).toThrow(/max input/i);
  });

  it('strips client-supplied original_max_tokens (red-team: audit poison)', () => {
    const c = ctx({ ...okBody, original_max_tokens: 99_999 }); // no ceiling → no clamp
    runValidate(c);
    expect((c.validatedBody as Record<string, unknown>).original_max_tokens).toBeUndefined();
  });

  it('divides the output ceiling by n so TOTAL output stays bounded (red-team: n multiplier)', () => {
    const c = ctx({ ...okBody, n: 128, max_tokens: 100 }, policy({ maxOutputTokens: 100 }));
    runValidate(c);
    const b = c.validatedBody as Record<string, unknown>;
    expect(b.max_tokens).toBe(1); // max(1, floor(100/128)) = 1
    expect(b.original_max_tokens).toBe(100);
  });

  it('imposes the output ceiling even when the client omits max_tokens (red-team: unenforced ceiling)', () => {
    const c = ctx({ ...okBody }, policy({ maxOutputTokens: 256 }));
    runValidate(c);
    const b = c.validatedBody as Record<string, unknown>;
    expect(b.max_tokens).toBe(256);
    expect(b.original_max_tokens).toBeUndefined(); // no client value to record
  });
});

describe('runValidate — safe knobs (15 §5, B2.1)', () => {
  it('parses a valid session pin (header wins over body)', () => {
    const c = ctx({ ...okBody, session_id: 'body-sess' }, policy(), {
      'x-spillway-session-id': 'hdr.sess-1',
    });
    runValidate(c);
    expect(c.knobs.sessionId).toBe('hdr.sess-1');
  });

  it('rejects an invalid session id (422)', () => {
    expect(() =>
      runValidate(ctx(okBody, policy(), { 'x-spillway-session-id': 'bad id!' })),
    ).toThrow(/session id/i);
  });

  it('parses + dedupes require-capabilities; rejects unknown (422)', () => {
    const ok = ctx(okBody, policy(), { 'x-spillway-require-capabilities': 'tools, tools, vision' });
    runValidate(ok);
    expect(ok.knobs.requireCapabilities).toEqual(['tools', 'vision']);
    expect(() =>
      runValidate(ctx(okBody, policy(), { 'x-spillway-require-capabilities': 'telepathy' })),
    ).toThrow(/capabilit/i);
  });

  it('bounds require_capabilities BEFORE dedupe — a giant duplicate array is rejected (422, L2)', () => {
    // A huge array of duplicate VALID caps would dedupe to {tools} and pass if the cardinality check
    // ran post-dedupe. The raw-length bound must reject it first (expanded-audit L2).
    const body = { ...okBody, 'spillway.require_capabilities': Array(10_000).fill('tools') };
    expect(() => runValidate(ctx(body))).toThrow(/capabilit/i);
    // header comma-split is bounded the same way.
    expect(() =>
      runValidate(
        ctx(okBody, policy(), {
          'x-spillway-require-capabilities': Array(10_000).fill('tools').join(','),
        }),
      ),
    ).toThrow(/capabilit/i);
  });

  it('provider knob must be real (422) and in the allow-list (403)', () => {
    expect(() => runValidate(ctx(okBody, policy(), { 'x-spillway-provider': 'foocorp' }))).toThrow(
      /unknown provider/i,
    );
    expect(() =>
      runValidate(
        ctx(okBody, policy({ allowedProviders: ['openai'] }), {
          'x-spillway-provider': 'anthropic',
        }),
      ),
    ).toThrow(/not permitted/i);
    const ok = ctx(okBody, policy(), {
      'x-spillway-provider': 'openai',
      'x-spillway-trace': 'on', // 20 §6: on | 1 | true (case-insensitive)
    });
    runValidate(ok);
    expect(ok.knobs.provider).toBe('openai');
    expect(ok.knobs.traceEnabled).toBe(true);
  });

  it('trace opt-in accepts on/1/true (case-insensitive), rejects anything else (20 §6)', () => {
    const trace = (v: string | undefined): boolean => {
      const c = ctx(okBody, policy(), v === undefined ? {} : { 'x-spillway-trace': v });
      runValidate(c);
      return c.knobs.traceEnabled;
    };
    for (const v of ['on', '1', 'true', 'TRUE', 'On']) expect(trace(v)).toBe(true);
    for (const v of ['enabled', 'off', '0', 'yes', undefined]) expect(trace(v)).toBe(false);
  });
});

describe('runValidate — structural request features (19 §6.2, B2.1)', () => {
  it('computes the structural feature subset', () => {
    const c = ctx({
      model: 'gpt-4.1',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'yo' },
      ],
      tools: [{ type: 'function', function: { name: 'f' } }],
      response_format: { type: 'json_object' },
      temperature: 0.7,
      n: 2,
    });
    runValidate(c);
    expect(c.requestFeatures).toMatchObject({
      message_count: 2,
      has_tools: true,
      tool_count: 1,
      has_response_format: true,
      temperature: 0.7,
      stream: false,
      n: 2,
    });
    expect(c.requestFeatures.estimated_input_tokens).toBe(c.estimatedInputTokens);
    expect(c.estimatedInputTokens).toBeGreaterThan(0);
  });
});
