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

const UPSTREAM_URL = 'https://api.openai.com/v1/chat/completions';
const EMBEDDINGS_UPSTREAM_URL = 'https://api.openai.com/v1/embeddings';
// The embeddings surface is tiny: input + shaping params. Everything else (chat params a confused
// client might send) is strip-and-record — OpenAI 400s on unknown embeddings params.
const EMBEDDINGS_PASSTHROUGH = new Set(['input', 'encoding_format', 'dimensions', 'user']);

/**
 * OpenAI declared-capability catalog (Part III adapter-contract §5.2). Keyed by model-id PREFIX
 * (lookupCapabilities does exact → longest-prefix → conservative chat default), so dated snapshots
 * (`gpt-4o-2024-08-06`) inherit the base family. Re-verify at build time — reflects ~mid-2026 OpenAI.
 */
const V = { inputModalities: ['text', 'image'] as const };
export const OPENAI_CATALOG: Record<string, Capabilities> = {
  // GPT-4o / 4.1 family: multimodal chat, structured output, tools, streaming (no reasoning_effort).
  'gpt-4o': chatCaps(
    [
      'tools',
      'tool_choice_required',
      'parallel_tool_calls',
      'structured_output',
      'json_mode',
      'vision',
      'prompt_caching',
      'streaming',
      'logprobs',
    ],
    { inputModalities: [...V.inputModalities], maxContextTokens: 128_000, maxOutputTokens: 16_384 },
  ),
  'gpt-4.1': chatCaps(
    [
      'tools',
      'tool_choice_required',
      'parallel_tool_calls',
      'structured_output',
      'json_mode',
      'vision',
      'prompt_caching',
      'streaming',
      'logprobs',
    ],
    {
      inputModalities: [...V.inputModalities],
      maxContextTokens: 1_000_000,
      maxOutputTokens: 32_768,
    },
  ),
  'gpt-4-turbo': chatCaps(
    [
      'tools',
      'parallel_tool_calls',
      'structured_output',
      'json_mode',
      'vision',
      'streaming',
      'logprobs',
    ],
    { inputModalities: [...V.inputModalities], maxContextTokens: 128_000 },
  ),
  // o-series reasoning models: reasoning_effort, structured output, tools, vision; NO logprobs.
  o1: chatCaps(
    [
      'tools',
      'structured_output',
      'json_mode',
      'vision',
      'reasoning_effort',
      'prompt_caching',
      'streaming',
    ],
    {
      inputModalities: [...V.inputModalities],
      maxContextTokens: 200_000,
      maxOutputTokens: 100_000,
    },
  ),
  o3: chatCaps(
    [
      'tools',
      'structured_output',
      'json_mode',
      'vision',
      'reasoning_effort',
      'prompt_caching',
      'streaming',
    ],
    { inputModalities: [...V.inputModalities], maxContextTokens: 200_000 },
  ),
  'o4-mini': chatCaps(
    [
      'tools',
      'structured_output',
      'json_mode',
      'vision',
      'reasoning_effort',
      'prompt_caching',
      'streaming',
    ],
    { inputModalities: [...V.inputModalities], maxContextTokens: 200_000 },
  ),
  // Embeddings models: the embeddings TASK only — NO chat/tools/vision/streaming (a chat request here
  // is a genuine unsupported_feature, the catalog's whole point).
  'text-embedding-3': {
    tasks: ['embeddings'],
    inputModalities: ['text'],
    outputModalities: [],
    features: new Set(['embeddings']),
  },
};

function openaiCapabilitiesFor(model: string): Capabilities {
  return lookupCapabilities(OPENAI_CATALOG, model);
}

interface RawOpenAiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number; audio_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number; audio_tokens?: number };
}

/** Floor at 0, cap below int32 max — a hostile/buggy usage value must not overflow the
 *  integer requests columns and abort the whole reconcile tx (ADR-032 H3/M1). */
const clampTok = (n: number | undefined): number =>
  Math.max(0, Math.min(Math.trunc(n ?? 0), 2_000_000_000));

/**
 * OpenAI usage → canonical ParsedUsage. SHARED by parseBody (non-stream) and the stream
 * parser so the two cost paths cannot drift. Returns null on absent/all-zero usage (the
 * caller then estimates). CRITICAL: prompt_tokens INCLUDES cached_tokens — subtract it here
 * or cached tokens get double-billed at the full input rate (bible §1.5 snippet is wrong).
 */
