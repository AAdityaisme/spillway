import { describe, it, expect } from 'vitest';
import {
  DECLARED_CAPS,
  ALL_CAPABILITIES,
  CERTIFIED_PROVIDERS,
  getDeclaredCaps,
  isCapabilityDeclared,
} from './matrix.js';

/**
 * part-3/06 §2 — the capability matrix is the single source of truth. Guard its invariants: every
 * declared provider declares at least CHAT_NONSTREAM, and no entry declares a capability outside the
 * closed CapabilityId set (a typo'd cap would silently never certify).
 */
describe('DECLARED_CAPS matrix', () => {
  const known = new Set(ALL_CAPABILITIES);

  it('every declared provider declares at least CHAT_NONSTREAM (the minimum to be importable)', () => {
    for (const p of CERTIFIED_PROVIDERS) {
      expect(getDeclaredCaps(p).has('CHAT_NONSTREAM'), p).toBe(true);
    }
  });

  it('no entry declares an unknown capability id', () => {
    for (const [provider, caps] of Object.entries(DECLARED_CAPS)) {
      for (const c of caps) expect(known.has(c), `${provider}:${c}`).toBe(true);
    }
  });

  it('unknown provider declares nothing (fail-closed)', () => {
    expect(getDeclaredCaps('cohere').size).toBe(0);
    expect(isCapabilityDeclared('cohere', 'CHAT_NONSTREAM')).toBe(false);
  });

  it('capability declarations match the chapter (openai full, compat conservative)', () => {
    expect(isCapabilityDeclared('openai', 'VISION')).toBe(true);
    expect(isCapabilityDeclared('anthropic', 'VISION')).toBe(false); // v1: no vision for anthropic
    expect(isCapabilityDeclared('gemini', 'EMBEDDINGS')).toBe(true);
    expect(isCapabilityDeclared('openai_compat', 'BUDGET_ENFORCEMENT')).toBe(false); // conservative base
  });
});
