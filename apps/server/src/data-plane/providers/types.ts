/**
 * Provider adapter contracts (06-providers §0.1). An adapter turns the validated inbound
 * body into an upstream HTTP request, parses the response usage (non-streaming via
 * parseBody, streaming via createStreamParser), and maps upstream HTTP errors. The
 * DISPATCH stage decrypts the provider key just-in-time and passes it in — adapters never
 * touch the DB or the Encryptor.
 *
 * `Adapter.createStreamParser` is added in Phase C step C2 (alongside its openai
 * implementation, so the interface + impl land green together). The StreamParser + SseEvent
 * types below are defined here in C0 so the tee (C3) and parser (C2) share one contract.
 */

// A concrete (provider, model) dispatchable target. Defined in routing/compile.ts (it carries the
// ProviderName union + optional baseUrl for the dispatch chain); re-exported here so the adapter
// contract + the pipeline share ONE Candidate definition (15 §4.6, de-dup per plan B2.1).
export type { Candidate } from '../routing/compile.js';
import type { Candidate, ErrorClass } from '../routing/compile.js';
export type { ErrorClass };

// ── Part III adapter-contract (part-3/01) — the provider-agnostic capability vocabulary ─────────────
// The single source of truth (in code) that model-registry cap_* columns and certification's
// CapabilityId enum both PROJECT from (synthesis-memo §2.1/§2.2). Defined here so packages/pricing +
// packages/certifier import, never re-declare. NB: this is the SYSTEM-inferred feature gate (does the
// routed model support what THIS request needs), distinct from 15 §5.1's caller-supplied
// `require_capabilities` filter — related vocabulary, different mechanism.

/** The mode axis (LiteLLM `mode`). audio/image are modalities of chat, not separate tasks. */
export type ModelTask = 'chat' | 'embeddings' | 'batch';

/** Input/output modality declarations (mirrors OpenRouter input_modalities/output_modalities). */
export type Modality = 'text' | 'image' | 'audio' | 'pdf' | 'video';

/** The closed feature set routing may ask a model about. Adapters translate it; routing reasons over
 *  it. `structured_output` is the canonical name for JSON-schema-constrained output (synthesis-memo
 *  §2.1 freezes it over model-registry's cap_json_schema / certification's STRUCTURED_OUTPUT). */
export type RequestFeature =
  | 'tools'
  | 'tool_choice_required'
  | 'parallel_tool_calls'
  | 'structured_output'
  | 'json_mode'
  | 'vision'
  | 'audio_input'
  | 'audio_output'
  | 'reasoning_effort'
  | 'prompt_caching'
  | 'streaming'
  | 'logprobs'
  | 'web_search'
  | 'pdf_input'
  | 'embeddings'
  | 'batch';

/** A model's declared, statically-known capabilities — queryable without I/O (DECLARE, don't discover). */
export interface Capabilities {
  tasks: ModelTask[];
  inputModalities: Modality[];
  outputModalities: Modality[];
  features: ReadonlySet<RequestFeature>;
  maxContextTokens?: number;
  maxOutputTokens?: number;
}

/** SEMANTIC features that MUST hard-gate (a silent drop returns a wrong-shaped answer the caller can't
 *  detect). Cosmetic params (logprobs, seed, penalties) are soft-dropped via `dropped[]` instead. */
export const HARD_GATE_FEATURES: ReadonlySet<RequestFeature> = new Set<RequestFeature>([
  'tools',
  'structured_output',
  'json_mode',
  'vision',
  'audio_input',
  'audio_output',
  'embeddings',
  'batch',
]);

/**
 * The FEATURE → model-registry `cap_*` column contract (synthesis-memo §2.1). Committed NOW — before
 * the DB columns exist — to PIN the vocabulary the model-registry + certification PRs must honor, so the
 * "three names for one feature" divergence can't happen. Partial by design: only features that get a
 * boolean registry column are listed (finer-grained ones like parallel_tool_calls stay code-only). NB
 * the frozen rename: `structured_output` → `cap_structured_output` (NOT the old `cap_json_schema`).
 */
export const FEATURE_CAP_COLUMN: Partial<Record<RequestFeature, string>> = {
  streaming: 'cap_streaming',
  tools: 'cap_tools',
  structured_output: 'cap_structured_output',
  vision: 'cap_vision',
  audio_input: 'cap_audio_input',
  audio_output: 'cap_audio_output',
  embeddings: 'cap_embeddings',
  batch: 'cap_batch',
  reasoning_effort: 'cap_reasoning',
  prompt_caching: 'cap_prompt_cache',
};