function mapOpenAiUsage(u: RawOpenAiUsage | null | undefined): ParsedUsage | null {
  if (!u) return null;
  const prompt = clampTok(u.prompt_tokens);
  const completion = clampTok(u.completion_tokens);
  if (prompt + completion === 0) return null; // floored → sign-cancel can't fake a zero
  const cachedRead = Math.min(clampTok(u.prompt_tokens_details?.cached_tokens), prompt);
  // Part III (part-3/04) audio decomposition: OpenAI reports audio tokens INSIDE prompt/completion (like
  // cached_tokens). Split them onto their own lines so the full-rate text line excludes them — otherwise
  // audio tokens would bill at BOTH the text rate (in prompt/completion) and the audio rate → double-bill.
  const audioIn = Math.min(clampTok(u.prompt_tokens_details?.audio_tokens), prompt - cachedRead);
  const audioOut = Math.min(clampTok(u.completion_tokens_details?.audio_tokens), completion);
  return {
    input_tokens: Math.max(0, prompt - cachedRead - audioIn),
    output_tokens: Math.max(0, completion - audioOut),
    cached_read_tokens: cachedRead,
    cache_write_5m_tokens: 0, // OpenAI does not expose cache-write tokens
    cache_write_1h_tokens: 0,
    cache_type: null,
    reasoning_tokens: clampTok(u.completion_tokens_details?.reasoning_tokens), // inside output_tokens
    audio_input_tokens: audioIn, // 0 for text-only → no audio cost line
    audio_output_tokens: audioOut,
    usage_estimated: false,
  };
}

/**
 * Streaming usage extractor for OpenAI SSE (05 §7). processEvent accumulates assistant text
 * (for the estimator fallback) and captures the terminal usage-only chunk (empty choices +
 * usage). getUsage returns REAL usage (same mapping as parseBody) when that chunk arrived,
 * else an ESTIMATE — never null, so a stream always meters a row.
 */
class OpenAiStreamParser implements StreamParser {
  private capturedUsage: RawOpenAiUsage | null = null;
  private outputChars = 0; // running count only (NOT the full text) → bounded memory on long streams

