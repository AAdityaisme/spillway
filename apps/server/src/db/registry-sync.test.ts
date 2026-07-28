import { describe, it, expect } from 'vitest';
import { buildRegistryRows } from './registry-sync.js';

/**
 * part-3/02 registry sync — the pure model_prices→registry mapping. Capabilities come from the adapter
 * catalogs (DECLARE-don't-discover seed); a model whose provider has no adapter is skipped, not guessed.
 */
describe('buildRegistryRows', () => {
  it('maps a catalogued chat model to a production row with its declared caps', () => {
    const { rows } = buildRegistryRows([{ provider: 'openai', model: 'gpt-4o' }]);
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.canonicalId).toBe('openai/gpt-4o');
    expect(r.capTools).toBe(true);
    expect(r.capVision).toBe(true);
    expect(r.capStructuredOutput).toBe(true);
    expect(r.capReasoning).toBe(false); // gpt-4o is not an o-series reasoning model
    expect(r.lifecycle).toBe('production'); // full caps + known limits
    expect(r.contextWindow).toBe(128_000);
  });

  it('maps an embeddings model to the embeddings capability only', () => {
    const { rows } = buildRegistryRows([{ provider: 'openai', model: 'text-embedding-3-small' }]);
    expect(rows[0]!.capEmbeddings).toBe(true);
    expect(rows[0]!.capTools).toBe(false);
  });

  it('stages an uncatalogued model (no known limits) as beta, not production', () => {
    const { rows } = buildRegistryRows([{ provider: 'openai', model: 'some-new-model' }]);
    expect(rows[0]!.lifecycle).toBe('beta'); // fail-open default caps, but no limits → not production-ready
    expect(rows[0]!.contextWindow).toBeNull();
  });

  it('skips a model whose provider has no adapter (never guesses)', () => {
    const { rows, skipped } = buildRegistryRows([
      { provider: 'openai', model: 'gpt-4o' },
      { provider: 'cohere', model: 'command-r' },
    ]);
    expect(rows.map((r) => r.provider)).toEqual(['openai']);
    expect(skipped).toEqual([{ provider: 'cohere', model: 'command-r' }]);
  });
});
