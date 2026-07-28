/**
 * Attribute activation builder + decision-log snapshot selector (16 §4). Ported from the lab; pure.
 * buildActivation produces the §4.1 catalog (identity/request/spend/time) the structured match + CEL
 * condition read, nested by namespace root (spend.org.month.used_usd → spend:{org:{month:{used_usd}}}).
 *
 * Money contract (§4.2): spend.* money attributes are ADVISORY double dollars (micro-USD / 1e6) — the
 * ONLY place that conversion happens, never on the enforcement path (exact enforcement = BUDGET,
 * ch17). Nullable attributes are OMITTED when null so a CEL has() guard reads false and an unguarded
 * read raises → the §5.4 fail-closed/open contract handles it.
 */

import type { AttributeActivation } from './condition-evaluator.js';
import { normalizeModel } from '../routing/compile.js';
import type { MatchSpec } from './guardrail-types.js';

export type { AttributeActivation };

const MICRO_PER_USD = 1_000_000;

function microToUsd(micro: bigint): number {
  return Number(micro) / MICRO_PER_USD;
}
function usdString(usd: number): string {
  return usd.toFixed(6);
}

export type SpendScope = 'key' | 'team' | 'org' | 'provider';
export type SpendPeriod = 'day' | 'month';

export interface SpendCounterInput {
  used: bigint; // fresh counter read (ctx.spendSnapshot); 0n if none
  limit: bigint | null; // budget limit (bundle) in micro-USD; null if no budget
}

export type SpendInput = Partial<
  Record<SpendScope, Partial<Record<SpendPeriod, SpendCounterInput>>>
>;

export interface ActivationInput {
  identity: {
    orgId: string;
    teamId: string | null;
    virtualKeyId: string;
    keyTags: string[];
    actor: string | null;
  };
  request: {
    modelRequested: string;
    modelResolved: string;
    provider: string;
    endpoint: string;
    stream: boolean;
    hasTools: boolean;
    toolCount: number;
    responseFormat: string | null;
    temperature: number | null;
    maxOutputTokens: number | null;
    inputEst: number;
    metadata: Record<string, string>;
  };
  spend: SpendInput;
  time: Date;
}

/** Build the §4.1 activation. Omits nullable attributes when null (has()-correct). */
export function buildActivation(input: ActivationInput): AttributeActivation {
  const identity: Record<string, unknown> = {
    org_id: input.identity.orgId,
    virtual_key_id: input.identity.virtualKeyId,
    key_tags: input.identity.keyTags,
  };
  if (input.identity.teamId !== null) identity.team_id = input.identity.teamId;
  if (input.identity.actor !== null) identity.actor = input.identity.actor;

  const request: Record<string, unknown> = {
    model_requested: normalizeModel(input.request.modelRequested),
    model_resolved: normalizeModel(input.request.modelResolved),
    provider: input.request.provider,
    endpoint: input.request.endpoint,
    stream: input.request.stream,
    has_tools: input.request.hasTools,
    tool_count: input.request.toolCount,
    tokens: { input_est: input.request.inputEst },
    metadata: { ...input.request.metadata },
  };
  if (input.request.responseFormat !== null) request.response_format = input.request.responseFormat;
  if (input.request.temperature !== null) request.temperature = input.request.temperature;
  if (input.request.maxOutputTokens !== null)
    request.max_output_tokens = input.request.maxOutputTokens;

  const spend: Record<string, unknown> = {};
  for (const scope of Object.keys(input.spend) as SpendScope[]) {
    const periods = input.spend[scope];
    if (!periods) continue;
    const scopeObj: Record<string, unknown> = {};
    for (const period of Object.keys(periods) as SpendPeriod[]) {
      const counter = periods[period];
      if (!counter) continue;
      scopeObj[period] = buildSpendMetrics(counter);
    }
    spend[scope] = scopeObj;
  }

  const time: Record<string, unknown> = {
    hour_utc: input.time.getUTCHours(),
    dow: (input.time.getUTCDay() + 6) % 7, // 0=Sunday → Mon=0..Sun=6
    ts: input.time,
  };

  return { identity, request, spend, time };
}

function buildSpendMetrics(counter: SpendCounterInput): Record<string, unknown> {
  const metrics: Record<string, unknown> = { used_usd: microToUsd(counter.used) };
  if (counter.limit !== null) {
    metrics.limit_usd = microToUsd(counter.limit);
    metrics.utilization =
      counter.limit === 0n ? null : Number(counter.used) / Number(counter.limit);
    const remaining = counter.limit - counter.used;
    metrics.remaining_usd = microToUsd(remaining > 0n ? remaining : 0n);
  }
  return metrics;
}

// ── §4.3 snapshot selector ──────────────────────────────────────────────────

export interface SnapshotPolicy {
  match: MatchSpec;
  refs: readonly string[];
}

const ALWAYS_PATHS: readonly string[] = [
  'identity.org_id',
  'identity.team_id',
  'identity.virtual_key_id',
  'identity.key_tags',
  'identity.actor',
  'request.model_requested',
  'request.model_resolved',
  'time.ts',
];

const MATCH_FIELD_PATHS: Record<string, readonly string[]> = {
  virtual_key_ids: ['identity.virtual_key_id'],
  team_ids: ['identity.team_id'],
  models: ['request.model_requested', 'request.model_resolved'],
  providers: ['request.provider'],
  endpoints: ['request.endpoint'],
};

const MONEY_PATH = /^spend\.[a-z]+\.[a-z]+\.(used_usd|limit_usd|remaining_usd)$/;

/** §4.3 snapshot: (matched policies' match fields) ∪ (their CEL refs) ∪ the always-set, read from
 *  the activation. Missing → null; money → numeric string (§6.4). */
export function buildSnapshot(
  policies: readonly SnapshotPolicy[],
  activation: AttributeActivation,
): Record<string, unknown> {
  const paths = new Set<string>(ALWAYS_PATHS);
  for (const p of policies) {
    for (const [field, fieldPaths] of Object.entries(MATCH_FIELD_PATHS)) {
      if ((p.match as Record<string, unknown>)[field] !== undefined) {
        for (const fp of fieldPaths) paths.add(fp);
      }
    }
    if (p.match.metadata) {
      for (const entry of p.match.metadata) {
        for (const k of Object.keys(entry)) paths.add(`request.metadata.${k}`);
      }
    }
    for (const ref of p.refs) paths.add(ref);
  }

  const out: Record<string, unknown> = {};
  for (const path of paths) {
    const raw = readPath(activation, path);
    const value = raw === undefined ? null : raw;
    out[path] = MONEY_PATH.test(path) && typeof value === 'number' ? usdString(value) : value;
  }
  return out;
}

function readPath(activation: AttributeActivation, path: string): unknown {
  let cur: unknown = activation;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}
