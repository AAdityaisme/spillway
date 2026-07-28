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
 * Anthropic declared-capability catalog (Part III §5.2). Claude models: multimodal chat + tools +
 * streaming + prompt caching; 3.7/4.x add extended thinking (reasoning_effort). No native
 * logprobs/json_mode (structured output is via tool-use). Prefix-keyed; re-verify at build time.
 */
// NB: NO 'structured_output'. `structured_output` is a HARD_GATE feature (a silent drop returns a
// wrong-shaped answer the caller can't detect), and transform() does NOT translate OpenAI
// `response_format` into Anthropic's tool-use forcing — response_format is not in HANDLED, so it is
// stripped into `dropped`. Declaring the cap would pass the route.ts hard-gate and then silently drop
// the schema constraint → free-form prose against a schema-constrained parse. So the catalog matches
// reality (and the certifier's DECLARED_CAPS.anthropic, which also omits it). Claim it only once the
// transform actually forces a json-schema tool. (red-team part-3 #2)
const CLAUDE_CHAT = [
  'tools',
  'tool_choice_required',
  'parallel_tool_calls',
  'vision',
  'prompt_caching',
  'streaming',
] as const;
const ANTHROPIC_CATALOG: Record<string, Capabilities> = {
  'claude-opus-4': chatCaps([...CLAUDE_CHAT, 'reasoning_effort'], {
    inputModalities: ['text', 'image'],
    maxContextTokens: 200_000,
  }),
  'claude-sonnet-4': chatCaps([...CLAUDE_CHAT, 'reasoning_effort'], {
    inputModalities: ['text', 'image'],
    maxContextTokens: 200_000,
  }),
  'claude-haiku-4': chatCaps([...CLAUDE_CHAT, 'reasoning_effort'], {
    inputModalities: ['text', 'image'],
    maxContextTokens: 200_000,
  }),
  'claude-3-7': chatCaps([...CLAUDE_CHAT, 'reasoning_effort'], {
    inputModalities: ['text', 'image'],
    maxContextTokens: 200_000,
  }),
  'claude-3-5': chatCaps([...CLAUDE_CHAT], {
    inputModalities: ['text', 'image'],
    maxContextTokens: 200_000,
  }),
};

function anthropicCapabilitiesFor(model: string): Capabilities {
  return lookupCapabilities(ANTHROPIC_CATALOG, model);
}

/**
 * Anthropic adapter (06-providers §2). Dispatches to Anthropic's native Messages API and
 * translates an OpenAI-chat-completions inbound body into an Anthropic request. Three landmines
 * this file is built around — get any one wrong and cost is silently misbilled:
 *
 *  1. AUTH (§2.1): the header is `x-api-key`, NOT `Authorization: Bearer`. #1 integration bug.
 *  2. USAGE (§2.5 / Appendix D §2): Anthropic `input_tokens` is the RAW post-cache-breakpoint
 *     portion — it ALREADY EXCLUDES cache read/write tokens. So `ParsedUsage.input_tokens =
 *     usage.input_tokens` verbatim (the exact OPPOSITE of openai.ts, where prompt_tokens
 *     INCLUDES cached and must be subtracted). Never sum cache components into input_tokens —
 *     the cost engine prices each component separately; summing double-bills.
 *  3. STREAMING (§2.4): `message_start` carries the input-side usage; `message_delta.usage
 *     .output_tokens` is CUMULATIVE (overwrite, never add); `message_stop` ends the stream.
 */

export const ANTHROPIC_UPSTREAM_URL = 'https://api.anthropic.com/v1/messages';
export const ANTHROPIC_VERSION = '2023-06-01';
/** Anthropic REQUIRES max_tokens. When the client omits it we inject a floor so the upstream
 *  never 400s on a gateway-caused omission (§2.2a / conformance checklist). The richer
 *  virtual_key/model-catalog fallback lives upstream in VALIDATE; 4096 is the last-resort floor. */
const DEFAULT_MAX_TOKENS = 4096;

/** Floor at 0, cap below int32 max — a hostile/buggy usage value must not overflow the integer
 *  requests columns and abort the whole reconcile tx (parity with openai.ts clampTok, ADR-032). */
const clampTok = (n: number | undefined): number =>
  Math.max(0, Math.min(Math.trunc(n ?? 0), 2_000_000_000));