/** The 7 canonical telemetry error-class names (the brief's alias over the existing ErrorClass union).
 *  A presentation/telemetry alias ONLY — the executor's typed-chain switch keeps the existing strings
 *  (renaming would ripple through fallback + health scoring for zero behavior gain). */
export const CANONICAL_ERROR_CLASS: Record<NonNullable<ErrorClass>, string> = {
  rate_limit: 'rate_limited',
  context_window: 'context_limit',
  content_policy: 'safety_refusal',
  client: 'invalid_request',
  auth: 'auth',
  timeout: 'timeout',
  server: 'transient',
};

export interface TransformResult {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: unknown; // JSON.stringify'd by the dispatcher
  /** Stripped/unrecognized param keys → surfaced as x-spillway-dropped-params (06 §0.2). */
  dropped?: string[];
}

/** Canonical usage extracted from a provider response (06 §6 field mapping). */
export interface ParsedUsage {
  input_tokens: number; // FULL-RATE portion only (openai: prompt_tokens − cached)
  output_tokens: number;
  cached_read_tokens: number;
  cache_write_5m_tokens: number;
  cache_write_1h_tokens: number;
  cache_type: '5m' | '1h' | null;
  reasoning_tokens: number; // inside output_tokens — recorded, never billed separately
  usage_estimated: boolean;
  // Part III multi-modal dimensions (synthesis-memo §2.2 / Overlap-4). Optional + absent on text-only
  // chat, so this stays non-breaking; images bill per-UNIT (image_input_units), not per-token.
  audio_input_tokens?: number;
  audio_output_tokens?: number;
  image_input_units?: number;
}

/**
 * One parsed SSE event off the wire. `data` is the raw payload after the `data: ` prefix —
 * either a JSON chunk string or the literal `[DONE]` terminator. The tee feeds these to the
 * parser (a COPY — the client gets the raw bytes byte-for-byte, ADR-008).
 */
export interface SseEvent {
  data: string;
}

/**
 * Stateful per-request streaming usage extractor (06 §0.1). The tee calls processEvent for
 * each SSE event as it flows to the client, then getUsage once the stream ends.
 *
 * Unlike parseBody, getUsage NEVER returns null: it returns REAL usage when the upstream
 * emitted a usage chunk, else an ESTIMATE (usage_estimated:true) from the accumulated output
 * text + the request body. So a stream always produces a metered row.
 */
export interface StreamParser {
  processEvent(event: SseEvent): void;
  getUsage(requestBody: unknown, model: string): ParsedUsage;
}

export interface MappedError {
  spillwayCode: string; // provider-error label (advisory); not a SpillwayErrorCode
  httpStatus: number;
  isRetryable: boolean;
  isClientError: boolean; // 400/413 → surface immediately, never advance the chain
  errorClass: ErrorClass; // 15 §7.1 — drives per-error-class fallback advancement + health scoring
  retryAfterMs: number | null;
  rawBody: unknown;
}

export interface Adapter {
  readonly provider: string;
  /** `injectUsage` is the streaming stream_options flag (Phase C); always false in Phase B. */
  transform(
    body: unknown,
    candidate: Candidate,
    decryptedKey: string,
    opts: { injectUsage: boolean },
  ): TransformResult;
  /** /v1/embeddings transform (task #9). OPTIONAL: absent = the provider has no embeddings API
   *  (anthropic, gemini for now) — the ROUTE capability hard-gate blocks those candidates first;
   *  dispatch re-checks as defense-in-depth. Embeddings is non-streaming, so no opts. */
  transformEmbeddings?(body: unknown, candidate: Candidate, decryptedKey: string): TransformResult;
  /** Non-streaming usage extraction; null when usage is absent/zero (→ estimation trigger). */
  parseBody(
    responseBody: unknown,
    candidate?: Candidate,
    requestBody?: unknown,
  ): ParsedUsage | null;
  /** Map an upstream HTTP error to retryability/surface flags; tolerant of null/HTML bodies. */
  mapError(httpStatus: number, body: unknown): MappedError;
  /** Build a per-request streaming usage extractor (Phase C). Fed each SSE event by the tee. */
  createStreamParser(candidate: Candidate): StreamParser;
  /** Part III: the model's declared capabilities from the adapter's static catalog. MUST be pure +
   *  synchronous — no network, no DB (a live probe reintroduces discover-by-traffic on the hot path). */
  capabilitiesFor(model: string): Capabilities;
  /** Convenience: does `model` declare `feature`? = capabilitiesFor(model).features.has(feature). */
  supports(model: string, feature: RequestFeature): boolean;
}
