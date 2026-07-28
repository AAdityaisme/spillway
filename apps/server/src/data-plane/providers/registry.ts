import { SpillwayError } from '@spillway/shared';
import type { Adapter, Candidate, Capabilities, RequestFeature } from './types.js';
import { HARD_GATE_FEATURES } from './types.js';
import { openaiAdapter } from './openai.js';
import { anthropicAdapter } from './anthropic.js';
import { geminiAdapter } from './gemini.js';
import { openaiCompatAdapter } from './openai-compat.js';

/** provider → Adapter singleton. Unsupported providers are rejected at configuration time.
 *  Keyed by the ProviderName union (routing/compile.ts); every value's `.provider` matches its key. */
const ADAPTERS: Record<string, Adapter> = {
  openai: openaiAdapter,
  anthropic: anthropicAdapter,
  gemini: geminiAdapter,
  openai_compat: openaiCompatAdapter,
};

export function getAdapter(provider: string): Adapter {
  const adapter = ADAPTERS[provider];
  if (!adapter) {
    throw new SpillwayError('no_candidates', `no adapter for provider ${provider}`, {
      httpStatus: 502,
    });
  }
  return adapter;
}

// ── Part III adapter-contract §3: the provider-agnostic routing façade ───────────────────────────────

/** The concrete (post-route) model's declared capabilities. Keys off Candidate.model, never an alias. */
export function getCapabilities(provider: string, model: string): Capabilities {
  return getAdapter(provider).capabilitiesFor(model);
}

/** Analyze a validated request body → the RequestFeatures it needs (OpenAI-canonical body at VALIDATE).
 *  Mirrors OpenRouter's auto-filter: presence of tools → 'tools', json_schema response_format →
 *  'structured_output', image content parts → 'vision', stream:true → 'streaming', etc. Only SEMANTIC
 *  (hard-gated) features are inferred here — cosmetic params (seed, logprobs) are soft-dropped elsewhere. */
export function requiredFeatures(body: unknown): RequestFeature[] {
  const b = (body ?? {}) as Record<string, unknown>;
  const out = new Set<RequestFeature>();
  if (Array.isArray(b.tools) && b.tools.length > 0) out.add('tools');
  if (b.tool_choice === 'required') out.add('tool_choice_required');
  const rf = b.response_format as { type?: string } | undefined;
  if (rf?.type === 'json_schema') out.add('structured_output');
  else if (rf?.type === 'json_object') out.add('json_mode');
  if (b.stream === true) out.add('streaming');
  // Vision: any user message carrying an image_url content part (OpenAI multimodal shape).
  if (Array.isArray(b.messages)) {
    for (const m of b.messages as Array<{ content?: unknown }>) {
      if (
        Array.isArray(m.content) &&
        m.content.some((p) => (p as { type?: string }).type === 'image_url')
      ) {
        out.add('vision');
        break;
      }
    }
  }
  return [...out];
}

/**
 * Hard-gate: the routed candidate MUST declare every SEMANTIC feature this request needs, else fail fast
 * with `unsupported_feature` (400, client-class — never retried, never advances the fallback chain).
 * DECLARE-don't-discover: reject locally instead of sending doomed live traffic (wastes latency, burns
 * quota, pollutes breaker health). Non-semantic features are ignored here (soft-dropped elsewhere).
 */
export function assertSupported(candidate: Candidate, features: RequestFeature[]): void {
  const caps = getCapabilities(candidate.provider, candidate.model);
  for (const f of features) {
    if (HARD_GATE_FEATURES.has(f) && !caps.features.has(f)) {
      throw new SpillwayError(
        'unsupported_feature',
        `model ${candidate.provider}/${candidate.model} does not support ${f}`,
        { httpStatus: 400, details: { feature: f, model: candidate.model } },
      );
    }
  }
}

/** Does a candidate support ALL required SEMANTIC features? (the skip-not-fail predicate for routing). */
export function candidateSupports(candidate: Candidate, features: RequestFeature[]): boolean {
  const caps = getCapabilities(candidate.provider, candidate.model);
  return features.every((f) => !HARD_GATE_FEATURES.has(f) || caps.features.has(f));
}
