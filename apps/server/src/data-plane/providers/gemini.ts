import type {
  Adapter,
  Candidate,
  Capabilities,
  MappedError,
  ParsedUsage,
  SseEvent,
  StreamParser,
  TransformResult,
} from './types.js';
import { chatCaps, lookupCapabilities, makeSupports } from './capabilities.js';
import { estimateInputTokens, estimateTokensFromChars } from '../streaming/estimator.js';

/**
 * Gemini declared-capability catalog (Part III §5.2). Multimodal (text+image, and audio/pdf on 1.5+/
 * 2.x) chat + tools + structured output + streaming; 2.5 adds thinking (reasoning_effort). Prefix-keyed;
 * re-verify at build time.
 */
const GEMINI_CHAT = [
  'tools',
  'tool_choice_required',
  'parallel_tool_calls',
  'structured_output',
  'json_mode',
  'vision',
  'streaming',
] as const;
const GEMINI_CATALOG: Record<string, Capabilities> = {
  'gemini-2.5': chatCaps([...GEMINI_CHAT, 'reasoning_effort', 'audio_input'], {
    inputModalities: ['text', 'image', 'audio', 'pdf'],
    maxContextTokens: 1_000_000,
  }),
  'gemini-2.0': chatCaps([...GEMINI_CHAT, 'audio_input'], {
    inputModalities: ['text', 'image', 'audio', 'pdf'],
    maxContextTokens: 1_000_000,
  }),
  'gemini-1.5': chatCaps([...GEMINI_CHAT, 'audio_input'], {
    inputModalities: ['text', 'image', 'audio', 'pdf'],
    maxContextTokens: 2_000_000,
  }),
};

function geminiCapabilitiesFor(model: string): Capabilities {
  return lookupCapabilities(GEMINI_CATALOG, model);
}

/**
 * Gemini adapter (06-providers §3). Gemini is reached via its OpenAI-COMPAT endpoint, NOT its
 * native `generateContent` API — this keeps ONE SSE dialect + ONE request shape in the tee/transform
 * layers (§3.1). So this adapter is structurally the OpenAI adapter with four Gemini deltas:
 *   1. base URL is the Gemini compat path (§3.2);
 *   2. any `models/` prefix is stripped from the model id (§3.3);
 *   3. `reasoning_effort` is strip-and-recorded — `thinking_budget` isn't controllable via compat (§3.7);
 *   4. usage extraction does NOT subtract cached tokens (§3.5) — see mapGeminiUsage's WHY block.
 * Auth is identical to OpenAI: `Authorization: Bearer <key>` (§3.2, §6 auth table).
 */
const UPSTREAM_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';

/** Gemini compat emits OpenAI-shaped usage — same field names, incl. prompt_tokens_details. */
interface RawGeminiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number; audio_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number; audio_tokens?: number };
}

/** Floor at 0, cap below int32 max — a hostile/buggy usage value must not overflow the integer
 *  requests columns and abort the whole reconcile tx (parity with openai.ts clampTok; ADR-032). */
const clampTok = (n: number | undefined): number =>
  Math.max(0, Math.min(Math.trunc(n ?? 0), 2_000_000_000));

/**
 * Gemini usage → canonical ParsedUsage. SHARED by parseBody (non-stream) and the stream parser so
 * the two cost paths cannot drift. Returns null on absent/all-zero usage (caller then estimates).
 *
 * CRITICAL — DO NOT subtract cached from input_tokens (this is the ONE hard divergence from
 * openai.ts). Gemini's `prompt_tokens` is the TOTAL prompt, cached tokens INCLUDED (06 §6 field
 * table: "prompt_tokens (total; Gemini compat follows OpenAI semantics)" — but the billing
 * semantics are Gemini's own). packages/pricing cost.ts has an `isGemini` branch that itself does
 * `fullRateInput = inputTokens − cachedReadTokens` AND keys the 200K long-context tier off the TOTAL
 * (`usage.inputTokens`). If we pre-subtracted here like openai, cost.ts would double-subtract the
 * cached portion (under-bill full-rate input) AND mis-detect the 200K tier boundary. So emit the
 * RAW total as input_tokens; report cached separately in cached_read_tokens.
 */
