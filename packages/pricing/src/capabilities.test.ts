import { describe, it, expect } from 'vitest';
import { capabilitiesFor } from './capabilities.js';

/**
 * §5.1 static capability catalog — the population source for model_prices.capabilities. Conservative
 * by design (a missing capability drops the candidate, so over-claiming is the dangerous error).
 */
describe('capabilitiesFor', () => {
  it('gpt-4 family: tools/json/seed/vision, but NOT reasoning', () => {
    const caps = capabilitiesFor('openai', 'gpt-4o')!;
    expect(caps).toEqual(
      expect.arrayContaining([
        'tools',
        'response_format',
        'json_schema',
        'seed',
        'vision',
        'stream',
      ]),
    );
    expect(caps).not.toContain('reasoning');
    expect(capabilitiesFor('openai', 'gpt-4.1-mini')).toEqual(caps); // family match, not exact
  });

  it('o-series are reasoning models with no seed', () => {
    const caps = capabilitiesFor('openai', 'o3-mini')!;
    expect(caps).toContain('reasoning');
    expect(caps).not.toContain('seed');
    expect(capabilitiesFor('openai', 'o1')).toContain('reasoning');
  });

  it('gpt-3.5 has no vision', () => {
    expect(capabilitiesFor('openai', 'gpt-3.5-turbo')).not.toContain('vision');
  });

  it('claude base is tools/vision/stream; extended-thinking families add reasoning', () => {
    expect(capabilitiesFor('anthropic', 'claude-3-5-sonnet')).toEqual([
      'tools',
      'vision',
      'stream',
    ]);
    expect(capabilitiesFor('anthropic', 'claude-sonnet-4-6')).toContain('reasoning');
    expect(capabilitiesFor('anthropic', 'claude-3-7-sonnet')).toContain('reasoning');
    expect(capabilitiesFor('anthropic', 'claude-opus-4-8')).toContain('reasoning');
    // Anthropic has no native response_format/seed → never claimed.
    expect(capabilitiesFor('anthropic', 'claude-opus-4-8')).not.toContain('seed');
    expect(capabilitiesFor('anthropic', 'claude-opus-4-8')).not.toContain('response_format');
  });

  it('gemini 2.5 adds reasoning over the 1.5 base', () => {
    expect(capabilitiesFor('gemini', 'gemini-1.5-pro')).not.toContain('reasoning');
    expect(capabilitiesFor('gemini', 'gemini-2.5-flash')).toContain('reasoning');
    expect(capabilitiesFor('gemini', 'gemini-2.5-flash')).toContain('vision');
  });

  it('unknown families/providers return null (excluded from the catalog, best-effort forward)', () => {
    expect(capabilitiesFor('openai', 'whisper-1')).toBeNull();
    expect(capabilitiesFor('anthropic', 'text-embedding-3')).toBeNull();
    expect(capabilitiesFor('gemini', 'text-bison')).toBeNull();
    expect(capabilitiesFor('openai_compat', 'llama-3.1-70b')).toBeNull();
  });
});
