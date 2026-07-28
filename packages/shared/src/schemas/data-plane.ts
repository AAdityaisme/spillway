import { z } from 'zod';

/**
 * Data-plane request contract (04-api-contracts §1). Deliberately PERMISSIVE: it
 * enforces only the structural minimum (a model + a non-empty messages array with
 * roles) and `.passthrough()`es everything else, because the openai adapter does
 * strip-and-record on unknown/out-of-range params (06 §0.2) — zod must NOT reject a
 * valid OpenAI body just because it carries a param we don't explicitly model.
 * `stream`/`max_tokens` are typed because VALIDATE reads them (reject stream, clamp).
 */
export const ChatCompletionsRequest = z
  .object({
    model: z.string().min(1),
    messages: z.array(z.object({ role: z.string() }).passthrough()).min(1),
    stream: z.boolean().optional(),
    max_tokens: z.number().int().positive().optional(),
    max_completion_tokens: z.number().int().positive().optional(),
    // metadata is a governance-matching input (guardrails + routing rules compare metadata[k] === v
    // where v is always a STRING). Typing it as string→string closes the evasion where a client sends
    // `{"env":["prod"]}` so `['prod'] === 'prod'` is false and a deny policy is silently skipped
    // (expanded-audit HIGH). Matches OpenAI's own metadata contract (string→string). Bounded so it
    // can't bloat the row / audit log.
    metadata: z
      .record(z.string().max(64), z.string().max(1024))
      .refine((m) => Object.keys(m).length <= 32, { message: 'too many metadata keys (max 32)' })
      .optional(),
  })
  .passthrough();

export type ChatCompletionsRequestType = z.infer<typeof ChatCompletionsRequest>;

/**
 * Anthropic Messages request contract (04-api-contracts §2 / 06 §2). The native shape accepted by
 * `POST /v1/messages`. Like the OpenAI contract it is deliberately PERMISSIVE — it enforces only the
 * structural minimum (a model + a non-empty messages array with roles + the Anthropic-required
 * `max_tokens`) and `.passthrough()`es everything else (`system`, `tools`, `tool_choice`,
 * `cache_control`, `thinking`, `metadata`, sampling params) so a valid Anthropic body is never
 * rejected for carrying a field we don't explicitly model.
 */
export const AnthropicMessagesRequest = z
  .object({
    model: z.string().min(1),
    messages: z.array(z.object({ role: z.string() }).passthrough()).min(1),
    max_tokens: z.number().int().positive(),
    stream: z.boolean().optional(),
  })
  .passthrough();

export type AnthropicMessagesRequestType = z.infer<typeof AnthropicMessagesRequest>;

/**
 * Embeddings request contract (task #9 — /v1/embeddings). Same permissive philosophy: structural
 * minimum only (model + non-empty input; OpenAI accepts a string, string[], or token arrays) and
 * `.passthrough()` for the rest (encoding_format, dimensions, user) — the adapter strips-and-records
 * unknown params, zod must not reject a valid OpenAI body.
 */
export const EmbeddingsRequest = z
  .object({
    model: z.string().min(1),
    input: z.union([z.string().min(1), z.array(z.unknown()).min(1)]),
  })
  .passthrough();

export type EmbeddingsRequestType = z.infer<typeof EmbeddingsRequest>;
