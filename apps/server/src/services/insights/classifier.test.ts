import { describe, it, expect } from 'vitest';
import {
  classifyDowngrades,
  newDowngradeAccumulator,
  accumulateDowngrades,
  finalizeDowngrades,
  type InsightRequestRow,
  type RateLookup,
} from './classifier.js';

const rate: RateLookup = (m) => ({ 'gpt-4o': 2.5, 'gpt-4o-mini': 0.15 })[m] ?? null;

const row = (over: Partial<InsightRequestRow> = {}): InsightRequestRow => ({
  id: 'r1',
  model: 'gpt-4o',
  costMicroUsd: 1_000_000n, // $1
  features: {
    has_tools: false,
    has_response_format: false,
    q_truncated: false,
    finish_reason: 'stop',
  },
  ...over,
});

/** B8.5 savings classifier (§19 §8) — heuristic feature consumption + floors. */
describe('classifyDowngrades', () => {
  it('flags a clean expensive-model request → cheaper sibling, with estimated savings', () => {
    const r = classifyDowngrades([row({ id: 'a' }), row({ id: 'b' })], rate);
    expect(r.method).toBe('heuristic');
    expect(r.heuristicOnly).toBe(true);
    expect(r.suggestions).toHaveLength(1);
    const s = r.suggestions[0]!;
    expect(s.fromModel).toBe('gpt-4o');
    expect(s.toModel).toBe('gpt-4o-mini');
    expect(s.requestCount).toBe(2);
    // fraction = 1 - 0.15/2.5 = 0.94; $2 group → ~$1.88 saved
    expect(Number(s.estSavingsMicroUsd)).toBeCloseTo(1_880_000, -3);
    expect(s.sampleRequestIds).toEqual(['a', 'b']);
    expect(Number(r.estSavingsMicroUsd)).toBe(Number(s.estSavingsMicroUsd));
  });

  it('capability floors suppress a downgrade (has_tools / has_response_format)', () => {
    expect(
      classifyDowngrades([row({ features: { has_tools: true } })], rate).suggestions,
    ).toHaveLength(0);
    expect(
      classifyDowngrades([row({ features: { has_response_format: true } })], rate).suggestions,
    ).toHaveLength(0);
  });

  it('q_truncated / finish_reason=length suppress a downgrade (needed more room)', () => {
    expect(
      classifyDowngrades([row({ features: { q_truncated: true } })], rate).suggestions,
    ).toHaveLength(0);
    expect(
      classifyDowngrades([row({ features: { finish_reason: 'length' } })], rate).suggestions,
    ).toHaveLength(0);
  });

  it('a model with no cheaper sibling → not a candidate', () => {
    expect(classifyDowngrades([row({ model: 'gpt-4o-mini' })], rate).suggestions).toHaveLength(0);
  });

  it('an unknown cheaper-model price → suggestion skipped (never guess savings)', () => {
    const noMiniPrice: RateLookup = (m) => (m === 'gpt-4o' ? 2.5 : null);
    expect(classifyDowngrades([row()], noMiniPrice).suggestions).toHaveLength(0);
  });

  it('null features → not a candidate (do not guess)', () => {
    expect(classifyDowngrades([row({ features: null })], rate).suggestions).toHaveLength(0);
  });

  it('F1: streaming in batches equals the all-in-one result (bounded-memory path is behaviour-identical)', () => {
    const rows = [
      row({ id: 'a' }),
      row({ id: 'b', model: 'gpt-4o-mini' }), // not downgradable (no cheaper sibling in the map)
      row({ id: 'c' }),
      row({ id: 'd', features: { has_tools: true } }), // floored out
      row({ id: 'e' }),
    ];
    const oneShot = classifyDowngrades(rows, rate);

    const acc = newDowngradeAccumulator();
    accumulateDowngrades(acc, rows.slice(0, 2)); // batch 1
    accumulateDowngrades(acc, rows.slice(2)); // batch 2 (boundary splits the gpt-4o candidates)
    const streamed = finalizeDowngrades(acc, rate);

    expect(streamed.requestsAnalyzed).toBe(oneShot.requestsAnalyzed);
    expect(streamed.estSavingsMicroUsd).toBe(oneShot.estSavingsMicroUsd);
    expect(streamed.suggestions).toEqual(oneShot.suggestions); // same counts + first-seen sample ids
  });
});
