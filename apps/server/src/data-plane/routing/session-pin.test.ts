import { describe, it, expect } from 'vitest';
import { InMemorySessionPinStore, sessionPinKey } from './session-pin.js';
import type { Candidate } from './compile.js';

const cand: Candidate = { provider: 'openai', model: 'gpt-4o', providerKeyId: 'pk-1' };

describe('InMemorySessionPinStore (15 §4.5, B2.3)', () => {
  it('org-scoped keys never collide across tenants', () => {
    expect(sessionPinKey('org-a', 's1')).toBe('org-a:s1');
    expect(sessionPinKey('org-a', 's1')).not.toBe(sessionPinKey('org-b', 's1'));
  });

  it('stores + returns a pin, expires after the inactivity TTL', () => {
    let t = 1000;
    const store = new InMemorySessionPinStore({ ttlMs: 100, now: () => t });
    const key = sessionPinKey('org-a', 's1');
    store.set(key, cand);
    expect(store.get(key)?.candidate.model).toBe('gpt-4o');
    t = 1099;
    expect(store.get(key)).toBeDefined(); // still inside TTL
    t = 1100;
    expect(store.get(key)).toBeUndefined(); // expired at exactly now >= expiresAt
  });
});
