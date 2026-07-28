import type { Candidate, ProviderName } from '../routing/compile.js';
import type { SseEvent, TransformResult } from './types.js';
import { ANTHROPIC_UPSTREAM_URL, ANTHROPIC_VERSION } from './anthropic.js';

/**
 * Cross-format translation layer (06-providers §2.3/§2.4b). Spillway speaks TWO client wire
 * shapes — OpenAI chat-completions (`/v1/chat/completions`) and Anthropic Messages
 * (`/v1/messages`) — and dispatches to FOUR providers whose upstream wire shape is one of the
 * same two (`anthropic` → Anthropic shape; `openai`/`gemini`/`openai_compat` → OpenAI shape via
 * the compat surface). Whenever the client shape and the served provider's shape differ, the
 * RESPONSE (and, for `/v1/messages`, the inbound REQUEST) must be translated.
 *
 * Design (why this file, not the adapters): the adapters are OpenAI-input-only by contract
 * (their `transform` assumes an OpenAI-canonical body). So the canonical INTERNAL body threaded
 * through the pipeline (validate → route → budget → dispatch) is always OpenAI-shaped, and an
 * Anthropic `/v1/messages` body is normalized to that canonical shape at the route edge via
 * `anthropicRequestToOpenAI`. The one exception is the true pass-through case (Anthropic client
 * → Anthropic upstream): DISPATCH sends the ORIGINAL native body via `anthropicPassthroughTransform`
 * so no request fidelity is lost on the most common Messages path.
 *
 * Translation matrix (clientShape × providerShape):
 *   openai   × openai    → passthrough
 *   openai   × anthropic → anthropicResponseToOpenAI (non-stream) / anthropic→openai SSE (stream)
 *   anthropic× anthropic → passthrough (native, no round-trip)
 *   anthropic× openai    → openaiResponseToAnthropic (non-stream) / openai→anthropic SSE (stream)
 */

export type WireShape = 'openai' | 'anthropic';

/** A provider's UPSTREAM wire shape. anthropic speaks Messages; the rest speak OpenAI (compat). */
export function providerWireShape(provider: ProviderName): WireShape {
  return provider === 'anthropic' ? 'anthropic' : 'openai';
}

const DEFAULT_MAX_TOKENS = 4096;

// ── stop_reason ⇄ finish_reason (06 §2.3) ───────────────────────────────────
const STOP_TO_FINISH: Record<string, string> = {
  end_turn: 'stop',
  max_tokens: 'length',
  tool_use: 'tool_calls',
  stop_sequence: 'stop',
  pause_turn: 'stop',
  // A Claude safety refusal is a content-filter event, NOT a clean stop — surfacing it as 'stop'
  // launders the refusal so the client's safety/retry logic can't see it (red-team round4 F4).
  refusal: 'content_filter',
};
const FINISH_TO_STOP: Record<string, string> = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  // A provider content-filter maps to Anthropic's 'refusal' stop_reason (a real Messages-API value),
  // not 'end_turn' — otherwise the filtered/truncated response looks like a normal completion to an
  // Anthropic-shape client and the filter signal is lost (red-team round4 F5).
  content_filter: 'refusal',
};

function asObj(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

// ════════════════════════════════════════════════════════════════════════════
// REQUEST: Anthropic Messages body → OpenAI chat-completions body
// ════════════════════════════════════════════════════════════════════════════

interface AnthContentBlock {
  type?: unknown;
  text?: unknown;
  source?: { type?: unknown; media_type?: unknown; data?: unknown; url?: unknown };
  id?: unknown;
  name?: unknown;
  input?: unknown;
  tool_use_id?: unknown;
  content?: unknown;
}

/** Anthropic image `source` → OpenAI `image_url.url` (base64 source → data: URI; url → url). */
function anthImageToUrl(source: AnthContentBlock['source']): string | null {
  if (!source) return null;
  if (
    source.type === 'base64' &&
    typeof source.media_type === 'string' &&
    typeof source.data === 'string'
  )
    return `data:${source.media_type};base64,${source.data}`;
  if (source.type === 'url' && typeof source.url === 'string') return source.url;
  return null;
}

/** Stringify an Anthropic tool_result `content` (string | block[] | object) → an OpenAI tool
 *  message string. Concatenate text blocks; JSON.stringify anything structured. */
function toolResultToString(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const b of content) {
      const bl = b as AnthContentBlock;
      if (bl.type === 'text' && typeof bl.text === 'string') parts.push(bl.text);
      else parts.push(JSON.stringify(b));
    }
    return parts.join('');
  }
  return JSON.stringify(content ?? '');
}

