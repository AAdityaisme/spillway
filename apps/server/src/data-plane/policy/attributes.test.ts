import { describe, it, expect } from 'vitest';
import { buildActivation, buildSnapshot, type ActivationInput } from './attributes.js';

/**
 * buildActivation / buildSnapshot (16 §4). expanded-audit M7 (coverage gap): money → numeric string,
 * nullable attributes omitted (has()-correct), zero-limit utilization guard, and the §4.3 snapshot
 * selector (matched match-fields ∪ CEL refs ∪ always-set) with missing → null.
 */
const baseInput = (o: Partial<ActivationInput> = {}): ActivationInput => ({
  identity: { orgId: 'org', teamId: null, virtualKeyId: 'vk', keyTags: [], actor: null },
  request: {
    modelRequested: 'gpt-4o',
    modelResolved: 'gpt-4o',
    provider: 'openai',
    endpoint: 'chat_completions',
    stream: false,
    hasTools: false,
    toolCount: 0,
    responseFormat: null,
    temperature: null,
    maxOutputTokens: null,
    inputEst: 10,
    metadata: {},
  },
  spend: {},
  time: new Date('2026-07-11T15:00:00Z'),
  ...o,
});

describe('buildActivation (16 §4.1)', () => {
  it('omits nullable identity/request attributes when null (has()-correct)', () => {
    const a = buildActivation(baseInput());
    expect('team_id' in a.identity).toBe(false);
    expect('actor' in a.identity).toBe(false);
    expect('response_format' in a.request).toBe(false);
    expect('temperature' in a.request).toBe(false);
    expect('max_output_tokens' in a.request).toBe(false);
  });

  it('includes nullable attributes when present', () => {
    const a = buildActivation(
      baseInput({
        identity: {
          orgId: 'org',
          teamId: 't1',
          virtualKeyId: 'vk',
          keyTags: ['x'],
          actor: 'alice',
        },
        request: {
          ...baseInput().request,
          responseFormat: 'json',
          temperature: 0.5,
          maxOutputTokens: 100,
        },
      }),
    );
    expect(a.identity.team_id).toBe('t1');
    expect(a.identity.actor).toBe('alice');
    expect(a.request.response_format).toBe('json');
  });

  it('spend metrics: advisory double dollars + utilization; zero-limit → null utilization', () => {
    const a = buildActivation(
      baseInput({
        spend: {
          org: {
            month: { used: 1_500_000n, limit: 3_000_000n }, // $1.50 used of $3.00
            day: { used: 100n, limit: 0n }, // zero-limit guard
          },
        },
      }),
    );
    type PeriodMetrics = {
      used_usd: number;
      limit_usd: number;
      utilization: number | null;
      remaining_usd: number;
    };
    const org = a.spend.org as { month: PeriodMetrics; day: PeriodMetrics };
    const month = org.month;
    expect(month.used_usd).toBeCloseTo(1.5);
    expect(month.limit_usd).toBeCloseTo(3.0);
    expect(month.utilization).toBeCloseTo(0.5);
    expect(month.remaining_usd).toBeCloseTo(1.5);
    expect(org.day.utilization).toBeNull(); // divide-by-zero guard
  });
});

describe('buildSnapshot (16 §4.3)', () => {
  it('always-set paths present; money serialized as a 6-dp string; missing → null', () => {
    const a = buildActivation(
      baseInput({ spend: { org: { month: { used: 2_000_000n, limit: 4_000_000n } } } }),
    );
    const snap = buildSnapshot([{ match: {}, refs: ['spend.org.month.used_usd'] }], a);
    expect(snap['identity.org_id']).toBe('org');
    expect(snap['identity.team_id']).toBeNull(); // omitted in activation → null in snapshot
    expect(snap['request.model_requested']).toBe('gpt-4o');
    expect(snap['spend.org.month.used_usd']).toBe('2.000000'); // money → numeric string
  });

  it('adds a policy match field paths + metadata key paths', () => {
    const a = buildActivation(
      baseInput({ request: { ...baseInput().request, metadata: { env: 'prod' } } }),
    );
    const snap = buildSnapshot(
      [{ match: { providers: ['openai'], metadata: [{ env: 'prod' }] }, refs: [] }],
      a,
    );
    expect(snap['request.provider']).toBe('openai');
    expect(snap['request.metadata.env']).toBe('prod');
  });
});
