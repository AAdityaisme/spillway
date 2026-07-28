import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseLitellmPrices, type SyncedPrice } from './litellm-sync.js';

const data = JSON.parse(
  readFileSync(new URL('../data/litellm-prices.json', import.meta.url), 'utf8'),
) as Record<string, Record<string, unknown>>;

const rows = parseLitellmPrices(data);
const byKey = (provider: string, model: string): SyncedPrice | undefined =>
  rows.find((r) => r.provider === provider && r.model === model);

describe('parseLitellmPrices', () => {
  it('only emits the three supported providers (chat + embedding modes)', () => {
    expect(rows.length).toBeGreaterThan(50);
    expect(new Set(rows.map((r) => r.provider))).toEqual(
      new Set(['openai', 'anthropic', 'gemini']),
    );
  });

  it('emits embedding models with output priced 0, never null (task #9)', () => {
    const r = byKey('openai', 'text-embedding-3-small');
    expect(r).toBeDefined();
    expect(r?.inputUsdPerM).toBe('0.020000'); // 0.00000002/tok ×1e6
    // a null output price means "unpriceable" to computeCost and would 503 every embeddings request
    expect(r?.outputUsdPerM).toBe('0.000000');
  });

  it('converts per-token → per-1M (gpt-4.1)', () => {
    const r = byKey('openai', 'gpt-4.1');
    expect(r).toBeDefined();
    expect(r?.inputUsdPerM).toBe('2.000000'); // 0.000002/tok ×1e6
    expect(r?.outputUsdPerM).toBe('8.000000');
    expect(r?.cacheReadUsdPerM).toBe('0.500000');
  });

  it('maps Anthropic cache 5m/1h split (claude-haiku-4-5)', () => {
    const r = byKey('anthropic', 'claude-haiku-4-5-20251001');
    expect(r).toBeDefined();
    expect(r?.cacheWrite5mUsdPerM).toBe('1.250000'); // cache_creation_input_token_cost
    expect(r?.cacheWrite1hUsdPerM).toBe('2.000000'); // ..._above_1hr
    expect(r?.cacheReadUsdPerM).toBe('0.100000');
  });

  it('captures a Gemini long-context tier where present', () => {
    const gemLong = rows.find((r) => r.provider === 'gemini' && r.inputUsdPerMLong !== null);
    expect(gemLong).toBeDefined();
    expect(gemLong?.longContextThreshold).toBeGreaterThanOrEqual(128_000);
  });

  it('every row has valid numeric(12,6) base prices + a bare model id', () => {
    for (const r of rows) {
      expect(r.inputUsdPerM).toMatch(/^\d+\.\d{6}$/);
      expect(r.outputUsdPerM).toMatch(/^\d+\.\d{6}$/);
      expect(r.model).not.toContain('/'); // prefix stripped
      expect(r.source).toBe('litellm');
    }
  });
});
