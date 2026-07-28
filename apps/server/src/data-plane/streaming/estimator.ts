/**
 * Usage estimator (05-gateway-core §3/§7). The fallback when a streamed response carries no
 * usage chunk — an interrupted/truncated stream, or an openai_compat/Gemini provider that
 * ignores stream_options.include_usage. Rows produced this way are flagged usage_estimated=true
 * and surfaced separately in statements (07 §6); they are production-NORMAL, not an error.
 *
 * Method: chars/4 × a per-model correction factor. Deliberately cheap and dependency-free
 * (no tiktoken) — an estimate need not be exact, only bounded and non-zero. NEVER throws:
 * a malformed body yields 0, mirroring reconcile's toCanonical(null) zero-usage path.
 */
const CHARS_PER_TOKEN = 4;

/** Flat per-image token floor (OpenAI low-detail tile average) — a vision request carries no text, so
 *  a text-only estimate would floor a real image request to $0 on disconnect (red-team post-B9). */
const IMAGE_TOKEN_FLOOR = 765;

/** Exact-model corrections on the chars/4 baseline — for models measured to deviate. */
export const MODEL_TOKEN_FACTORS: Record<string, number> = {};

/** Family corrections by longest-matching prefix, so a new model release inherits its family's
 *  factor instead of silently regressing to 1.0 (the failure mode of an exact-match-only table). */
export const FAMILY_TOKEN_FACTORS: ReadonlyArray<readonly [prefix: string, factor: number]> = [
  ['gpt-', 1.0],
  ['o1', 1.0],
  ['o3', 1.0],
  ['claude-', 1.0],
  ['gemini-', 1.0],
];

export function tokenFactorFor(model: string): number {
  const exact = MODEL_TOKEN_FACTORS[model];
  if (exact !== undefined) return exact;
  let best: number | undefined;
  let bestLen = -1;
  for (const [prefix, factor] of FAMILY_TOKEN_FACTORS) {
    if (model.startsWith(prefix) && prefix.length > bestLen) {
      best = factor;
      bestLen = prefix.length;
    }
  }
  return best ?? 1.0;
}

function charsToTokens(chars: number, model: string): number {
  const factor = tokenFactorFor(model);
  // Same [0, 2e9] bound as the real-usage clampTok: an unbounded stream must not produce a
  // >int32 estimate that overflows the requests token columns → tx abort → silent spend loss
  // (red-team ADR-034 L12; parity with openai.ts clampTok).
  return Math.max(0, Math.min(Math.ceil((chars / CHARS_PER_TOKEN) * factor), 2_000_000_000));
}

/** Estimate output tokens from the assistant text the tee accumulated across delta chunks. */
export function estimateTokensFromText(text: string, model: string): number {
  if (typeof text !== 'string' || text.length === 0) return 0;
  return charsToTokens(text.length, model);
}

/** Estimate from a running char COUNT — the stream parser tracks a counter, not the full text,
 *  so a multi-megabyte stream can't grow unbounded memory (OOM guard). */
export function estimateTokensFromChars(chars: number, model: string): number {
  return charsToTokens(chars, model);
}

/**
 * Estimate input tokens from the request body: every message's string content (+ the `text`
 * of array content parts), a top-level `system` string, and the `tools` schema. Mirrors
 * VALIDATE's size-guard accounting (messages + system + tools), so a tool-heavy request that
 * passed the input cap estimates consistently instead of undercounting (red-team ADR-034).
 */
export function estimateInputTokens(requestBody: unknown, model: string): number {
  const body = requestBody as {
    messages?: unknown;
    system?: unknown;
    tools?: unknown;
    input?: unknown;
  } | null;
  if (!body || typeof body !== 'object') return 0;

  let chars = 0;
  let directTokens = 0;
  // /v1/embeddings bodies carry `input` (string | array) instead of `messages` — without this
  // branch every embeddings request estimated 0 tokens: free under TPM rate limits, $0 budget
  // reservation, and an unmetered input-size guard (task #9). Token-ARRAY inputs (number[] /
  // number[][]) are already tokens — count elements 1:1; JSON-length/4 undercounted them ~2×
  // (each token ≈2 JSON chars), halving what TPM caps and reservations saw (red-team task #9).
  if (typeof body.input === 'string') chars += body.input.length;
  else if (Array.isArray(body.input)) {
    for (const el of body.input) {
      if (typeof el === 'number') directTokens += 1;
      else if (typeof el === 'string') chars += el.length;
      else if (Array.isArray(el)) directTokens += el.length; // number[][] batch row
    }
  }
  let imageTokens = 0;
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (const msg of messages) {
    const content = (msg as { content?: unknown })?.content;
    if (typeof content === 'string') {
      chars += content.length;
    } else if (Array.isArray(content)) {
      for (const part of content) {
        const p = part as { type?: unknown; text?: unknown; image_url?: unknown };
        if (typeof p.text === 'string') chars += p.text.length;
        // Vision parts carry no text — charge a flat floor so an image request doesn't estimate $0.
        if (p.type === 'image_url' || p.image_url !== undefined) imageTokens += IMAGE_TOKEN_FLOOR;
      }
    }
  }
  if (typeof body.system === 'string') chars += body.system.length;
  if (body.tools) {
    try {
      chars += JSON.stringify(body.tools).length;
    } catch {
      /* non-serializable tools → ignore */
    }
  }

  return charsToTokens(chars, model) + imageTokens + directTokens;
}