/** Anthropic usage shape (non-streaming response + streaming message_start/message_delta).
 *  `cache_creation` is the newer explicit 5m/1h split object; `cache_creation_input_tokens` is
 *  the legacy scalar (TTL then inferred from the request's cache_control blocks — see §2.5). */
interface RawAnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
  server_tool_use?: { web_search_requests?: number };
}

type CacheType = '5m' | '1h';

/** Params handled explicitly in transform() — not re-emitted, not strip-recorded. Everything
 *  NOT in here (n, frequency_penalty, presence_penalty, logprobs, seed, response_format, …) is
 *  stripped + recorded in `dropped` so a forward never 400s on an unsupported OpenAI field. */
const HANDLED = new Set([
  'model',
  'messages',
  'system',
  'max_tokens',
  'max_completion_tokens',
  'temperature',
  'top_p',
  'top_k',
  'stop',
  'tools',
  'tool_choice',
  'metadata',
  'stream',
  'original_max_tokens', // injected by VALIDATE for reconcile; never forwarded (parity w/ openai.ts)
]);

/** First finite, strictly-positive integer among the candidates (max_tokens normalization). */
function firstPositiveInt(...vals: unknown[]): number | undefined {
  for (const v of vals) {
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return Math.trunc(v);
  }
  return undefined;
}

/** OpenAI tool_calls carry `function.arguments` as a JSON STRING; Anthropic tool_use wants an
 *  OBJECT `input`. Parse defensively — a malformed arguments string must not throw mid-transform;
 *  fall back to `{}` (a valid empty tool input) rather than aborting the request. */