function mapGeminiUsage(u: RawGeminiUsage | null | undefined): ParsedUsage | null {
  if (!u) return null;
  const prompt = clampTok(u.prompt_tokens);
  const completion = clampTok(u.completion_tokens);
  if (prompt + completion === 0) return null; // floored → sign-cancel can't fake a zero
  const cachedRead = Math.min(clampTok(u.prompt_tokens_details?.cached_tokens), prompt);
  // Part III (part-3/04) audio: Gemini can bill audio input separately. input_tokens stays the RAW TOTAL
  // (isGemini semantics — cost.ts subtracts cached AND audio itself, so the 200K tier still keys off the
  // true total); output audio IS removed from output_tokens here since cost.ts bills output as-is.
  const audioIn = Math.min(clampTok(u.prompt_tokens_details?.audio_tokens), prompt - cachedRead);
  const audioOut = Math.min(clampTok(u.completion_tokens_details?.audio_tokens), completion);
  return {
    input_tokens: prompt, // TOTAL incl. cached + audio — cost.ts (isGemini) subtracts both itself
    output_tokens: Math.max(0, completion - audioOut),
    cached_read_tokens: cachedRead,
    audio_input_tokens: audioIn, // 0 when the response reports no audio → no audio cost line
    audio_output_tokens: audioOut,
    // Gemini uses implicit caching; the compat endpoint bills no explicit cache-write tokens, and
    // cache-storage (token-hours) is out of v1 scope (§3.5, §3.7 accepted limitation).
    cache_write_5m_tokens: 0,
    cache_write_1h_tokens: 0,
    cache_type: null,
    // Via compat, reasoning may not be reported; 0 is treated as accurate for cost (§3.5).
    reasoning_tokens: clampTok(u.completion_tokens_details?.reasoning_tokens), // inside output_tokens
    usage_estimated: false,
  };
}

/**
 * Streaming usage extractor for the Gemini compat endpoint. It emits OpenAI-shaped SSE chunks, so
 * this mirrors OpenAiStreamParser exactly (§3.6 — "same as OpenAI adapter"): accumulate an output
 * CHAR COUNT (bounded memory) for the estimator fallback, and capture the terminal usage-only chunk
 * (empty choices + usage). getUsage never returns null — REAL usage if the chunk arrived, else an
 * ESTIMATE (§3.6 accepted limitation: some model versions may omit the usage chunk).
 */
class GeminiStreamParser implements StreamParser {
  private capturedUsage: RawGeminiUsage | null = null;
  private outputChars = 0; // running count only (NOT the full text) → bounded memory on long streams

  processEvent(event: SseEvent): void {
    if (event.data === '[DONE]') return;
    let chunk: { choices?: unknown; usage?: RawGeminiUsage };
    try {
      chunk = JSON.parse(event.data) as typeof chunk;
    } catch {
      return; // recoverable: a malformed SSE line is skipped, not fatal
    }
    const choices = chunk.choices;
    if (Array.isArray(choices)) {
      for (const c of choices) {
        // Count content AND tool-call args/names AND refusal text — a tool-only stream that
        // truncates before the usage chunk would otherwise estimate ~0 output and under-bill
        // (budget bypass on agentic traffic; parity with openai.ts, red-team ADR-034).
        const delta = (
          c as {
            delta?: {
              content?: unknown;
              refusal?: unknown;
              tool_calls?: unknown;
            };
          }
        )?.delta;
        if (typeof delta?.content === 'string') this.outputChars += delta.content.length;
        if (typeof delta?.refusal === 'string') this.outputChars += delta.refusal.length;
        if (Array.isArray(delta?.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const fn = (tc as { function?: { name?: unknown; arguments?: unknown } })?.function;
            if (typeof fn?.name === 'string') this.outputChars += fn.name.length;
            if (typeof fn?.arguments === 'string') this.outputChars += fn.arguments.length;
          }
        }
      }
      // usage chunk: empty choices + a real usage object (detect by shape, not position)
      if (choices.length === 0 && mapGeminiUsage(chunk.usage))
        this.capturedUsage = chunk.usage ?? null;
    } else if (mapGeminiUsage(chunk.usage)) {
      this.capturedUsage = chunk.usage ?? null; // defensive: usage without a choices array
    }
  }

