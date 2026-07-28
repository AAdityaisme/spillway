import { describe, it, expect } from 'vitest';
import { getAdapter } from './registry.js';
import type { ProviderName } from '../routing/compile.js';

/**
 * Registry wiring (06-providers §0.1). Every ProviderName in the routing union must resolve to a
 * distinct adapter singleton whose `.provider` matches the lookup key — a mismatch would silently
 * dispatch a request to the wrong provider's transform/usage/error mapping.
 */
describe('provider registry', () => {
  const PROVIDERS: ProviderName[] = ['openai', 'anthropic', 'gemini', 'openai_compat'];

  it('returns an adapter for all four providers, each self-identifying correctly', () => {
    for (const p of PROVIDERS) {
      const adapter = getAdapter(p);
      expect(adapter).toBeDefined();
      expect(adapter.provider).toBe(p);
      // the full Adapter contract is present
      expect(typeof adapter.transform).toBe('function');
      expect(typeof adapter.parseBody).toBe('function');
      expect(typeof adapter.createStreamParser).toBe('function');
      expect(typeof adapter.mapError).toBe('function');
    }
  });

  it('returns four DISTINCT adapter instances', () => {
    const instances = new Set(PROVIDERS.map((p) => getAdapter(p)));
    expect(instances.size).toBe(4);
  });

  it('throws a 502 no_candidates for an unknown provider', () => {
    expect(() => getAdapter('cohere')).toThrowError(/no adapter for provider cohere/);
  });
});
