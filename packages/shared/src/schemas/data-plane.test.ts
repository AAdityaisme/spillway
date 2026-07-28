import { describe, it, expect } from 'vitest';
import { ChatCompletionsRequest } from './data-plane.js';

describe('ChatCompletionsRequest', () => {
  it('accepts a minimal valid body and passes unknown params through', () => {
    const r = ChatCompletionsRequest.safeParse({
      model: 'gpt-4.1',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.7,
      tools: [{ type: 'function' }],
    });
    expect(r.success).toBe(true);
    if (r.success) {
      // passthrough preserves unknown/optional params for the adapter to handle
      expect((r.data as Record<string, unknown>).temperature).toBe(0.7);
      expect((r.data as Record<string, unknown>).tools).toBeDefined();
    }
  });

  it('rejects a missing model', () => {
    const r = ChatCompletionsRequest.safeParse({ messages: [{ role: 'user', content: 'hi' }] });
    expect(r.success).toBe(false);
  });

  it('rejects empty messages', () => {
    expect(ChatCompletionsRequest.safeParse({ model: 'gpt-4.1', messages: [] }).success).toBe(
      false,
    );
  });

  it('rejects a message with no role', () => {
    const r = ChatCompletionsRequest.safeParse({ model: 'gpt-4.1', messages: [{ content: 'hi' }] });
    expect(r.success).toBe(false);
  });

  it('rejects metadata with non-string values (closes guardrail/routing evasion)', () => {
    const base = { model: 'gpt-4.1', messages: [{ role: 'user', content: 'hi' }] };
    // array value → `['prod'] === 'prod'` would be false → deny policy silently skipped: must 400.
    expect(ChatCompletionsRequest.safeParse({ ...base, metadata: { env: ['prod'] } }).success).toBe(
      false,
    );
    expect(ChatCompletionsRequest.safeParse({ ...base, metadata: { env: 42 } }).success).toBe(
      false,
    );
    // string→string metadata (the OpenAI contract) is accepted
    const ok = ChatCompletionsRequest.safeParse({ ...base, metadata: { env: 'prod', team: 'x' } });
    expect(ok.success).toBe(true);
  });

  it('types stream + max_tokens (VALIDATE reads them)', () => {
    const r = ChatCompletionsRequest.safeParse({
      model: 'gpt-4.1',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      max_tokens: 256,
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.stream).toBe(true);
      expect(r.data.max_tokens).toBe(256);
    }
  });
});
