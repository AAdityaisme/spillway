import { describe, it, expect } from 'vitest';
import { estimateCandidateCostMicro, estimateCandidateCostMicroSync } from './reservation.js';
import { priceOverrides } from '../../db/schema.js';
import type { ModelPriceRow } from '@spillway/pricing';
import type { DatabaseClient } from '../../db/client.js';
import type { Candidate } from '../routing/compile.js';
import type { PipelineContext, Endpoint } from '../pipeline/context.js';

/**
 * estimateCandidateCostMicro sizes the budget hold (expanded-audit H2) — it must be an honest upper
 * bound on what reconcile will actually bill for THE ONE CANDIDATE about to be dispatched. These pin
 * the arithmetic (not just pass/fail) the same way budget.integration.test.ts's B5 cases do, for the
 * model_prices.max_output_tokens fix: when the caller sets no max_tokens, the hold should use the
 * model's real output ceiling from the DB instead of always guessing
 * RESERVE_DEFAULT_MAX_OUTPUT_TOKENS (4096).
 */

/** A model_prices/price_overrides row with every priceCols() column defaulted to null, overridable. */
const priceRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  provider: 'openai',
  inputUsdPerM: '2',
  outputUsdPerM: '8',
  cacheReadUsdPerM: null,
  cacheWrite5mUsdPerM: null,
  cacheWrite1hUsdPerM: null,
  inputUsdPerMLong: null,
  longContextThreshold: null,
  tiers: null,
  serviceTierMultipliers: null,
  inputCostPerAudioUsdPerM: null,
  outputCostPerAudioUsdPerM: null,
  inputCostPerImageUsdPerUnit: null,
  outputCostPerImageUsdPerUnit: null,
  toolCostPerSessionUsd: null,
  webSearchCostPerQueryUsd: null,
  regionalMultipliers: null,
  maxOutputTokens: null,
  ...overrides,
});

/** Fakes the `db.select(cols).from(table).where(cond).limit(1)` chain getModelPrice() runs — no real
 *  Postgres, matching the fake-DatabaseClient pattern used in pricing-catalog.test.ts. `prices` answers
 *  the model_prices query, `overrides` (default empty) answers the price_overrides query. */
function fakeDb(
  prices: Record<string, unknown>[],
  overrides: Record<string, unknown>[] = [],
): DatabaseClient {
  return {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: () => Promise.resolve(table === priceOverrides ? overrides : prices),
        }),
      }),
    }),
  } as unknown as DatabaseClient;
}

const candidate = (model = 'gpt-4.1'): Candidate => ({
  provider: 'openai',
  model,
  providerKeyId: 'pk-1',
});

/** Only fills the fields estimateCandidateCostMicro (and completionCount) actually read. */
function buildCtx(opts: {
  db?: DatabaseClient;
  estimatedInputTokens?: number;
  endpoint?: Endpoint;
  maxTokens?: number;
  n?: number;
  priceByCandidate?: ReadonlyMap<string, ModelPriceRow>;
}): PipelineContext {
  const body: Record<string, unknown> = {};
  if (opts.maxTokens !== undefined) body.max_tokens = opts.maxTokens;
  if (opts.n !== undefined) body.n = opts.n;
  return {
    deps: { db: opts.db },
    estimatedInputTokens: opts.estimatedInputTokens ?? 0,
    endpoint: opts.endpoint ?? 'chat_completions',
    priceByCandidate: opts.priceByCandidate ?? new Map(),
    validatedBody: body,
  } as unknown as PipelineContext;
}