  getUsage(requestBody: unknown, model: string): ParsedUsage {
    const real = mapGeminiUsage(this.capturedUsage);
    if (real) return real;
    // No usage chunk (truncated stream, or a compat model version that ignored include_usage) →
    // estimate from the request + the accumulated output text; flag it (§3.6, 07 §6).
    return {
      input_tokens: estimateInputTokens(requestBody, model),
      output_tokens: estimateTokensFromChars(this.outputChars, model),
      cached_read_tokens: 0,
      cache_write_5m_tokens: 0,
      cache_write_1h_tokens: 0,
      cache_type: null,
      reasoning_tokens: 0,
      usage_estimated: true,
    };
  }
}

/**
 * Params forwarded verbatim (OpenAI compat surface). Anything NOT here and not explicitly handled
 * below is stripped + recorded in `dropped` (strip-and-record, 06 §0.2). NOTE vs openai.ts:
 * `reasoning_effort` is intentionally ABSENT → always dropped, because Gemini's thinking depth
 * (`thinking_budget`) is a native param the compat endpoint can't set, and the effort↔budget mapping
 * is lossy (§3.3, §3.7 — Appendix D §3). `metadata` is likewise absent → always stripped.
 */
const PASSTHROUGH = new Set([
  'tools',
  'tool_choice',
  'response_format',
  'seed',
  'logprobs',
  'top_logprobs',
  'n',
  'stop',
  'user',
  'parallel_tool_calls',
  'logit_bias',
]);

/** Keys handled explicitly above the passthrough loop (don't re-emit / don't drop). */
const HANDLED = new Set([
  'model',
  'messages',
  'system',
  'stream',
  'stream_options', // handled explicitly: merged with include_usage injection
  'max_tokens',
  'max_completion_tokens',
  'temperature',
  'top_p',
  'presence_penalty',
  'frequency_penalty',
  'original_max_tokens', // injected by VALIDATE for reconcile; never forwarded
]);

/**
 * Lowercased haystack of every classifiable field in a Gemini compat error body. Gemini puts its
 * machine label in `error.status` (e.g. "RESOURCE_EXHAUSTED", "INVALID_ARGUMENT") and `error.code`
 * is usually the NUMERIC http status — so unlike openai.ts (which keys off a string `error.code`),
 * we scan status + message + a string code together and classify by substring.
 */
function errorSignal(rawBody: unknown): string {
  const err =
    rawBody && typeof (rawBody as { error?: unknown }).error === 'object'
      ? ((rawBody as { error: Record<string, unknown> }).error ?? {})
      : {};
  const parts: string[] = [];
  if (typeof err.status === 'string') parts.push(err.status);
  if (typeof err.code === 'string') parts.push(err.code);
  if (typeof err.message === 'string') parts.push(err.message);
  if (typeof err.type === 'string') parts.push(err.type);
  return parts.join(' ').toLowerCase();
}

const looksLikeContextWindow = (s: string): boolean =>
  s.includes('context_length') ||
  s.includes('context length') ||
  s.includes('token count') ||
  s.includes('maximum context') ||
  (s.includes('exceed') && s.includes('token')) ||
  (s.includes('input') && s.includes('too long'));