/** Extract a top-level Anthropic `system` (string | text-block[]) → a single system string. */
function systemToString(system: unknown): string | null {
  if (typeof system === 'string') return system.length > 0 ? system : null;
  if (Array.isArray(system)) {
    const parts: string[] = [];
    for (const b of system) {
      const bl = b as AnthContentBlock;
      if (bl.type === 'text' && typeof bl.text === 'string') parts.push(bl.text);
    }
    return parts.length > 0 ? parts.join('\n\n') : null;
  }
  return null;
}

/** Map an array of Anthropic content blocks in ONE message into OpenAI shapes. Text/image become
 *  content parts; tool_use blocks become assistant tool_calls; tool_result blocks become SEPARATE
 *  OpenAI `tool` messages (returned via `toolMessages`). */
function mapAnthContent(blocks: unknown[]): {
  parts: unknown[];
  toolCalls: unknown[];
  toolMessages: unknown[];
} {
  const parts: unknown[] = [];
  const toolCalls: unknown[] = [];
  const toolMessages: unknown[] = [];
  for (const raw of blocks) {
    const b = raw as AnthContentBlock;
    if (b.type === 'text' && typeof b.text === 'string') {
      parts.push({ type: 'text', text: b.text });
    } else if (b.type === 'image') {
      const url = anthImageToUrl(b.source);
      if (url) parts.push({ type: 'image_url', image_url: { url } });
    } else if (
      b.type === 'thinking' &&
      typeof (b as { thinking?: unknown }).thinking === 'string'
    ) {
      // Preserve extended-thinking text as a text part so its token weight still counts toward the
      // max_input_tokens cap / TPM cost / budget reservation (M2 red-team: dropping it undercounted
      // enforcement while the native pass-through still sent the full body upstream).
      parts.push({ type: 'text', text: (b as { thinking: string }).thinking });
    } else if (
      b.type === 'redacted_thinking' &&
      typeof (b as { data?: unknown }).data === 'string'
    ) {
      parts.push({ type: 'text', text: (b as { data: string }).data });
    } else if (b.type === 'tool_use') {
      toolCalls.push({
        id: b.id,
        type: 'function',
        function: {
          name: b.name,
          arguments: JSON.stringify(b.input ?? {}),
        },
      });
    } else if (b.type === 'tool_result') {
      toolMessages.push({
        role: 'tool',
        tool_call_id: b.tool_use_id,
        content: toolResultToString(b.content),
      });
    }
  }
  return { parts, toolCalls, toolMessages };
}

/** Anthropic `tools` ({name,description,input_schema}) → OpenAI ({type:'function',function:{…}}). */
function mapAnthTools(tools: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const raw of tools) {
    const t = asObj(raw);
    if (!t || typeof t.name !== 'string') continue;
    const fn: Record<string, unknown> = {
      name: t.name,
      parameters: t.input_schema ?? { type: 'object', properties: {} },
    };
    if (typeof t.description === 'string') fn.description = t.description;
    out.push({ type: 'function', function: fn });
  }
  return out;
}

/** Anthropic tool_choice → OpenAI tool_choice. */
function mapAnthToolChoice(tc: unknown): unknown {
  const o = asObj(tc);
  if (!o) return undefined;
  if (o.type === 'auto') return 'auto';
  if (o.type === 'any') return 'required';
  if (o.type === 'none') return 'none'; // "do not call tools" must survive translation (M2 red-team)
  if (o.type === 'tool' && typeof o.name === 'string')
    return { type: 'function', function: { name: o.name } };
  return undefined;
}