  processEvent(event: SseEvent): void {
    if (event.data === '[DONE]') return;
    let chunk: { choices?: unknown; usage?: RawOpenAiUsage };
    try {
      chunk = JSON.parse(event.data) as typeof chunk;
    } catch {
      return; // recoverable: a malformed SSE line is skipped, not fatal
    }
    const choices = chunk.choices;
    if (Array.isArray(choices)) {
      for (const c of choices) {
        // Count content AND tool-call args/names AND refusal text — a tool-only or reasoning
        // stream that truncates before the usage chunk would otherwise estimate ~0 output and
        // under-bill (budget bypass on agentic traffic — red-team ADR-034).
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
      if (choices.length === 0 && mapOpenAiUsage(chunk.usage))
        this.capturedUsage = chunk.usage ?? null;
    } else if (mapOpenAiUsage(chunk.usage)) {
      this.capturedUsage = chunk.usage ?? null; // defensive: usage without a choices array
    }
  }

  getUsage(requestBody: unknown, model: string): ParsedUsage {
    const real = mapOpenAiUsage(this.capturedUsage);
    if (real) return real;
    // No usage chunk (truncated stream, or a compat provider that ignored include_usage) →
    // estimate from the request + the accumulated output text; flag it (07 §6).
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
 * Params forwarded to OpenAI verbatim. Anything NOT here and not explicitly handled
 * below is stripped + recorded in `dropped` (strip-and-record, 06 §0.2) — so a forward
 * never 400s on an unknown field. `metadata` is intentionally absent → always stripped.
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
  'reasoning_effort',
  'logit_bias',
]);

/** Keys handled explicitly above the passthrough loop (don't re-emit / don't drop). */
const HANDLED = new Set([
  'model',
  'messages',
  'system',
  'stream',
  'stream_options', // handled explicitly (Phase C): merged with include_usage injection
  'max_tokens',
  'max_completion_tokens',
  'temperature',
  'top_p',
  'presence_penalty',
  'frequency_penalty',
  'original_max_tokens', // injected by VALIDATE for reconcile; never forwarded
]);

export const openaiAdapter: Adapter = {
  provider: 'openai',

  transform(body, candidate: Candidate, decryptedKey, opts): TransformResult {
    const src = body as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    const dropped: string[] = [];

    out.model = candidate.model; // concrete, post-route model; any client-sent model is ignored

    // some clients send a bare top-level `system`; normalize to a leading system message
    const msgs = Array.isArray(src.messages) ? [...(src.messages as unknown[])] : [];
    if (typeof src.system === 'string') msgs.unshift({ role: 'system', content: src.system });
    else if ('system' in src) dropped.push('system'); // non-string system can't be forwarded
    out.messages = msgs;

    // max_completion_tokens is Responses-API naming; chat-completions wants max_tokens.
    // If both are present, max_tokens wins (the rename is normalization, NOT a dropped param).
    if ('max_tokens' in src) out.max_tokens = src.max_tokens;
    else if ('max_completion_tokens' in src) out.max_tokens = src.max_completion_tokens;

    // Use Number.isFinite, not `typeof === 'number'`: the latter passes NaN/Infinity,
    // which JSON.stringify turns into `null` → OpenAI 400. Non-finite/out-of-range → drop+record.
    if ('temperature' in src) {
      const t = src.temperature;
      if (typeof t === 'number' && Number.isFinite(t) && t >= 0 && t <= 2) out.temperature = t;
      else dropped.push('temperature'); // OpenAI range is 0–2
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
      else dropped.push(k);
    }

    // Phase C: honor the client's streaming intent (was force-false in Phase B). When we're
    // capturing usage (opts.injectUsage), MERGE include_usage into any client-supplied
    // stream_options so the terminal usage chunk is emitted — the ONE gateway body mutation
    // (ADR-008), never recorded in `dropped`. On a non-stream request neither is set.
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
      // stream_options is ILLEGAL without stream:true → OpenAI 400s. Strip+record so a
      // non-stream request that carried it doesn't get a gateway-caused 400 (ADR-034 M13).
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

  transformEmbeddings(body, candidate: Candidate, decryptedKey): TransformResult {
    const src = body as Record<string, unknown>;
    const out: Record<string, unknown> = { model: candidate.model }; // post-route model wins
    const dropped: string[] = [];
    for (const k of Object.keys(src)) {
      if (k === 'model' || k === 'original_max_tokens') continue;
      if (EMBEDDINGS_PASSTHROUGH.has(k)) out[k] = src[k];
      else dropped.push(k); // strip-and-record, same contract as chat (06 §0.2)
    }
    return {
      url: EMBEDDINGS_UPSTREAM_URL,
      method: 'POST',
      headers: { Authorization: `Bearer ${decryptedKey}`, 'Content-Type': 'application/json' },
      body: out,
      dropped,
    };
  },

  parseBody(responseBody): ParsedUsage | null {
    // Shared mapper (clamp + cached-subtraction) — see mapOpenAiUsage. Null on absent/all-zero.
    return mapOpenAiUsage((responseBody as { usage?: RawOpenAiUsage } | null)?.usage);
  },

  // Streaming usage extractor (Phase C). The tee feeds it each SSE event, then calls getUsage
  // at stream end. Stateless construction — model/requestBody flow through getUsage.
  createStreamParser(): StreamParser {
    return new OpenAiStreamParser();
  },

  // Status-driven (Bifrost pattern): retryability/isClientError decided from the HTTP
  // status alone; the body is advisory (message only) and may be null/HTML — never
  // forward raw upstream HTML to the client.
  mapError(httpStatus, body): MappedError {
    const rawBody = body && typeof body === 'object' ? body : null;
    const base = { rawBody, retryAfterMs: null as number | null, httpStatus };
    // OpenAI puts the machine code in error.code (e.g. context_length_exceeded, content_policy_violation).
    const errObj =
      rawBody && typeof (rawBody as { error?: unknown }).error === 'object'
        ? ((rawBody as { error: Record<string, unknown> }).error ?? {})
        : {};
    const code = typeof errObj.code === 'string' ? errObj.code : '';
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
        // 15 §7.1: a context-length 400 advances the context_window typed chain; a content-policy
        // 400 advances content_policy. Both are still client errors (not blindly retried), but the
        // executor's typed-chain switch keys off errorClass. Any other 400 surfaces immediately.
        const errorClass =
          code === 'context_length_exceeded'
            ? 'context_window'
            : code.includes('content_policy') || code.includes('content_filter')
              ? 'content_policy'
              : 'client';
        return {
          ...base,
          spillwayCode: 'invalid_request',
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
        // 404 is a 4xx — excluded from circuit-breaker health (§6.6). errorClass 'client' so
        // healthKindFor returns null (a missing model is not a provider outage; red-team B5-6).
        return {
          ...base,
          spillwayCode: 'model_not_found',
          isRetryable: false,
          isClientError: false,
          errorClass: 'client',
        };
      default:
        // Unrecognized 4xx (e.g. 422 unprocessable) — surface the upstream status immediately as a
        // client error instead of falling through to the 5xx arm, which would mislabel it a provider
        // failure, advance the fallback chain, and end in a bogus 502 all_providers_failed. 4xx is
        // excluded from circuit-breaker health (§6.6), so errorClass 'client' → healthKindFor null.
        if (httpStatus >= 400 && httpStatus < 500) {
          return {
            ...base,
            spillwayCode: 'invalid_request',
            isRetryable: false,
            isClientError: true,
            errorClass: 'client',
          };
        }
        // 5xx (500/502/503/504) — the provider is unhealthy; advance the chain + count for health.
        return {
          ...base,
          spillwayCode: httpStatus >= 500 ? 'provider_unavailable' : 'provider_error',
          isRetryable: httpStatus >= 500,
          isClientError: false,
          errorClass: httpStatus >= 500 ? 'server' : null,
        };
    }
  },

  capabilitiesFor: openaiCapabilitiesFor,
  supports: makeSupports(openaiCapabilitiesFor),
};
