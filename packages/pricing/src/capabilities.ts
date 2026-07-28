/**
 * Model-capability catalog (15-routing-engine §5.1; owned by 20 §pricing/model-metadata). The static
 * source of truth for which capability tokens each model advertises — the population input for the
 * `model_prices.capabilities` column (via the pricing-sync job + seed). The RUNTIME hard-filter reads
 * the DB column, not this map; this is only how that column gets filled.
 *
 * Capability vocabulary mirrors the VALIDATE known-capability set (data-plane/pipeline/validate.ts):
 * a request's `require_capabilities` is intersected against these per candidate. Values are DELIBERATELY
 * conservative — a missing capability drops the candidate, so over-claiming is worse than under-claiming
 * (a wrongly-claimed `tools` routes a tool call to a model that silently drops it). Re-verify at build
 * time (bible §5.1 warning): these reflect ~June-2026 model families and WILL drift.
 */

export type Capability =
  | 'tools'
  | 'response_format'
  | 'json_schema'
  | 'seed'
  | 'reasoning'
  | 'vision'
  | 'stream';

// Shared bases. `as const` + spread keeps each family's set a plain string[] the DB column stores.
const GPT4: readonly Capability[] = [
  'tools',
  'response_format',
  'json_schema',
  'seed',
  'vision',
  'stream',
];
const O_SERIES: readonly Capability[] = [
  'tools',
  'response_format',
  'json_schema',
  'reasoning',
  'vision',
  'stream',
];
const GPT35: readonly Capability[] = ['tools', 'response_format', 'json_schema', 'seed', 'stream'];
const CLAUDE_BASE: readonly Capability[] = ['tools', 'vision', 'stream'];
const GEMINI_BASE: readonly Capability[] = [
  'tools',
  'response_format',
  'json_schema',
  'vision',
  'stream',
];

/** Anthropic extended-thinking families (adds `reasoning` to the claude base). */
const CLAUDE_REASONING = /(?:-4-|opus-4|sonnet-4|haiku-4|3-7|3\.7)/;

/**
 * The capability set a model advertises, or `null` when unknown. `null` leaves the catalog column NULL
 * (the model is excluded from the loaded catalog), which — once the catalog is non-empty — causes the
 * §5.1 hard-filter to DROP the model for any capability-required request rather than silently forward.
 */
export function capabilitiesFor(provider: string, model: string): Capability[] | null {
  const m = model.toLowerCase();
  switch (provider) {
    case 'openai':
      if (/^o\d/.test(m)) return [...O_SERIES]; // o1 / o3 / o4-mini reasoning models
      if (/^gpt-4/.test(m)) return [...GPT4];
      if (/^gpt-3\.5/.test(m)) return [...GPT35];
      return null;
    case 'anthropic':
      if (!m.startsWith('claude')) return null;
      return CLAUDE_REASONING.test(m) ? [...CLAUDE_BASE, 'reasoning'] : [...CLAUDE_BASE];
    case 'gemini':
      if (!m.startsWith('gemini')) return null;
      return /gemini-2\.5/.test(m) ? [...GEMINI_BASE, 'reasoning'] : [...GEMINI_BASE];
    default:
      return null; // openai_compat + unknown providers → best-effort (no capability claims)
  }
}