describe('estimateCandidateCostMicro — max_output_tokens ceiling', () => {
  it('no max_tokens + model row WITH max_output_tokens: hold uses the real per-model ceiling', async () => {
    const db = fakeDb([priceRow({ maxOutputTokens: 16384 })]);
    const ctx = buildCtx({ db, estimatedInputTokens: 1 });
    // (1 input tok × $2/M + 16384 output tok × $8/M) = $0.131074, not the $0.032770 4096-token guess.
    await expect(estimateCandidateCostMicro(ctx, candidate())).resolves.toBe(131_074n);
  });

  it('no max_tokens + model row with NULL max_output_tokens: falls back to the 4096 default', async () => {
    const db = fakeDb([priceRow({ maxOutputTokens: null })]);
    const ctx = buildCtx({ db, estimatedInputTokens: 1 });
    // (1 × $2/M + 4096 × $8/M) = $0.032770 — the pre-fix B5 value, unchanged for unpopulated rows.
    await expect(estimateCandidateCostMicro(ctx, candidate())).resolves.toBe(32_770n);
  });

  it('explicit max_tokens still wins over a populated max_output_tokens ceiling', async () => {
    const db = fakeDb([priceRow({ maxOutputTokens: 16384 })]);
    const ctx = buildCtx({ db, estimatedInputTokens: 1, maxTokens: 100 });
    // (1 × $2/M + 100 × $8/M) = $0.000802 — the caller's own tighter bound is authoritative.
    await expect(estimateCandidateCostMicro(ctx, candidate())).resolves.toBe(802n);
  });

  it('embeddings: output term stays 0 even when max_output_tokens is populated', async () => {
    const db = fakeDb([
      priceRow({ inputUsdPerM: '0.02', outputUsdPerM: '0', maxOutputTokens: 16384 }),
    ]);
    const ctx = buildCtx({ db, estimatedInputTokens: 1000, endpoint: 'embeddings' });
    // 1000 × $0.02/M = $0.000020; the 16384 ceiling must not leak an output term into an embeddings hold.
    await expect(estimateCandidateCostMicro(ctx, candidate())).resolves.toBe(20n);
  });

  it('n > 1 still multiplies the per-completion ceiling (B5)', async () => {
    const db = fakeDb([priceRow({ inputUsdPerM: '1', outputUsdPerM: '1', maxOutputTokens: 1000 })]);
    const ctx = buildCtx({ db, estimatedInputTokens: 0, n: 3 });
    // 3 completions × 1000 real-ceiling tokens × $1/M = $0.003000.
    await expect(estimateCandidateCostMicro(ctx, candidate())).resolves.toBe(3000n);
  });

  it('an override hit (no max_output_tokens column) falls back to the 4096 default', async () => {
    const db = fakeDb([priceRow({ maxOutputTokens: 99_999 })], [priceRow()]);
    const ctx = buildCtx({ db, estimatedInputTokens: 1 });
    // price_overrides wins over model_prices but carries no max_output_tokens column at all — the
    // 99,999 ceiling on the (shadowed) model_prices row must NOT leak through.
    await expect(estimateCandidateCostMicro(ctx, candidate())).resolves.toBe(32_770n);
  });
});

describe('estimateCandidateCostMicro — per-candidate sizing', () => {
  /** The chain that used to be walked for a max-over-chain hold, as PRICING hands it to DISPATCH. */
  const priced = new Map<string, ModelPriceRow>([
    [
      'openai:cheap',
      priceRow({
        inputUsdPerM: '1',
        outputUsdPerM: '1',
        maxOutputTokens: 100,
      }) as unknown as ModelPriceRow,
    ],
    [
      'anthropic:pricy',
      priceRow({
        inputUsdPerM: '5',
        outputUsdPerM: '20',
        maxOutputTokens: 500,
      }) as unknown as ModelPriceRow,
    ],
  ]);

  it('prices the candidate handed in — a pricier CHAIN MEMBER no longer inflates it', async () => {
    // The hold used to be sized max-over-chain, so this same request reserved the pricy candidate's
    // 10,000 µUSD on the CHEAP candidate's provider row. Per-candidate reservation makes each hold the
    // cost of the dispatch it authorizes: 100 µUSD here, 10,000 only when the pricy one is dispatched.
    const ctx = buildCtx({ priceByCandidate: priced });
    await expect(
      estimateCandidateCostMicro(ctx, { provider: 'openai', model: 'cheap', providerKeyId: 'k' }),
    ).resolves.toBe(100n);
    await expect(
      estimateCandidateCostMicro(ctx, {
        provider: 'anthropic',
        model: 'pricy',
        providerKeyId: 'k',
      }),
    ).resolves.toBe(10_000n);
  });

  it("reuses PRICING's price map — a chain advance costs no DB round-trip", () => {
    // deps.db is undefined: any fall-through to getModelPrice would throw, so a value here proves the
    // snapshot was used.
    const ctx = buildCtx({ priceByCandidate: priced });
    expect(
      estimateCandidateCostMicroSync(ctx, {
        provider: 'openai',
        model: 'cheap',
        providerKeyId: 'k',
      }),
    ).toBe(100n);
  });

  it('sync variant returns null for a candidate PRICING never loaded (its caller must not guess)', () => {
    const ctx = buildCtx({ priceByCandidate: priced });
    expect(
      estimateCandidateCostMicroSync(ctx, {
        provider: 'openai',
        model: 'unknown',
        providerKeyId: 'k',
      }),
    ).toBeNull();
  });

  it('an unpriceable candidate returns null (unchanged: pricing 503s before dispatch)', async () => {
    const ctx = buildCtx({ db: fakeDb([]), estimatedInputTokens: 1 });
    await expect(estimateCandidateCostMicro(ctx, candidate())).resolves.toBeNull();
  });
});