function toolInputFromArguments(args: unknown): unknown {
  if (args !== null && typeof args === 'object') return args; // already object-shaped
  if (typeof args === 'string') {
    try {
      const parsed: unknown = JSON.parse(args);
      return parsed !== null && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

/** OpenAI `image_url.url` → Anthropic image source. A `data:<mt>;base64,<data>` URI becomes a
 *  base64 source (Anthropic rejects data: URIs as `type:'url'`); a plain http(s) URL stays a url
 *  source. `image_url.detail` has no Anthropic equivalent and is dropped by the caller. */
function toImageSource(url: string): Record<string, unknown> {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(url);
  if (m) return { type: 'base64', media_type: m[1], data: m[2] };
  return { type: 'url', url };
}

/** Map an OpenAI content-part array to Anthropic content blocks. Text passes through; image_url
 *  becomes an image block (detail stripped+recorded); anything already Anthropic-shaped passes
 *  through untouched so a native block a client happened to send is not mangled. */
function mapContentBlocks(content: unknown[], dropped: Set<string>): unknown[] {
  const out: unknown[] = [];
  for (const part of content) {
    const p = part as { type?: unknown; text?: unknown; image_url?: unknown };
    if (p.type === 'text' && typeof p.text === 'string') {
      out.push({ type: 'text', text: p.text });
      continue;
    }
    if (p.type === 'image_url' || p.image_url !== undefined) {
      const iu = p.image_url as { url?: unknown; detail?: unknown } | undefined;
      if (typeof iu?.url === 'string') {
        out.push({ type: 'image', source: toImageSource(iu.url) });
        if (iu.detail !== undefined) dropped.add('image_url.detail'); // no Anthropic equivalent
      }
      continue;
    }
    out.push(part); // native/unknown block → pass through
  }
  return out;
}

/** OpenAI tools (`{type:'function',function:{name,description,parameters}}`) → Anthropic tools
 *  (`{name,description,input_schema}`). Already-Anthropic tools pass through. */
function mapTools(tools: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const t of tools) {
    const tool = t as {
      type?: unknown;
      function?: { name?: unknown; description?: unknown; parameters?: unknown };
      name?: unknown;
      input_schema?: unknown;
    };
    if (tool.type === 'function' && tool.function && typeof tool.function.name === 'string') {
      const mapped: Record<string, unknown> = {
        name: tool.function.name,
        input_schema: tool.function.parameters ?? { type: 'object', properties: {} },
      };
      if (typeof tool.function.description === 'string')
        mapped.description = tool.function.description;
      out.push(mapped);
    } else if (typeof tool.name === 'string' && tool.input_schema !== undefined) {
      out.push(tool); // already Anthropic-shaped
    }
    // else: unrecognized tool shape → skip
  }
  return out;
}

/** OpenAI tool_choice → Anthropic tool_choice. `none` has NO Anthropic equivalent ("never call
 *  a tool"): map to `{type:'auto'}` (closest analog) and flag `recorded` so transform() records
 *  `tool_choice` in `dropped` + the pipeline can WARN (§2.2a contract note). */
function mapToolChoice(tc: unknown): { value?: unknown; recorded?: boolean } {
  if (tc === 'auto') return { value: { type: 'auto' } };
  if (tc === 'required') return { value: { type: 'any' } };
  if (tc === 'none') return { value: { type: 'auto' }, recorded: true };
  if (tc !== null && typeof tc === 'object') {
    const o = tc as { type?: unknown; function?: { name?: unknown } };
    if (o.type === 'function' && typeof o.function?.name === 'string') {
      return { value: { type: 'tool', name: o.function.name } };
    }
    if (o.type === 'auto' || o.type === 'any' || o.type === 'tool') return { value: o }; // native
  }
  return { recorded: true };
}

/** Read the max cache TTL present on the request's cache_control blocks (§2.5). Only needed as a
 *  FALLBACK when the response reports the legacy scalar `cache_creation_input_tokens` without the
 *  explicit `cache_creation` split object. Scans system, message content blocks, and tools; a 1h
 *  block anywhere wins over 5m (conservative, most-expensive-TTL per the mixed-TTL contract note). */
function extractCacheType(requestBody: unknown): CacheType | null {
  const body = requestBody as { system?: unknown; messages?: unknown; tools?: unknown } | null;
  if (!body || typeof body !== 'object') return null;

  let found: CacheType | null = null;
  const consider = (obj: unknown): void => {
    if (obj === null || typeof obj !== 'object') return;
    const cc = (obj as { cache_control?: unknown }).cache_control as
      | { type?: unknown; ttl?: unknown }
      | undefined;
    if (cc && typeof cc === 'object') {
      // Anthropic ephemeral blocks carry ttl '5m' | '1h'; the bible also allows type 'persistent'=1h.
      const is1h = cc.ttl === '1h' || cc.type === 'persistent';
      if (is1h) found = '1h';
      else if (found === null && (cc.type === 'ephemeral' || cc.ttl === '5m')) found = '5m';
    }
  };
  const scanBlocks = (v: unknown): void => {
    if (Array.isArray(v)) for (const b of v) consider(b);
    else consider(v);
  };

  scanBlocks(body.system);
  if (Array.isArray(body.messages)) {
    for (const m of body.messages) {
      consider(m);
      scanBlocks((m as { content?: unknown })?.content);
    }
  }
  scanBlocks(body.tools);
  return found;
}

/** Split cache-write tokens into 5m/1h buckets + derive cache_type. Prefers the explicit
 *  `cache_creation` object (self-describing, no request scan needed); falls back to the legacy
 *  scalar + request-side TTL inference. Defaults to 5m (Anthropic's default ephemeral TTL) when a
 *  scalar write is reported but no cache_control block is found on the request. */
function computeCacheWrites(
  u: RawAnthropicUsage,
  requestBody: unknown,
): { write5m: number; write1h: number; cacheType: CacheType | null } {
  const cc = u.cache_creation;
  if (
    cc &&
    (cc.ephemeral_5m_input_tokens !== undefined || cc.ephemeral_1h_input_tokens !== undefined)
  ) {
    const write5m = clampTok(cc.ephemeral_5m_input_tokens);
    const write1h = clampTok(cc.ephemeral_1h_input_tokens);
    return { write5m, write1h, cacheType: write1h > 0 ? '1h' : write5m > 0 ? '5m' : null };
  }
  const scalar = clampTok(u.cache_creation_input_tokens);
  if (scalar > 0) {
    const ttl = extractCacheType(requestBody) ?? '5m';
    return ttl === '1h'
      ? { write5m: 0, write1h: scalar, cacheType: '1h' }
      : { write5m: scalar, write1h: 0, cacheType: '5m' };
  }
  return { write5m: 0, write1h: 0, cacheType: null };
}

/**
 * Anthropic usage → canonical ParsedUsage (§2.5 / §6). SHARED by parseBody (non-stream) and the
 * stream parser's real-usage path so the two cost paths cannot drift. Returns null on absent or
 * all-zero usage (the caller then estimates).
 *
 * CRITICAL: `input_tokens = usage.input_tokens` VERBATIM — it is already the full-rate portion
 * (post-cache-breakpoint). Do NOT subtract cache tokens (that's the OpenAI mapping); do NOT add
 * them (that double-bills). Cache read/write go to their own fields.
 */
function mapAnthropicUsage(
  u: RawAnthropicUsage | null | undefined,
  requestBody: unknown,
): ParsedUsage | null {
  if (!u) return null;
  const input = clampTok(u.input_tokens); // ALREADY full-rate — no cache subtraction (opposite of openai)
  const output = clampTok(u.output_tokens);
  const cachedRead = clampTok(u.cache_read_input_tokens);
  const { write5m, write1h, cacheType } = computeCacheWrites(u, requestBody);
  if (input + output + cachedRead + write5m + write1h === 0) return null; // floored → sign-cancel can't fake zero
  return {
    input_tokens: input,
    output_tokens: output,
    cached_read_tokens: cachedRead,
    cache_write_5m_tokens: write5m,
    cache_write_1h_tokens: write1h,
    cache_type: cacheType,
    reasoning_tokens: 0, // extended-thinking tokens are hidden inside output_tokens; not isolable (§2.5)
    usage_estimated: false,
  };
}

/**
 * Streaming usage extractor for Anthropic SSE (§2.4). Anthropic reports usage NATIVELY — the
 * input side arrives on `message_start`, the cumulative output on `message_delta`, and
 * `message_stop` ends the stream (there is no include_usage flag to inject, unlike OpenAI).
 *
 * The event type lives in the JSON payload's `.type` field, so the tee's `event: <type>` line is
 * not needed — we switch on the parsed `type`. getUsage returns REAL usage on a clean finish
 * (message_start + message_stop, no error) else a best-effort ESTIMATE (usage_estimated:true) —
 * never null, so a stream always meters a row.
 */
class AnthropicStreamParser implements StreamParser {
  private startUsage: RawAnthropicUsage | null = null;
  private deltaOutput: number | null = null; // cumulative from message_delta — OVERWRITE, never add
  private outputChars = 0; // running counter for the estimate fallback (bounded memory on long streams)
  private completed = false; // message_stop seen → real usage is final
  private aborted = false; // error event seen → truncated, force estimate

  processEvent(event: SseEvent): void {
    if (event.data === '[DONE]') return; // not an Anthropic terminator; tolerate a stray one
    let ev: {
      type?: string;
      message?: { usage?: RawAnthropicUsage };
      usage?: RawAnthropicUsage;
      delta?: { text?: unknown; partial_json?: unknown };
    };
    try {
      ev = JSON.parse(event.data) as typeof ev;
    } catch {
      return; // a malformed SSE line is skipped, not fatal
    }
    switch (ev.type) {
      case 'message_start':
        if (ev.message?.usage) this.startUsage = ev.message.usage;
        break;
      case 'content_block_delta': {
        // Count text_delta AND input_json_delta (tool-call args) so a tool-only stream truncated
        // before message_delta still estimates non-zero output — parity with openai's tool-call
        // under-bill guard (red-team ADR-034).
        const d = ev.delta;
        if (typeof d?.text === 'string') this.outputChars += d.text.length;
        if (typeof d?.partial_json === 'string') this.outputChars += d.partial_json.length;
        break;
      }
      case 'message_delta':
        // output_tokens here is CUMULATIVE — overwrite, do NOT accumulate (§2.4 / Appendix D §2).
        if (typeof ev.usage?.output_tokens === 'number')
          this.deltaOutput = clampTok(ev.usage.output_tokens);
        break;
      case 'message_stop':
        this.completed = true;
        break;
      case 'error':
        this.aborted = true; // mid-stream overloaded_error etc. → treat as abort
        break;
      default:
        break;
    }
  }

  getUsage(requestBody: unknown, model: string): ParsedUsage {
    // Real usage: a clean finish (message_stop, no error) with the input side from message_start.
    // Merge the cumulative output from message_delta over message_start's initial value.
    if (this.completed && !this.aborted && this.startUsage) {
      const merged: RawAnthropicUsage = {
        ...this.startUsage,
        output_tokens: this.deltaOutput ?? this.startUsage.output_tokens,
      };
      const real = mapAnthropicUsage(merged, requestBody);
      if (real) return real;
    }
    // Truncated / aborted / no message_start → estimate, but keep any REAL values we captured
    // ("nothing lost": prefer captured input/output/cache over re-estimation; §2.4c). Flag it.
    const cacheParts = this.startUsage
      ? computeCacheWrites(this.startUsage, requestBody)
      : { write5m: 0, write1h: 0, cacheType: null as CacheType | null };
    return {
      input_tokens: this.startUsage
        ? clampTok(this.startUsage.input_tokens)
        : estimateInputTokens(requestBody, model),
      output_tokens: this.deltaOutput ?? estimateTokensFromChars(this.outputChars, model),
      cached_read_tokens: this.startUsage ? clampTok(this.startUsage.cache_read_input_tokens) : 0,
      cache_write_5m_tokens: cacheParts.write5m,
      cache_write_1h_tokens: cacheParts.write1h,
      cache_type: cacheParts.cacheType,
      reasoning_tokens: 0,
      usage_estimated: true,
    };
  }
}

/** Anthropic 400 invalid_request_error whose message signals an oversized context/token limit →
 *  advance the context_window typed chain (§2.6 / 15 §7.1). Anthropic has no machine code for
 *  this; classify off the human message ("prompt is too long: N tokens > M maximum"). */
function isContextError(msg: string): boolean {
  return (
    msg.includes('too long') ||
    msg.includes('context length') ||
    msg.includes('context window') ||
    (msg.includes('token') && (msg.includes('maximum') || msg.includes('exceed')))
  );
}

/** Anthropic content-safety refusal surfaced as a 400 → advance the content_policy typed chain. */
function isContentPolicyError(msg: string): boolean {
  return (
    msg.includes('content policy') ||
    msg.includes('safety') ||
    msg.includes('blocked') ||
    msg.includes('violat')
  );
}

export const anthropicAdapter: Adapter = {
  provider: 'anthropic',

  transform(body, candidate: Candidate, decryptedKey, opts): TransformResult {
    const src = body as Record<string, unknown>;
    const out: Record<string, unknown> = { model: candidate.model }; // post-route model; client model ignored
    const dropped = new Set<string>();

    // --- system extraction + message mapping (OpenAI chat shape → Anthropic Messages) ---
    const srcMsgs = Array.isArray(src.messages) ? (src.messages as unknown[]) : [];
    const systemParts: string[] = [];
    if (typeof src.system === 'string' && src.system.length > 0) systemParts.push(src.system);
    else if ('system' in src && typeof src.system !== 'string') dropped.add('system');

    const anthMsgs: unknown[] = [];
    for (const m of srcMsgs) {
      const msg = m as {
        role?: unknown;
        content?: unknown;
        tool_calls?: unknown;
        tool_call_id?: unknown;
      };
      if (msg.role === 'system') {
        // All system messages hoist to the top-level `system` string, concatenated in order (§2.2a).
        if (typeof msg.content === 'string') systemParts.push(msg.content);
        else if (Array.isArray(msg.content)) {
          for (const part of msg.content) {
            const p = part as { text?: unknown };
            if (typeof p.text === 'string') systemParts.push(p.text);
          }
        }
        continue;
      }
      if (msg.role === 'tool') {
        // OpenAI tool result → Anthropic user turn with a tool_result block (tool_call_id→tool_use_id).
        anthMsgs.push({
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: msg.tool_call_id, content: msg.content }],
        });
        continue;
      }
      if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
        const blocks: unknown[] = [];
        if (typeof msg.content === 'string' && msg.content.length > 0) {
          blocks.push({ type: 'text', text: msg.content });
        } else if (Array.isArray(msg.content)) {
          blocks.push(...mapContentBlocks(msg.content, dropped));
        }
        for (const tc of msg.tool_calls) {
          const call = tc as { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
          blocks.push({
            type: 'tool_use',
            id: call.id,
            name: call.function?.name,
            input: toolInputFromArguments(call.function?.arguments),
          });
        }
        anthMsgs.push({ role: 'assistant', content: blocks });
        continue;
      }
      // Plain user/assistant turn.
      if (typeof msg.content === 'string') anthMsgs.push({ role: msg.role, content: msg.content });
      else if (Array.isArray(msg.content))
        anthMsgs.push({ role: msg.role, content: mapContentBlocks(msg.content, dropped) });
      else anthMsgs.push({ role: msg.role, content: msg.content }); // native/unknown → pass through
    }
    if (systemParts.length > 0) out.system = systemParts.join('\n\n');
    out.messages = anthMsgs;

    // --- max_tokens: REQUIRED by Anthropic; inject a floor if the client omitted it (§2.2a) ---
    out.max_tokens =
      firstPositiveInt(src.max_tokens, src.max_completion_tokens) ?? DEFAULT_MAX_TOKENS;

    // --- sampling params (Anthropic ranges differ from OpenAI) ---
    if ('temperature' in src) {
      const t = src.temperature;
      // Anthropic temperature is 0–1 (NOT OpenAI's 0–2). Number.isFinite guards NaN/Infinity→null 400.
      if (typeof t === 'number' && Number.isFinite(t) && t >= 0 && t <= 1) out.temperature = t;
      else dropped.add('temperature');
    }
    if ('top_p' in src) {
      const v = src.top_p;
      if (typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 1) out.top_p = v;
      else dropped.add('top_p');
    }
    if ('top_k' in src) {
      const v = src.top_k;
      // Anthropic-only sampling param (OpenAI has no equivalent) — a client may pass it intentionally.
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out.top_k = Math.trunc(v);
      else dropped.add('top_k');
    }

    // --- stop → stop_sequences (rename; wrap a bare string in an array) ---
    if ('stop' in src) {
      const s = src.stop;
      if (typeof s === 'string') out.stop_sequences = [s];
      else if (Array.isArray(s)) out.stop_sequences = s;
      else dropped.add('stop');
    }

    // --- tools + tool_choice ---
    if ('tools' in src) {
      if (Array.isArray(src.tools)) {
        const mapped = mapTools(src.tools);
        if (mapped.length > 0) out.tools = mapped;
      } else dropped.add('tools');
    }
    if ('tool_choice' in src) {
      const tc = mapToolChoice(src.tool_choice);
      if (tc.value !== undefined) out.tool_choice = tc.value;
      if (tc.recorded) dropped.add('tool_choice'); // 'none'/unmappable → recorded (+WARN upstream)
    }

    // --- metadata: Anthropic only accepts metadata.user_id; strip+record other tags ---
    if ('metadata' in src) {
      const md = src.metadata;
      if (md !== null && typeof md === 'object') {
        const rec = md as Record<string, unknown>;
        if (typeof rec.user_id === 'string') out.metadata = { user_id: rec.user_id };
        for (const k of Object.keys(rec)) if (k !== 'user_id') dropped.add(`metadata.${k}`);
      } else {
        dropped.add('metadata');
      }
    }

    // --- stream: honor the client's intent. Anthropic emits usage natively in message_start/
    // message_delta, so there is NOTHING to inject when capturing usage (contrast openai's
    // stream_options.include_usage). opts.injectUsage is intentionally a no-op here (§2.4). ---
    out.stream = src.stream === true;
    void opts.injectUsage;

    // --- strip-and-record everything unsupported/unrecognized (n, frequency_penalty,
    // presence_penalty, logprobs, top_logprobs, seed, response_format, stream_options, …) ---
    for (const k of Object.keys(src)) {
      if (!HANDLED.has(k)) dropped.add(k);
    }

    return {
      url: ANTHROPIC_UPSTREAM_URL,
      method: 'POST',
      headers: {
        'x-api-key': decryptedKey, // NOT `Authorization: Bearer` — the #1 Anthropic integration bug (§2.1)
        'anthropic-version': ANTHROPIC_VERSION,
        'Content-Type': 'application/json',
      },
      body: out,
      dropped: [...dropped],
    };
  },

  parseBody(responseBody, _candidate, requestBody): ParsedUsage | null {
    // Shared mapper — input_tokens is RAW full-rate (no cache subtraction); cache write TTL split
    // uses the response's cache_creation object, or requestBody's cache_control as a fallback.
    return mapAnthropicUsage(
      (responseBody as { usage?: RawAnthropicUsage } | null)?.usage,
      requestBody,
    );
  },

  createStreamParser(): StreamParser {
    return new AnthropicStreamParser();
  },

  // Status-driven mapping (Bifrost pattern, §2.6). retryAfterMs is null here: mapError only sees
  // status + body, and Anthropic's retry-after arrives as an HTTP HEADER the executor reads — not
  // in the body. Body is advisory (error.type/message) and may be null/HTML → never forwarded raw.
  mapError(httpStatus, body): MappedError {
    const rawBody = body !== null && typeof body === 'object' ? body : null;
    const errObj =
      rawBody && typeof (rawBody as { error?: unknown }).error === 'object'
        ? ((rawBody as { error: Record<string, unknown> }).error ?? {})
        : {};
    const errMsg = typeof errObj.message === 'string' ? errObj.message.toLowerCase() : '';
    const base = { rawBody, retryAfterMs: null as number | null, httpStatus };

    switch (httpStatus) {
      case 429:
        // rate_limit_error: key is throttled but the provider has headroom. Executor honors the
        // retry-after header (+jitter), then advances (§2.6). Distinct from 529 — never conflate.
        return {
          ...base,
          spillwayCode: 'provider_rate_limited',
          isRetryable: true,
          isClientError: false,
          errorClass: 'rate_limit',
        };
      case 529:
        // overloaded_error: system-wide capacity, NO retry-after window → capped exponential
        // backoff (1s→30s, 4 attempts). The task calls this class 'transient'; that member is not
        // in the ErrorClass union, so it maps to 'server' — the exp-backoff + health-counted class.
        return {
          ...base,
          spillwayCode: 'provider_overloaded',
          isRetryable: true,
          isClientError: false,
          errorClass: 'server',
        };
      case 503:
        return {
          ...base,
          spillwayCode: 'provider_unavailable',
          isRetryable: true,
          isClientError: false,
          errorClass: 'server',
        };
      case 500:
        // api_error: a genuine server fault (NOT the overload signal — that's 529). isRetryable:true so
        // the dispatch chain FAILS OVER to the next candidate — the executor keys canAdvance off
        // isRetryable, not errorClass, so isRetryable:false silently dropped a transient Anthropic 500
        // instead of trying the openai fallback (parity with 503 above + openai.ts's 5xx arm; red-team
        // audit F2). There is no same-key retry loop — advance means the next candidate, not a re-hit.
        return {
          ...base,
          spillwayCode: 'provider_error',
          isRetryable: true,
          isClientError: false,
          errorClass: 'server',
        };
      case 400: {
        // invalid_request_error. Sub-classify off the human message so an oversized-context 400
        // advances the context_window typed chain and a safety refusal advances content_policy
        // (15 §7.1); a bare validation 400 is a client error surfaced immediately.
        const errorClass = isContextError(errMsg)
          ? 'context_window'
          : isContentPolicyError(errMsg)
            ? 'content_policy'
            : 'client';
        return {
          ...base,
          spillwayCode: 'invalid_request',
          isRetryable: errorClass !== 'client', // typed classes advance; a bare 400 does not
          isClientError: errorClass === 'client',
          errorClass,
        };
      }
      case 401:
      case 403:
        // authentication_error / permission_error: key invalid → alert, never retry (§2.6).
        return {
          ...base,
          spillwayCode: 'provider_auth_error',
          isRetryable: false,
          isClientError: false,
          errorClass: 'auth',
        };
      case 413:
        // request_too_large: surface to client (§2.6). errorClass context_window lets a
        // smaller-context typed chain serve it if one is configured; isClientError surfaces otherwise.
        return {
          ...base,
          spillwayCode: 'request_too_large',
          isRetryable: false,
          isClientError: true,
          errorClass: 'context_window',
        };
      case 404:
        // not_found_error (missing model). A 4xx → excluded from circuit-breaker health via
        // errorClass 'client' (healthKindFor → null). isClientError:false so the chain may try
        // another candidate that hosts the model.
        return {
          ...base,
          spillwayCode: 'model_not_found',
          isRetryable: false,
          isClientError: false,
          errorClass: 'client',
        };
      default:
        if (httpStatus >= 400 && httpStatus < 500) {
          // Unrecognized 4xx (422, …) → surface immediately as a client error; never fall through
          // to the 5xx arm, which would mislabel it a provider failure and end in a bogus 502.
          return {
            ...base,
            spillwayCode: 'invalid_request',
            isRetryable: false,
            isClientError: true,
            errorClass: 'client',
          };
        }
        // 502/504 and other 5xx — provider unhealthy; advance the chain + count for health.
        return {
          ...base,
          spillwayCode: 'provider_unavailable',
          isRetryable: true,
          isClientError: false,
          errorClass: 'server',
        };
    }
  },

  capabilitiesFor: anthropicCapabilitiesFor,
  supports: makeSupports(anthropicCapabilitiesFor),
};