const looksLikeContentPolicy = (s: string): boolean =>
  s.includes('content_policy') ||
  s.includes('content_filter') ||
  s.includes('safety') ||
  s.includes('prohibited_content');

export const geminiAdapter: Adapter = {
  provider: 'gemini',

  transform(body, candidate: Candidate, decryptedKey, opts): TransformResult {
    const src = body as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    const dropped: string[] = [];

    // Concrete, post-route model; any client-sent model is ignored. Strip a `models/` prefix — the
    // compat endpoint wants the bare id (e.g. `gemini-2.5-flash`), not `models/gemini-2.5-flash` (§3.3).
    out.model = candidate.model.replace(/^models\//, '');

    // some clients send a bare top-level `system`; normalize to a leading system message
    const msgs = Array.isArray(src.messages) ? [...(src.messages as unknown[])] : [];
    if (typeof src.system === 'string') msgs.unshift({ role: 'system', content: src.system });
    else if ('system' in src) dropped.push('system'); // non-string system can't be forwarded
    out.messages = msgs;

    // max_completion_tokens is Responses-API naming; chat-completions wants max_tokens.
    // If both are present, max_tokens wins (the rename is normalization, NOT a dropped param).
    if ('max_tokens' in src) out.max_tokens = src.max_tokens;
    else if ('max_completion_tokens' in src) out.max_tokens = src.max_completion_tokens;

    // Use Number.isFinite, not `typeof === 'number'`: the latter passes NaN/Infinity, which
    // JSON.stringify turns into `null` → upstream 400. Non-finite/out-of-range → drop+record.
    // Gemini accepts temperature 0–2 via compat (§3.3), same window as OpenAI.
    if ('temperature' in src) {
      const t = src.temperature;
      if (typeof t === 'number' && Number.isFinite(t) && t >= 0 && t <= 2) out.temperature = t;
      else dropped.push('temperature');
    }
    if ('top_p' in src) {
      const v = src.top_p;
      if (typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 1) out.top_p = v;
      else dropped.push('top_p');
    }
    for (const p of ['presence_penalty', 'frequency_penalty'] as const) {
      if (p in src) {
        const v = src[p];
        if (typeof v === 'number' && Number.isFinite(v)) out[p] = v;
        else dropped.push(p);
      }
    }

    for (const k of Object.keys(src)) {
      if (HANDLED.has(k)) continue;
      if (PASSTHROUGH.has(k)) out[k] = src[k];
      else dropped.push(k); // includes reasoning_effort (§3.7) + metadata + any unknown key
    }

    // Honor the client's streaming intent. When capturing usage (opts.injectUsage), MERGE
    // include_usage into any client-supplied stream_options so the terminal usage chunk is emitted —
    // Gemini compat supports include_usage (§3.3). The ONE gateway body mutation (ADR-008); never
    // recorded in `dropped`. On a non-stream request neither is set.
    const isStream = src.stream === true;
    out.stream = isStream;
    if (isStream) {
      if (opts.injectUsage) {
        const clientSo =
          src.stream_options && typeof src.stream_options === 'object'
            ? (src.stream_options as Record<string, unknown>)
            : {};
        out.stream_options = { ...clientSo, include_usage: true };
      } else if (src.stream_options && typeof src.stream_options === 'object') {
        out.stream_options = src.stream_options; // forward client's as-is (no injection)
      }
    } else if ('stream_options' in src) {
      // stream_options is illegal without stream:true on the OpenAI-shape surface → strip+record so
      // a non-stream request carrying it doesn't get a gateway-caused upstream 400 (parity, ADR-034).
      dropped.push('stream_options');
    }

    return {
      url: UPSTREAM_URL,
      method: 'POST',
      headers: { Authorization: `Bearer ${decryptedKey}`, 'Content-Type': 'application/json' },
      body: out,
      dropped,
    };
  },

  parseBody(responseBody): ParsedUsage | null {
    // Shared mapper (clamp, NO cached-subtraction) — see mapGeminiUsage. Null on absent/all-zero.
    return mapGeminiUsage((responseBody as { usage?: RawGeminiUsage } | null)?.usage);
  },

  createStreamParser(): StreamParser {
    return new GeminiStreamParser();
  },

  /**
   * Status-driven error mapping. Base is the OpenAI table (§1.6) — the ADR-042.2 typed-chain model
   * that the executor keys off `errorClass`. Gemini compat returns OpenAI-shaped errors but with its
   * label in `error.status` (RESOURCE_EXHAUSTED / SERVICE_UNAVAILABLE / INVALID_ARGUMENT), so the 400
   * classification scans the full error signal (status + message), not just a string `error.code`.
   *
   * DEVIATION from the literal §3.8 table (which predates typed chains): a context-length 400 is
   * mapped to errorClass 'context_window' + retryable (advancing the context_window fallback variant),
   * and all 5xx are treated as retryable 'server' — matching the openai.ts reference so the executor's
   * typed-fallback + circuit-breaker health behave uniformly across providers, rather than dead-ending
   * a recoverable Gemini condition. (See returned assumptions.)
   */
  mapError(httpStatus, body): MappedError {
    const rawBody = body && typeof body === 'object' ? body : null;
    const base = { rawBody, retryAfterMs: null as number | null, httpStatus };
    const signal = errorSignal(rawBody);
    switch (httpStatus) {
      case 429:
        return {
          ...base,
          spillwayCode: 'provider_rate_limited',
          isRetryable: true,
          isClientError: false,
          errorClass: 'rate_limit',
        };
      case 400: {
        const errorClass = looksLikeContextWindow(signal)
          ? 'context_window'
          : looksLikeContentPolicy(signal)
            ? 'content_policy'
            : 'client';
        return {
          ...base,
          spillwayCode: errorClass === 'context_window' ? 'request_too_large' : 'invalid_request',
          isRetryable: errorClass !== 'client', // typed-chain classes advance; a bare 400 does not
          isClientError: errorClass === 'client',
          errorClass,
        };
      }
      case 413:
        return {
          ...base,
          spillwayCode: 'request_too_large',
          isRetryable: true, // a smaller-context fallback can serve it (context_window chain)
          isClientError: false,
          errorClass: 'context_window',
        };
      case 401:
      case 403:
        return {
          ...base,
          spillwayCode: 'provider_auth_error',
          isRetryable: false,
          isClientError: false,
          errorClass: 'auth',
        };
      case 404:
        // 404 is a 4xx — excluded from circuit-breaker health (§6.6). errorClass 'client' so a missing
        // model isn't scored as a provider outage (parity with openai.ts, red-team B5-6).
        return {
          ...base,
          spillwayCode: 'model_not_found',
          isRetryable: false,
          isClientError: false,
          errorClass: 'client',
        };
      default:
        // Unrecognized 4xx (e.g. 422): surface immediately as a client error instead of falling into
        // the 5xx arm, which would mislabel it a provider failure, advance the chain, and end in a
        // bogus 502 all_providers_failed. 4xx is excluded from circuit-breaker health (§6.6).
        if (httpStatus >= 400 && httpStatus < 500) {
          return {
            ...base,
            spillwayCode: 'invalid_request',
            isRetryable: false,
            isClientError: true,
            errorClass: 'client',
          };
        }
        // 5xx (500/502/503/504) — provider unhealthy; advance the chain + count for health.
        return {
          ...base,
          spillwayCode: httpStatus >= 500 ? 'provider_unavailable' : 'provider_error',
          isRetryable: httpStatus >= 500,
          isClientError: false,
          errorClass: httpStatus >= 500 ? 'server' : null,
        };
    }
  },

  capabilitiesFor: geminiCapabilitiesFor,
  supports: makeSupports(geminiCapabilitiesFor),
};
