/**
 * Model-certification capability registry (part-3/06). `DECLARED_CAPS` is the SINGLE source of truth
 * the router, the /v1/models catalog, and the smoke-test runner all read from: an adapter may not
 * advertise a capability (e.g. VISION) it hasn't proven. An adapter with no entry declares nothing.
 */

export type CapabilityId =
  | 'CHAT_NONSTREAM' // basic non-streaming chat completion
  | 'CHAT_STREAM' // streaming chat (SSE pass-through + usage chunk)
  | 'STREAM_CANCEL' // client abort + mid-stream upstream kill → reconcile still runs
  | 'USAGE_EXTRACTION' // cost-reconciled token counts, correct billing (Appendix D)
  | 'CONTEXT_LIMIT' // 413/400 context-length errors classified as context_window
  | 'RATE_LIMIT_RETRY' // 429 classified isRetryable + retryAfterMs parsed
  | 'BUDGET_ENFORCEMENT' // 402 block fires before dispatch when budget exceeded
  | 'TOOL_CALLS' // function calling / tool_use round-trip
  | 'STRUCTURED_OUTPUT' // response_format {type:'json_schema'} transform + passthrough
  | 'VISION' // image_url / base64 content blocks
  | 'AUDIO' // transcription / speech endpoints
  | 'EMBEDDINGS' // embed endpoint, vector dimensionality
  | 'TRACE_AUDIT'; // request_id propagation, PII redaction, retention

/** Every capability id, in declaration order — the smoke runner + fixture-check iterate this. */
export const ALL_CAPABILITIES: readonly CapabilityId[] = [
  'CHAT_NONSTREAM',
  'CHAT_STREAM',
  'STREAM_CANCEL',
  'USAGE_EXTRACTION',
  'CONTEXT_LIMIT',
  'RATE_LIMIT_RETRY',
  'BUDGET_ENFORCEMENT',
  'TOOL_CALLS',
  'STRUCTURED_OUTPUT',
  'VISION',
  'AUDIO',
  'EMBEDDINGS',
  'TRACE_AUDIT',
];

export const DECLARED_CAPS: Record<string, ReadonlySet<CapabilityId>> = {
  openai: new Set([
    'CHAT_NONSTREAM',
    'CHAT_STREAM',
    'STREAM_CANCEL',
    'USAGE_EXTRACTION',
    'CONTEXT_LIMIT',
    'RATE_LIMIT_RETRY',
    'BUDGET_ENFORCEMENT',
    'TOOL_CALLS',
    'STRUCTURED_OUTPUT',
    'VISION',
    'EMBEDDINGS',
    'TRACE_AUDIT',
  ]),
  anthropic: new Set([
    'CHAT_NONSTREAM',
    'CHAT_STREAM',
    'STREAM_CANCEL',
    'USAGE_EXTRACTION',
    'CONTEXT_LIMIT',
    'RATE_LIMIT_RETRY',
    'BUDGET_ENFORCEMENT',
    'TOOL_CALLS',
    'TRACE_AUDIT',
  ]),
  gemini: new Set([
    'CHAT_NONSTREAM',
    'CHAT_STREAM',
    'USAGE_EXTRACTION',
    'EMBEDDINGS',
    'CONTEXT_LIMIT',
    'RATE_LIMIT_RETRY',
    'TRACE_AUDIT',
  ]),
  openai_compat: new Set([
    'CHAT_NONSTREAM',
    'CHAT_STREAM',
    'USAGE_EXTRACTION',
    'CONTEXT_LIMIT',
    'RATE_LIMIT_RETRY',
  ]),
};

export const CERTIFIED_PROVIDERS: readonly string[] = Object.keys(DECLARED_CAPS);

/** The capabilities a provider has declared (empty set for an unknown provider — declares nothing). */
export function getDeclaredCaps(provider: string): ReadonlySet<CapabilityId> {
  return DECLARED_CAPS[provider] ?? new Set<CapabilityId>();
}

/** Is `capability` declared for `provider`? (the router/catalog gate + the smoke-runner's work list). */
export function isCapabilityDeclared(provider: string, capability: CapabilityId): boolean {
  return getDeclaredCaps(provider).has(capability);
}