/**
 * Anthropic Messages request → OpenAI chat-completions canonical body (06 §2.2a inverse). Used to
 * normalize a `/v1/messages` body so the OpenAI-shaped pipeline (validate/route/budget/estimate) and
 * the OpenAI-input adapters can process it uniformly. `cache_control` is dropped here (Anthropic-only);
 * `thinking`/`redacted_thinking` are preserved as text so their token weight still counts for
 * enforcement. The native pass-through path is fully lossless for Anthropic→Anthropic.
 */
export function anthropicRequestToOpenAI(body: unknown): Record<string, unknown> {
  const src = asObj(body) ?? {};
  const out: Record<string, unknown> = {};
  out.model = typeof src.model === 'string' ? src.model : '';

  const messages: unknown[] = [];
  const sys = systemToString(src.system);
  if (sys !== null) messages.push({ role: 'system', content: sys });

  const srcMsgs = Array.isArray(src.messages) ? src.messages : [];
  for (const raw of srcMsgs) {
    const m = asObj(raw);
    if (!m) continue;
    const role = typeof m.role === 'string' ? m.role : 'user';
    if (typeof m.content === 'string') {
      messages.push({ role, content: m.content });
      continue;
    }
    if (!Array.isArray(m.content)) {
      messages.push({ role, content: m.content });
      continue;
    }
    const { parts, toolCalls, toolMessages } = mapAnthContent(m.content);
    // tool_result blocks (only valid on a user turn) become standalone OpenAI tool messages.
    if (toolMessages.length > 0 && parts.length === 0 && toolCalls.length === 0) {
      messages.push(...toolMessages);
      continue;
    }
    const textParts = parts.filter((p) => (p as { type?: string }).type === 'text');
    const onlyText = textParts.length === parts.length;
    const content =
      parts.length === 0
        ? null
        : onlyText
          ? textParts.map((p) => (p as { text: string }).text).join('')
          : parts;
    // tool_result blocks answer the PRIOR assistant turn, so their OpenAI 'tool' messages must come
    // BEFORE any new user text/parts in this same turn — else OpenAI/compat upstreams 400 on ordering.
    if (toolMessages.length > 0) messages.push(...toolMessages);
    if (role === 'assistant' && toolCalls.length > 0) {
      messages.push({ role, content, tool_calls: toolCalls });
    } else {
      messages.push({ role, content });
    }
  }
  out.messages = messages;

  if (typeof src.max_tokens === 'number') out.max_tokens = src.max_tokens;
  if (typeof src.temperature === 'number') out.temperature = src.temperature;
  if (typeof src.top_p === 'number') out.top_p = src.top_p;
  if (typeof src.top_k === 'number') out.top_k = src.top_k; // carried for a potential Anthropic re-transform
  if (typeof src.stream === 'boolean') out.stream = src.stream;
  if (Array.isArray(src.stop_sequences)) out.stop = src.stop_sequences;
  if (Array.isArray(src.tools)) out.tools = mapAnthTools(src.tools);
  if (src.tool_choice !== undefined) {
    const tc = mapAnthToolChoice(src.tool_choice);
    if (tc !== undefined) out.tool_choice = tc;
  }
  // Preserve ALL string-valued metadata keys onto the canonical body — NOT just user_id. This body is
  // what guardrails (deny/require_approval) and routing rules match on (structuredMatch req.metadata[k]
  // === v). The OpenAI endpoint types metadata as record(string,string) so those policies enforce; if we
  // keep only user_id here, a metadata-scoped enforcing deny/require_approval (or routing rule) that
  // blocks on /v1/chat/completions is silently BYPASSED by sending the identical request to /v1/messages
  // (red-team audit F1). Mirror the OpenAI string-equality contract: drop non-string values (they can't
  // match a string filter anyway — evasion-closed-at-boundary). The native body is what DISPATCH sends to
  // Anthropic upstream, so this internal canonical metadata never alters the upstream call.
  const md = asObj(src.metadata);
  if (md) {
    const meta: Record<string, string> = {};
    for (const [k, v] of Object.entries(md)) {
      if (typeof v === 'string') meta[k] = v;
    }
    if (Object.keys(meta).length > 0) out.metadata = meta;
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════════════
// REQUEST: native Anthropic pass-through transform (Anthropic client → Anthropic upstream)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Build the upstream request for a native Anthropic Messages body (06 §2.2b) — pass-through with
 * only a model rewrite, stream normalization, and a max_tokens floor. This is the ZERO-fidelity-loss
 * path: `cache_control`, `thinking`, native `system` blocks, and `metadata` all forward unchanged.
 * Used ONLY when clientShape === 'anthropic' AND the served candidate is an Anthropic provider.
 */
export function anthropicPassthroughTransform(
  nativeBody: unknown,
  candidate: Candidate,
  decryptedKey: string,
  stream: boolean,
): TransformResult {
  const src = asObj(nativeBody) ?? {};
  const out: Record<string, unknown> = { ...src, model: candidate.model, stream };
  if (typeof out.max_tokens !== 'number' || !(out.max_tokens > 0))
    out.max_tokens = DEFAULT_MAX_TOKENS;
  return {
    url: ANTHROPIC_UPSTREAM_URL,
    method: 'POST',
    headers: {
      'x-api-key': decryptedKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'Content-Type': 'application/json',
    },
    body: out,
    dropped: [],
  };
}

// ════════════════════════════════════════════════════════════════════════════
// RESPONSE (non-streaming)
// ════════════════════════════════════════════════════════════════════════════

interface AnthUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Total cache-write tokens from either the explicit split object or the legacy scalar. */
function cacheWriteTotal(u: AnthUsage): number {
  const cc = u.cache_creation;
  if (
    cc &&
    (cc.ephemeral_5m_input_tokens !== undefined || cc.ephemeral_1h_input_tokens !== undefined)
  )
    return num(cc.ephemeral_5m_input_tokens) + num(cc.ephemeral_1h_input_tokens);
  return num(u.cache_creation_input_tokens);
}

/** Anthropic usage → OpenAI-shaped usage. `prompt_tokens` = TOTAL input (OpenAI semantics: cache
 *  read + cache write + raw input); `prompt_tokens_details.cached_tokens` = cache_read only. This is
 *  a DISPLAY value for the client — reconcile bills from the adapter's ParsedUsage, not this. */
function anthUsageToOpenAI(u: AnthUsage): Record<string, unknown> {
  const cacheRead = num(u.cache_read_input_tokens);
  const promptTokens = num(u.input_tokens) + cacheRead + cacheWriteTotal(u);
  const completion = num(u.output_tokens);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completion,
    total_tokens: promptTokens + completion,
    prompt_tokens_details: { cached_tokens: cacheRead },
    completion_tokens_details: { reasoning_tokens: 0 },
  };
}

function ensureChatcmplId(id: unknown): string {
  const s = typeof id === 'string' ? id : `msg_${Date.now()}`;
  return s.startsWith('chatcmpl-') ? s : `chatcmpl-${s}`;
}

/**
 * Anthropic Messages response → OpenAI chat.completion (06 §2.3). Text blocks concatenate into
 * `message.content`; `tool_use` blocks map to `message.tool_calls`; `stop_reason` maps to
 * `finish_reason`. `created` is synthesized (Anthropic omits it).
 */
export function anthropicResponseToOpenAI(resp: unknown, model: string): Record<string, unknown> {
  const r = asObj(resp) ?? {};
  const blocks = Array.isArray(r.content) ? r.content : [];
  let text = '';
  const toolCalls: unknown[] = [];
  for (const raw of blocks) {
    const b = raw as AnthContentBlock;
    if (b.type === 'text' && typeof b.text === 'string') text += b.text;
    else if (b.type === 'tool_use')
      toolCalls.push({
        id: b.id,
        type: 'function',
        function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
      });
  }
  const stopReason = typeof r.stop_reason === 'string' ? r.stop_reason : 'end_turn';
  const message: Record<string, unknown> = {
    role: 'assistant',
    content: text.length > 0 || toolCalls.length === 0 ? text : null,
  };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  return {
    id: ensureChatcmplId(r.id),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: typeof r.model === 'string' ? r.model : model,
    choices: [{ index: 0, message, finish_reason: STOP_TO_FINISH[stopReason] ?? 'stop' }],
    usage: anthUsageToOpenAI((r.usage as AnthUsage) ?? {}),
  };
}

interface OpenAiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

/** OpenAI usage → Anthropic usage. `input_tokens` = full-rate portion (prompt − cached). */
function openaiUsageToAnth(u: OpenAiUsage): Record<string, unknown> {
  const prompt = num(u.prompt_tokens);
  const cached = Math.min(num(u.prompt_tokens_details?.cached_tokens), prompt);
  return {
    input_tokens: Math.max(0, prompt - cached),
    output_tokens: num(u.completion_tokens),
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: 0,
  };
}

/**
 * OpenAI chat.completion → Anthropic Messages response (inverse of §2.3). Used when a `/v1/messages`
 * (Anthropic-shaped) client is served by an OpenAI-shaped provider. `message.content` becomes a text
 * block; `tool_calls` become `tool_use` blocks; `finish_reason` maps to `stop_reason`.
 */
export function openaiResponseToAnthropic(resp: unknown, model: string): Record<string, unknown> {
  const r = asObj(resp) ?? {};
  const choices = Array.isArray(r.choices) ? r.choices : [];
  const choice = asObj(choices[0]) ?? {};
  const message = asObj(choice.message) ?? {};
  const content: unknown[] = [];
  if (typeof message.content === 'string' && message.content.length > 0)
    content.push({ type: 'text', text: message.content });
  if (Array.isArray(message.tool_calls)) {
    for (const raw of message.tool_calls) {
      const tc = asObj(raw);
      const fn = asObj(tc?.function);
      if (!fn) continue;
      let input: unknown = {};
      try {
        input = typeof fn.arguments === 'string' ? JSON.parse(fn.arguments) : (fn.arguments ?? {});
      } catch {
        input = {};
      }
      content.push({ type: 'tool_use', id: tc?.id, name: fn.name, input });
    }
  }
  const finish = typeof choice.finish_reason === 'string' ? choice.finish_reason : 'stop';
  const rawId = typeof r.id === 'string' ? r.id.replace(/^chatcmpl-/, 'msg_') : `msg_${Date.now()}`;
  return {
    id: rawId,
    type: 'message',
    role: 'assistant',
    model: typeof r.model === 'string' ? r.model : model,
    content,
    stop_reason: FINISH_TO_STOP[finish] ?? 'end_turn',
    stop_sequence: null,
    usage: openaiUsageToAnth((r.usage as OpenAiUsage) ?? {}),
  };
}

// ════════════════════════════════════════════════════════════════════════════
// RESPONSE (streaming) — SSE event translators
// ════════════════════════════════════════════════════════════════════════════

/** A stateful SSE translator. `translate` maps ONE upstream event to zero-or-more client SSE frames
 *  (each a full `data: …\n\n` string); `flush` emits any terminal frames after the upstream ends. */
export interface SseTranslator {
  translate(event: SseEvent): string[];
  flush(): string[];
}

const frame = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;
const doneFrame = 'data: [DONE]\n\n';

/**
 * Anthropic SSE → OpenAI SSE (06 §2.4b). Consumes Anthropic message/content_block events and emits
 * OpenAI chat.completion.chunk frames. Suppresses thinking/signature deltas and pings. Emits the
 * usage-only chunk (when the client asked for it) before `[DONE]`.
 */
export function makeAnthropicToOpenAiSseTranslator(
  model: string,
  wantsUsage: boolean,
): SseTranslator {
  let id = 'chatcmpl-stream';
  let outModel = model;
  let usage: AnthUsage = {};
  let doneEmitted = false;

  const chunk = (delta: unknown, finishReason: string | null): string =>
    frame({
      id,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: outModel,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    });

  return {
    translate(event: SseEvent): string[] {
      if (event.data === '[DONE]') return [];
      let ev: {
        type?: string;
        message?: { id?: unknown; model?: unknown; usage?: AnthUsage };
        index?: number;
        content_block?: { type?: string; id?: unknown; name?: unknown };
        delta?: { type?: string; text?: unknown; partial_json?: unknown; stop_reason?: unknown };
        usage?: AnthUsage;
        error?: unknown;
      };
      try {
        ev = JSON.parse(event.data) as typeof ev;
      } catch {
        return [];
      }
      switch (ev.type) {
        case 'message_start': {
          if (typeof ev.message?.id === 'string') id = ensureChatcmplId(ev.message.id);
          if (typeof ev.message?.model === 'string') outModel = ev.message.model;
          if (ev.message?.usage) usage = { ...usage, ...ev.message.usage };
          return [chunk({ role: 'assistant', content: '' }, null)];
        }
        case 'content_block_start': {
          const cb = ev.content_block;
          if (cb?.type === 'tool_use') {
            return [
              chunk(
                {
                  tool_calls: [
                    {
                      index: ev.index ?? 0,
                      id: cb.id,
                      type: 'function',
                      function: { name: cb.name, arguments: '' },
                    },
                  ],
                },
                null,
              ),
            ];
          }
          return [];
        }
        case 'content_block_delta': {
          const d = ev.delta;
          if (d?.type === 'text_delta' && typeof d.text === 'string')
            return [chunk({ content: d.text }, null)];
          if (d?.type === 'input_json_delta' && typeof d.partial_json === 'string')
            return [
              chunk(
                { tool_calls: [{ index: ev.index ?? 0, function: { arguments: d.partial_json } }] },
                null,
              ),
            ];
          return []; // thinking_delta / signature_delta suppressed
        }
        case 'message_delta': {
          if (ev.usage?.output_tokens !== undefined)
            usage = { ...usage, output_tokens: ev.usage.output_tokens };
          const stop =
            typeof ev.delta?.stop_reason === 'string' ? STOP_TO_FINISH[ev.delta.stop_reason] : null;
          return [chunk({}, stop ?? 'stop')];
        }
        case 'message_stop': {
          const frames: string[] = [];
          if (wantsUsage)
            frames.push(
              frame({
                id,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: outModel,
                choices: [],
                usage: anthUsageToOpenAI(usage),
              }),
            );
          frames.push(doneFrame);
          doneEmitted = true;
          return frames;
        }
        case 'error':
          return [frame({ error: { type: 'provider_error', message: 'upstream stream error' } })];
        default:
          return []; // ping / content_block_stop → no emit
      }
    },
    flush(): string[] {
      // The stream ended without a message_stop → still terminate the OpenAI stream cleanly.
      return doneEmitted ? [] : [doneFrame];
    },
  };
}

/**
 * OpenAI SSE → Anthropic SSE (inverse of §2.4b). Consumes OpenAI chat.completion.chunk frames and
 * synthesizes the Anthropic event lifecycle (message_start → content_block_start/delta/stop →
 * message_delta → message_stop). A single text content block is assumed; tool-call streaming is
 * surfaced as text-free content_block events keyed by tool_call index.
 */
export function makeOpenAiToAnthropicSseTranslator(model: string): SseTranslator {
  let started = false;
  let outputTokens = 0;
  let promptTokens = 0;
  let cachedTokens = 0;
  let finish: string | null = null;
  let msgId = `msg_${Date.now()}`;
  let nextIndex = 0; // next Anthropic content-block index to assign
  let textIndex: number | null = null; // the text block's index, once opened
  const toolIndex = new Map<number, number>(); // OpenAI tool_call.index → Anthropic block index

  const evt = (type: string, payload: Record<string, unknown>): string =>
    `event: ${type}\n${frame({ type, ...payload })}`;

  const openMessage = (): string[] => {
    started = true;
    return [
      evt('message_start', {
        message: {
          id: msgId,
          type: 'message',
          role: 'assistant',
          model,
          content: [],
          stop_reason: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }),
    ];
  };

  return {
    translate(event: SseEvent): string[] {
      if (event.data === '[DONE]') return [];
      let chunk: {
        id?: unknown;
        model?: unknown;
        choices?: Array<{
          delta?: {
            content?: unknown;
            tool_calls?: Array<{
              index?: unknown;
              id?: unknown;
              function?: { name?: unknown; arguments?: unknown };
            }>;
          };
          finish_reason?: unknown;
        }>;
        usage?: OpenAiUsage;
      };
      try {
        chunk = JSON.parse(event.data) as typeof chunk;
      } catch {
        return [];
      }
      const frames: string[] = [];
      if (!started) {
        if (typeof chunk.id === 'string') msgId = chunk.id.replace(/^chatcmpl-/, 'msg_');
        frames.push(...openMessage());
      }
      if (chunk.usage) {
        promptTokens = num(chunk.usage.prompt_tokens);
        cachedTokens = Math.min(
          num(chunk.usage.prompt_tokens_details?.cached_tokens),
          promptTokens,
        );
        outputTokens = num(chunk.usage.completion_tokens) || outputTokens;
      }
      const choice = chunk.choices?.[0];
      const text = choice?.delta?.content;
      if (typeof text === 'string' && text.length > 0) {
        if (textIndex === null) {
          textIndex = nextIndex++;
          frames.push(
            evt('content_block_start', {
              index: textIndex,
              content_block: { type: 'text', text: '' },
            }),
          );
        }
        frames.push(
          evt('content_block_delta', { index: textIndex, delta: { type: 'text_delta', text } }),
        );
      }
      // Tool-call streaming (M2 red-team CRITICAL): OpenAI streams tool calls as delta.tool_calls —
      // never as delta.content. Translate each (keyed by its OpenAI index) into an Anthropic tool_use
      // content block: a content_block_start on first sight, then input_json_delta frames carrying the
      // JSON-argument fragments. Without this an Anthropic client gets stop_reason:tool_use + no tool.
      const toolCalls = choice?.delta?.tool_calls;
      if (Array.isArray(toolCalls)) {
        for (const tc of toolCalls) {
          const oaIdx = num(tc.index);
          let anthIdx = toolIndex.get(oaIdx);
          if (anthIdx === undefined) {
            anthIdx = nextIndex++;
            toolIndex.set(oaIdx, anthIdx);
            frames.push(
              evt('content_block_start', {
                index: anthIdx,
                content_block: {
                  type: 'tool_use',
                  id: typeof tc.id === 'string' ? tc.id : `toolu_${msgId}_${oaIdx}`,
                  name: typeof tc.function?.name === 'string' ? tc.function.name : '',
                  input: {},
                },
              }),
            );
          }
          const args = tc.function?.arguments;
          if (typeof args === 'string' && args.length > 0)
            frames.push(
              evt('content_block_delta', {
                index: anthIdx,
                delta: { type: 'input_json_delta', partial_json: args },
              }),
            );
        }
      }
      if (typeof choice?.finish_reason === 'string') finish = choice.finish_reason;
      return frames;
    },
    flush(): string[] {
      const frames: string[] = [];
      if (!started) frames.push(...openMessage());
      // Close every open content block (text + each tool_use) in index order.
      const openIndices = textIndex === null ? [] : [textIndex];
      for (const idx of toolIndex.values()) openIndices.push(idx);
      openIndices.sort((a, b) => a - b);
      for (const idx of openIndices) frames.push(evt('content_block_stop', { index: idx }));
      // Carry the real input usage the client would otherwise never see (M2 red-team). Anthropic
      // input_tokens EXCLUDES cache-read, which is surfaced separately.
      const inputTokens = Math.max(0, promptTokens - cachedTokens);
      frames.push(
        evt('message_delta', {
          delta: {
            stop_reason: FINISH_TO_STOP[finish ?? 'stop'] ?? 'end_turn',
            stop_sequence: null,
          },
          usage: {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            ...(cachedTokens > 0 ? { cache_read_input_tokens: cachedTokens } : {}),
          },
        }),
      );
      frames.push(evt('message_stop', {}));
      return frames;
    },
  };
}
