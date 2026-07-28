import type { RequestFeatures } from '../../data-plane/pipeline/context.js';

/**
 * Savings-insight classifier (Part II §19 §8) — HEURISTIC mode. Consumes the compact `request_features`
 * (ADR-043 §6) recorded on each request and flags model-downgrade opportunities: requests served on an
 * expensive model that a cheaper same-family sibling would very likely have handled identically.
 *
 * Feature FLOORS (never recommend a downgrade for these — they need the stronger model):
 *   - has_tools OR has_response_format  → structured/tool use, keep the capable model.
 *   - q_truncated OR finish_reason='length' → the model wanted MORE room; a weaker one is worse.
 * Everything else on a downgradable model is a candidate.
 *
 * The MLP secondary classifier (§8) is a documented SEAM, not built: `method: 'heuristic'` +
 * `heuristicOnly: true` on the summary so a consumer knows recommendations are rule-based. This module
 * is pure (no IO) so the job and any dry-run share one evaluator and it is testable without a DB.
 */

/** Static same-family downgrade map (seam: could become data-driven / MLP-ranked). */
export const DOWNGRADES: Readonly<Record<string, string>> = {
  'gpt-4o': 'gpt-4o-mini',
  'gpt-4.1': 'gpt-4.1-mini',
  'gpt-4-turbo': 'gpt-4o-mini',
  'claude-3-opus': 'claude-3-5-sonnet',
  'claude-3-5-sonnet': 'claude-3-5-haiku',
  'gemini-1.5-pro': 'gemini-1.5-flash',
};

export interface InsightRequestRow {
  id: string;
  model: string | null;
  costMicroUsd: bigint;
  features: Partial<RequestFeatures> | null;
}

/** Per-1M input rate used to estimate the savings fraction; null ⇒ unknown price (suggestion skipped). */
export type RateLookup = (model: string) => number | null;

export interface DowngradeSuggestion {
  fromModel: string;
  toModel: string;
  requestCount: number;
  estSavingsMicroUsd: bigint;
  sampleRequestIds: string[]; // sampled ids only — NEVER prompt bodies (§8 privacy)
}

export interface ClassifierResult {
  requestsAnalyzed: number;
  suggestions: DowngradeSuggestion[];
  estSavingsMicroUsd: bigint;
  method: 'heuristic';
  heuristicOnly: true;
}

const SAMPLE_CAP = 5;

/** A request is downgradable iff its model has a cheaper sibling AND no feature floor applies. */
function isCandidate(row: InsightRequestRow): boolean {
  if (!row.model || DOWNGRADES[row.model] === undefined) return false;
  const f = row.features;
  if (!f) return false; // no features → don't guess
  if (f.has_tools || f.has_response_format) return false; // capability floor
  if (f.q_truncated || f.finish_reason === 'length') return false; // needed more room
  return true;
}

/**
 * Streaming accumulator — keeps only per-model tallies (count, cost sum, ≤5 sample ids), never the rows
 * themselves, so a whole month of requests can be folded in keyset-paginated batches without ever holding
 * the full set on the heap (red-team round4 F1 — the old classifyDowngrades buffered every candidate row).
 */
export interface DowngradeAccumulator {
  byModel: Map<string, { count: number; costMicro: bigint; sampleIds: string[] }>;
  analyzed: number;
}
export function newDowngradeAccumulator(): DowngradeAccumulator {
  return { byModel: new Map(), analyzed: 0 };
}

/** Fold one batch of rows into the accumulator. Retains nothing beyond the per-model tally. */
export function accumulateDowngrades(acc: DowngradeAccumulator, rows: InsightRequestRow[]): void {
  for (const row of rows) {
    acc.analyzed++;
    if (!isCandidate(row)) continue;
    const m = acc.byModel.get(row.model!);
    if (m === undefined) {
      acc.byModel.set(row.model!, { count: 1, costMicro: row.costMicroUsd, sampleIds: [row.id] });
    } else {
      m.count++;
      m.costMicro += row.costMicroUsd;
      if (m.sampleIds.length < SAMPLE_CAP) m.sampleIds.push(row.id); // first-seen order (== old slice(0,N))
    }
  }
}

/** Build the downgrade suggestions from the accumulated tallies. */
export function finalizeDowngrades(
  acc: DowngradeAccumulator,
  rateFor: RateLookup,
): ClassifierResult {
  const suggestions: DowngradeSuggestion[] = [];
  let total = 0n;
  for (const [fromModel, tally] of acc.byModel) {
    const toModel = DOWNGRADES[fromModel]!;
    const fromRate = rateFor(fromModel);
    const toRate = rateFor(toModel);
    if (fromRate === null || toRate === null || fromRate <= 0) continue; // can't estimate → skip
    const fraction = Math.max(0, Math.min(1, 1 - toRate / fromRate));
    const est = (tally.costMicro * BigInt(Math.round(fraction * 1_000_000))) / 1_000_000n;
    if (est <= 0n) continue;
    total += est;
    suggestions.push({
      fromModel,
      toModel,
      requestCount: tally.count,
      estSavingsMicroUsd: est,
      sampleRequestIds: tally.sampleIds,
    });
  }
  suggestions.sort((a, b) => (b.estSavingsMicroUsd > a.estSavingsMicroUsd ? 1 : -1));
  return {
    requestsAnalyzed: acc.analyzed,
    suggestions,
    estSavingsMicroUsd: total,
    method: 'heuristic',
    heuristicOnly: true,
  };
}

/** All-in-one for callers that already hold the full set in memory (unit tests, small orgs). */
export function classifyDowngrades(
  rows: InsightRequestRow[],
  rateFor: RateLookup,
): ClassifierResult {
  const acc = newDowngradeAccumulator();
  accumulateDowngrades(acc, rows);
  return finalizeDowngrades(acc, rateFor);
}
