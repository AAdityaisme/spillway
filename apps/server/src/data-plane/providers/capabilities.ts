import type { Capabilities, RequestFeature } from './types.js';

/**
 * Shared static-catalog capability lookup (Part III adapter-contract §2/§3). Each adapter owns a
 * `Record<modelPrefix, Capabilities>` and resolves a concrete model via: exact match → longest-prefix
 * match → a conservative default. Pure + synchronous (DECLARE, don't discover — no network/DB).
 */

/**
 * The fail-OPEN default for a model NOT in a catalog: a modern text+image chat model. It deliberately
 * declares the common chat features so an UNCATALOGUED model is assumed capable (the hard-gate must not
 * start rejecting existing traffic — non-breaking). Specialized features (audio/embeddings/batch/
 * web_search/pdf) are NOT defaulted-on: a model must be explicitly catalogued to serve those, so a
 * request for one against an unknown model is gated rather than sent blind. Explicitly-catalogued
 * limited models (e.g. an embeddings-only model with no chat features) still gate correctly.
 */
export function chatModelDefault(): Capabilities {
  return {
    tasks: ['chat'],
    inputModalities: ['text', 'image'],
    outputModalities: ['text'],
    features: new Set<RequestFeature>([
      'tools',
      'tool_choice_required',
      'parallel_tool_calls',
      'structured_output',
      'json_mode',
      'vision',
      'reasoning_effort',
      'prompt_caching',
      'streaming',
      'logprobs',
    ]),
  };
}

/** exact → longest-prefix → conservative default. Longest prefix wins so `gpt-4o-mini` beats `gpt-4o`. */
export function lookupCapabilities(
  catalog: Record<string, Capabilities>,
  model: string,
): Capabilities {
  const exact = catalog[model];
  if (exact) return exact;
  let best: { prefix: string; caps: Capabilities } | null = null;
  for (const [prefix, caps] of Object.entries(catalog)) {
    if (model.startsWith(prefix) && (best === null || prefix.length > best.prefix.length)) {
      best = { prefix, caps };
    }
  }
  return best?.caps ?? chatModelDefault();
}

/** Build the Adapter.supports convenience from a capabilitiesFor implementation. */
export function makeSupports(
  capabilitiesFor: (model: string) => Capabilities,
): (model: string, feature: RequestFeature) => boolean {
  return (model, feature) => capabilitiesFor(model).features.has(feature);
}

/** A chat-model capability set with an explicit feature list (catalog entry sugar). */
export function chatCaps(
  features: RequestFeature[],
  extra: Partial<Capabilities> = {},
): Capabilities {
  return {
    tasks: ['chat'],
    inputModalities: ['text'],
    outputModalities: ['text'],
    ...extra,
    features: new Set(features),
  };
}
